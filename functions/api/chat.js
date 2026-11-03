
const PROJECT_ID = "qr-rental-system-6df07";
const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

const FIRESTORE_BASE =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}` +
  "/databases/(default)/documents";

const PUBLIC_KEYS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/" +
  "securetoken@system.gserviceaccount.com";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

// ========================================
// Firebase 로그인 인증
// ========================================

function decodeBase64Url(value) {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  return Uint8Array.from(
    atob(base64.padEnd(
      Math.ceil(base64.length / 4) * 4,
      "="
    )),
    char => char.charCodeAt(0)
  );
}

async function verifyFirebaseToken(token) {
  const parts = token.split(".");

  if (parts.length !== 3) {
    throw new Error("INVALID_TOKEN");
  }

  const header = JSON.parse(
    new TextDecoder().decode(
      decodeBase64Url(parts[0])
    )
  );

  const payload = JSON.parse(
    new TextDecoder().decode(
      decodeBase64Url(parts[1])
    )
  );

  const now = Math.floor(Date.now() / 1000);

  if (
    header.alg !== "RS256" ||
    typeof header.kid !== "string" ||
    payload.aud !== PROJECT_ID ||
    payload.iss !==
      `https://securetoken.google.com/${PROJECT_ID}` ||
    typeof payload.sub !== "string" ||
    !payload.sub ||
    typeof payload.exp !== "number" ||
    payload.exp <= now ||
    typeof payload.iat !== "number" ||
    payload.iat > now ||
    typeof payload.auth_time !== "number" ||
    payload.auth_time > now
  ) {
    throw new Error("INVALID_TOKEN");
  }

  const response = await fetch(PUBLIC_KEYS_URL);

  if (!response.ok) {
    throw new Error("KEY_FETCH_FAILED");
  }

  const keySet = await response.json();

  const publicKey = keySet.keys?.find(
    key => key.kid === header.kid
  );

  if (!publicKey) {
    throw new Error("INVALID_TOKEN");
  }

  const key = await crypto.subtle.importKey(
    "jwk",
    publicKey,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256"
    },
    false,
    ["verify"]
  );

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    decodeBase64Url(parts[2]),
    new TextEncoder().encode(
      parts[0] + "." + parts[1]
    )
  );

  if (!valid) {
    throw new Error("INVALID_TOKEN");
  }

  return payload;
}

// ========================================
// Firebase 직원 승인 확인
// ========================================

async function readDocument(path, token) {
  const response = await fetch(
    `${FIRESTORE_BASE}/${path}`,
    {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(
      `FIRESTORE_READ_${response.status}`
    );
  }

  return response.json();
}

async function hasRentalAccess(token, user) {
  const admin = await readDocument(
    `admins/${encodeURIComponent(user.sub)}`,
    token
  );

  if (
    admin?.fields?.role?.stringValue === "admin"
  ) {
    return true;
  }

  if (user.email_verified !== true) {
    return false;
  }

  const profile = await readDocument(
    `profiles/${encodeURIComponent(user.sub)}`,
    token
  );

  return (
    profile?.fields?.status?.stringValue ===
    "approved"
  );
}

// ========================================
// Firestore 물품 실시간 조회
// ========================================

function fieldString(document, name) {
  return (
    document?.fields?.[name]?.stringValue ||
    ""
  );
}

async function getEquipment(token) {
  const items = [];
  let pageToken = "";

  // 10,000개까지 정확하게 조회
  for (let page = 0; page < 20; page++) {
    const url = new URL(
      `${FIRESTORE_BASE}/equipment`
    );

    url.searchParams.set("pageSize", "500");

    if (pageToken) {
      url.searchParams.set(
        "pageToken",
        pageToken
      );
    }

    const response = await fetch(
      url.toString(),
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (!response.ok) {
      throw new Error(
        `EQUIPMENT_READ_${response.status}`
      );
    }

    const result = await response.json();

    for (const entry of result.documents || []) {
      items.push({
        name: fieldString(entry, "name"),
        category:
          fieldString(entry, "category") ||
          "미분류",
        status: fieldString(entry, "status")
      });
    }

    pageToken = result.nextPageToken || "";

    if (!pageToken) {
      return items;
    }
  }

  throw new Error("TOO_MANY_ITEMS");
}

// ========================================
// 질문 내용 분석
// ========================================

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[?!.,~]/g, "");
}

function isInventoryQuestion(question) {
  return (
    /몇\s*(대|개|건)|재고|남았|남아|대여\s*가능|빌릴\s*수|빌릴|대여\s*중|대여\s*현황|보유\s*수량|물품\s*현황|장비\s*현황/i
      .test(question) ||
    /(물품|장비|노트북|태블릿|프로젝터|카메라).*(있어|있나요|없어|알려줘|보여줘)/i
      .test(question)
  );
}

