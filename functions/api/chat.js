
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

function decodeBase64Url(value) {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const padded = base64.padEnd(
    Math.ceil(base64.length / 4) * 4,
    "="
  );

  return Uint8Array.from(
    atob(padded),
    char => char.charCodeAt(0)
  );
}

// ========================================
// Firebase 로그인 토큰 검증
// ========================================

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
// 직원 승인 및 관리자 권한 확인
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
// Firestore 실제 물품 목록 조회
// ========================================

function fieldString(document, fieldName) {
  return (
    document?.fields?.[fieldName]?.stringValue ||
    ""
  );
}

async function getEquipment(token) {
  const items = [];
  let pageToken = "";

  // 최대 10,000개까지만 조회.
  // 초과 시 불완전한 수량을 답하지 않는다.
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
        category: fieldString(
          entry,
          "category"
        ) || "미분류",
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
// 재고 질문 분석
// ========================================

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[?!.,~]/g, "");
}

function isInventoryQuestion(question) {
  return /몇\s*(대|개|건)|재고|남았|남아|대여\s*가능|빌릴\s*수|빌려|대여\s*중|반납\s*가능|현황|보유|수량|몇\s*개나|있는지|있어\??|있나요|없어\??/i
    .test(question);
}

function isAllInventoryQuestion(question) {
  const normalized = normalize(question);

  return (
    normalized.includes("전체") ||
    normalized.includes("모든물품") ||
    normalized.includes("총물품") ||
    normalized.includes("전체장비") ||
    normalized.includes("모든장비")
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
  ])].sort((a, b) => b.length - a.length);
}

function findMatchingItems(question, items) {
  const q = normalize(question);

  if (isAllInventoryQuestion(question)) {
    return {
      keyword: "전체 물품",
      items
    };
  }

  const terms = getSearchTerms(items);

  const foundTerm = terms.find(
    term => q.includes(normalize(term))
  );

  if (foundTerm) {
    const target = normalize(foundTerm);

    const matched = items.filter(item => {
      const name = normalize(item.name);
      const category = normalize(item.category);

      return (
        name.includes(target) ||
        category.includes(target)
      );
    });

    return {
      keyword: foundTerm,
      items: matched
    };
  }

  // 물품 이름 그대로 질문한 경우도 인식
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

  return null;
}

// ========================================
// 실제 재고 수량 계산
// ========================================

function countInventory(items) {
  const available = items.filter(
    item => item.status === "available"
  ).length;

  const rented = items.filter(
    item => item.status === "rented"
  ).length;

  const other = items.length -
    available -
    rented;

  return {
    total: items.length,
    available,
    rented,
    other
  };
}

function makeInventoryAnswer(
  keyword,
  items
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
    answer +=
      "\n\n현재 해당 물품은 " +
      "등록되어 있지 않아요.";
  } else if (counts.available === 0) {
    answer +=
      "\n\n현재 바로 대여할 수 있는 " +
      "물품은 없어요.";
  } else {
    answer +=
      "\n\n지금 대여 가능한 물품이 있어요! 😊";
  }

  return answer;
}

// ========================================
// AI 챗봇 API
// ========================================

export async function onRequestPost({
  request,
  env
}) {
  if (!env.AI) {
    return json({
      error:
        "Cloudflare AI 연결을 확인해 주세요."
    }, 503);
  }

  const authorization =
    request.headers.get("Authorization") || "";

  if (!authorization.startsWith("Bearer ")) {
    return json({
      error: "로그인이 필요합니다."
    }, 401);
  }

  const token = authorization
    .slice(7)
    .trim();

  let user;

  try {
    user = await verifyFirebaseToken(token);
  } catch (error) {
    console.error(
      "Firebase 인증 오류:",
      error.message
    );

    return json({
      error:
        "로그인 인증을 확인하지 못했습니다."
    }, 401);
  }

  try {
    const allowed = await hasRentalAccess(
      token,
      user
    );

    if (!allowed) {
      return json({
        error:
          "관리자 승인 후 이용할 수 있습니다."
      }, 403);
    }
  } catch (error) {
    console.error(
      "사용자 권한 확인 오류:",
      error
    );

    return json({
      error:
        "사용자 권한을 확인하지 못했습니다."
    }, 503);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({
      error:
        "올바른 질문 형식이 아닙니다."
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
      error:
        "질문은 1~500자로 입력해 주세요."
    }, 400);
  }

  // ======================================
  // 실제 재고에 관한 질문
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
            match.items
          )
        });
      }

      // 품목을 명시하지 않았다면 추측하지 않음
      return json({
        reply:
          "어떤 물품을 확인해 드릴까요? 😊\n\n" +
          "예를 들어 이렇게 질문해 보세요.\n" +
          "• 노트북 몇 대 남았어?\n" +
          "• 태블릿 몇 대 대여 중이야?\n" +
          "• 빔프로젝터 있어?\n" +
          "• 전체 물품 몇 개야?"
      });
    } catch (error) {
      console.error(
        "재고 조회 오류:",
        error
      );

      return json({
        error:
          "Firebase 물품 목록을 " +
          "조회하지 못했어요. " +
          "잠시 후 다시 시도해 주세요."
      }, 503);
    }
  }

  // ======================================
  // 일반 대화는 실제 AI 모델로 처리
  // ======================================

  const history = Array.isArray(body.history)
    ? body.history
        .filter(
          item =>
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
        "너는 QRental 웹사이트의 친절한 " +
        "한국어 AI 챗봇이다. " +
        "일반적인 질문에 자연스럽게 답하고, " +
        "장비 선택, 사용법, 발표 준비 등도 " +
        "도와준다. " +
        "실제 재고 수량은 서버의 별도 " +
        "조회 기능이 처리한다. " +
        "따라서 너는 현재 재고 숫자나 " +
        "다른 직원의 대여 정보를 " +
        "추측해서 만들지 마라. " +
        "개인정보나 비밀번호를 요구하지 마라. " +
        "친절하고 간결하게 답변한다."
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
      throw new Error(
        "EMPTY_AI_RESPONSE"
      );
    }

    return json({
      reply: answer
    });
  } catch (error) {
    console.error(
      "AI 실행 오류:",
      error
    );

    return json({
      error:
        "AI 답변을 생성하지 못했어요. " +
        "잠시 후 다시 시도해 주세요."
    }, 503);
  }
}

export function onRequestGet() {
  return json({
    error:
      "POST 요청만 사용할 수 있습니다."
  }, 405);
}