function wantsAvailableNames(question) {
  const q = normalize(question);

  const asksNames =
    /목록|이름|리스트|어떤|뭐뭐|무엇|전부|모두|보여줘|알려줘|있어|있나요/.test(q);

  const asksAvailable =
    /대여가능|빌릴수|빌릴|남아|남았|사용가능|현재가능|지금가능|재고/.test(q);

  // "지금 빌릴 수 있는 장비 전부 알려줘"
  return asksNames && asksAvailable;
}

function isAllInventoryQuestion(question) {
  const q = normalize(question);

  return (
    q.includes("전체") ||
    q.includes("모든물품") ||
    q.includes("모든장비") ||
    q.includes("전부") ||
    q.includes("모두") ||
    q.includes("총물품") ||
    q.includes("전체장비")
  );
}

function getSearchTerms(items) {
  const defaults = [
    "노트북",
    "태블릿",
    "빔프로젝터",
    "프로젝터",
    "카메라",
    "마이크",
    "모니터",
    "키보드",
    "마우스",
    "충전기",
    "삼각대",
    "촬영 장비",
    "주변기기"
  ];

  const categories = items
    .map(item => item.category)
    .filter(Boolean);

  return [...new Set([
    ...defaults,
    ...categories
  ])].sort(
    (a, b) => b.length - a.length
  );
}

function findMatchingItems(question, items) {
  const q = normalize(question);
  const terms = getSearchTerms(items);

  // "모든 노트북"처럼 특정 품목이 있는 경우
  // 전체 물품보다 품목 검색을 우선한다.
  const term = terms.find(
    value => q.includes(normalize(value))
  );

  if (term) {
    const target = normalize(term);

    return {
      keyword: term,
      items: items.filter(item =>
        normalize(item.name).includes(target) ||
        normalize(item.category).includes(target)
      )
    };
  }

  // Firebase에 등록된 물품 이름 직접 검색
  const matchedByName = items.filter(item => {
    const name = normalize(item.name);

    return (
      name.length >= 2 &&
      q.includes(name)
    );
  });

  if (matchedByName.length > 0) {
    return {
      keyword: "해당 물품",
      items: matchedByName
    };
  }

  if (isAllInventoryQuestion(question)) {
    return {
      keyword: "전체 물품",
      items
    };
  }

  // 특정 이름 없이
  // "대여 가능한 장비 알려줘"라고 질문한 경우
  const genericAvailable =
    /(물품|장비).*(대여가능|빌릴수|빌릴|남아|남았)/.test(q) ||
    /(대여가능|빌릴수|빌릴|남아|남았).*(물품|장비)/.test(q);

  if (genericAvailable) {
    return {
      keyword: "전체 물품",
      items
    };
  }

  return null;
}

// ========================================
// 재고 숫자 및 물품 이름 계산
// ========================================

function countInventory(items) {
  const available = items.filter(
    item => item.status === "available"
  ).length;

  const rented = items.filter(
    item => item.status === "rented"
  ).length;

  return {
    total: items.length,
    available,
    rented,
    other: items.length - available - rented
  };
}

function makeInventoryAnswer(
  keyword,
  items,
  showNames
) {
  const counts = countInventory(items);

  let answer =
    `📦 ${keyword} 재고 현황\n\n` +
    `전체 등록: ${counts.total}개\n` +
    `✅ 대여 가능: ${counts.available}개\n` +
    `🔒 대여 중: ${counts.rented}개`;

  if (counts.other > 0) {
    answer +=
      `\n📋 기타 상태: ${counts.other}개`;
  }

  if (counts.total === 0) {
    return answer +
      "\n\n해당 물품이 등록되어 있지 않아요.";
  }

  if (counts.available === 0) {
    return answer +
      "\n\n현재 바로 대여할 수 있는 물품은 없어요.";
  }

  if (showNames) {
    const availableItems = items
      .filter(
        item => item.status === "available"
      )
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name, "ko")
      );

    answer += "\n\n🛍️ 지금 빌릴 수 있는 물품\n";

    // 채팅창이 너무 길어지지 않도록
    // 최대 30개까지만 이름 표시
    const visible = availableItems.slice(0, 30);

    for (const item of visible) {
      answer +=
        `\n• ${item.name || "이름 없는 물품"}` +
        ` (${item.category})`;
    }

    if (availableItems.length > 30) {
      answer +=
        `\n\n외 ${availableItems.length - 30}개 물품은 ` +
        "QRental 물품 목록에서 확인할 수 있어요.";
    }
  } else {
    answer +=
      "\n\n물품 이름도 알고 싶다면 " +
      "\"대여 가능한 물품 이름 알려줘\"라고 물어봐 주세요! 😊";
  }

  return answer;
}

// ========================================
// 실제 AI 챗봇 API
// ========================================

export async function onRequestPost({
  request,
  env
}) {
  if (!env.AI) {
    return json({
      error: "Cloudflare AI 연결을 확인해 주세요."
    }, 503);
  }

  const authorization =
    request.headers.get("Authorization") || "";

  if (!authorization.startsWith("Bearer ")) {
    return json({
      error: "로그인이 필요합니다."
    }, 401);
  }

  const token = authorization.slice(7).trim();

  let user;

  try {
    user = await verifyFirebaseToken(token);
  } catch (error) {
    console.error("Firebase 인증 오류:", error);

    return json({
      error: "로그인 인증을 확인하지 못했습니다."
    }, 401);
  }

  try {
    const allowed = await hasRentalAccess(
      token,
      user
    );

    if (!allowed) {
      return json({
        error: "관리자 승인 후 이용할 수 있습니다."
      }, 403);
    }
  } catch (error) {
    console.error("권한 확인 오류:", error);

    return json({
      error: "사용자 권한을 확인하지 못했습니다."
    }, 503);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({
      error: "올바른 질문 형식이 아닙니다."
    }, 400);
  }

  const question =
    typeof body?.message === "string"
      ? body.message.trim()
      : "";

  if (
    !question ||
    question.length > 500
  ) {
    return json({
      error: "질문은 1~500자로 입력해 주세요."
    }, 400);
  }

  // ======================================
  // 실제 Firebase 재고 조회
  // ======================================

  if (isInventoryQuestion(question)) {
    try {
      const items = await getEquipment(token);

      const match = findMatchingItems(
        question,
        items
      );

      if (match) {
        return json({
          reply: makeInventoryAnswer(
            match.keyword,
            match.items,
            wantsAvailableNames(question)
          )
        });
      }

      return json({
        reply:
          "어떤 물품을 확인해 드릴까요? 😊\n\n" +
          "이렇게 질문해 보세요.\n" +
          "• 노트북 몇 대 남았어?\n" +
          "• 대여 가능한 노트북 이름 알려줘\n" +
          "• 지금 빌릴 수 있는 장비 전부 알려줘\n" +
          "• 전체 물품 몇 개야?"
      });
    } catch (error) {
      console.error("재고 조회 오류:", error);

      return json({
        error:
          "Firebase 물품 목록을 조회하지 못했어요. " +
          "잠시 후 다시 시도해 주세요."
      }, 503);
    }
  }

  // ======================================
  // 일반적인 대화는 실제 AI 모델 사용
  // ======================================

  const history = Array.isArray(body.history)
    ? body.history
        .filter(item =>
          item &&
          (
            item.role === "user" ||
            item.role === "assistant"
          ) &&
          typeof item.content === "string" &&
          item.content.length <= 1000
        )
        .slice(-6)
    : [];

  const messages = [
    {
      role: "system",
      content:
        "너는 QRental 웹사이트의 친절한 한국어 AI 챗봇이다. " +
        "일반적인 질문에 자연스럽게 답하고, " +
        "장비 선택, 사용법, 발표 준비 등을 도와준다. " +
        "실제 재고 조회는 서버의 별도 기능이 처리한다. " +
        "재고 숫자나 대여 가능한 물품 이름을 " +
        "추측하거나 만들어내지 마라. " +
        "다른 직원의 개인정보나 대여 내역도 추측하지 마라. " +
        "비밀번호나 민감한 개인정보를 요구하지 않는다. " +
        "답변은 한국어로 친절하고 간결하게 작성한다."
    },
    ...history,
    {
      role: "user",
      content: question
    }
  ];

  try {
    const result = await env.AI.run(
      MODEL,
      {
        messages,
        max_tokens: 450
      }
    );

    const answer =
      typeof result?.response === "string"
        ? result.response.trim()
        : "";

    if (!answer) {
      throw new Error("EMPTY_AI_RESPONSE");
    }

    return json({
      reply: answer
    });
  } catch (error) {
    console.error("AI 실행 오류:", error);

    return json({
      error:
        "AI 답변을 생성하지 못했어요. " +
        "잠시 후 다시 시도해 주세요."
    }, 503);
  }
}

export function onRequestGet() {
  return json({
    error: "POST 요청만 사용할 수 있습니다."
  }, 405);
}
