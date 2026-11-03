
const PROJECT_ID = "qr-rental-system-6df07";

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

const PUBLIC_KEYS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/" +
  "securetoken@system.gserviceaccount.com";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
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

// Firebase 로그인 토큰의 전자서명을 검증한다.
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

  const response = await fetch(PUBLIC_KEYS_URL, {
    cf: {
      cacheTtl: 3600,
      cacheEverything: true
    }
  });

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

// 현재 Firebase 규칙을 이용해 직원 승인 여부 확인
async function hasRentalAccess(token, user) {
  if (user.email_verified === true) {
    const profileUrl =
      `https://firestore.googleapis.com/v1/projects/` +
      `${PROJECT_ID}/databases/(default)/documents/profiles/` +
      encodeURIComponent(user.sub);

    const profileResponse = await fetch(profileUrl, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (profileResponse.ok) {
      const profile = await profileResponse.json();

      if (
        profile.fields?.status?.stringValue ===
        "approved"
      ) {
        return true;
      }
    }
  }

  // 관리자 계정도 이용 가능
  const adminUrl =
    `https://firestore.googleapis.com/v1/projects/` +
    `${PROJECT_ID}/databases/(default)/documents/admins/` +
    encodeURIComponent(user.sub);

  const adminResponse = await fetch(adminUrl, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!adminResponse.ok) {
    return false;
  }

  const admin = await adminResponse.json();

  return admin.fields?.role?.stringValue === "admin";
}

export async function onRequestPost({ request, env }) {
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
    console.error("인증 확인 오류:", error.message);

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

  if (!question || question.length > 500) {
    return json({
      error: "질문은 1~500자로 입력해 주세요."
    }, 400);
  }

  // 최근 대화만 받아서 모델 사용량을 제한한다.
  const history = Array.isArray(body.history)
    ? body.history
        .filter(
          item =>
            item &&
            (item.role === "user" ||
              item.role === "assistant") &&
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
        "일반적인 질문에도 자연스럽게 답하고, " +
        "물품 대여와 장비 사용에 관해서도 도움을 준다. " +
        "아직 Firebase 재고 조회 기능은 연결되지 않았으므로 " +
        "현재 재고 수량, 다른 직원의 대여 정보, " +
        "실시간 대여 현황을 추측하거나 만들어내지 마라. " +
        "실시간 조회가 필요하면 아직 연결되지 않았다고 안내한다. " +
        "비밀번호나 개인정보를 요구하지 않는다. " +
        "답변은 간결하고 이해하기 쉽게 작성한다."
    },
    ...history,
    {
      role: "user",
      content: question
    }
  ];

  try {
    const result = await env.AI.run(MODEL, {
      messages,
      max_tokens: 450
    });

    const answer =
      typeof result?.response === "string"
        ? result.response.trim()
        : "";

    if (!answer) {
      throw new Error("EMPTY_AI_RESPONSE");
    }

    return json({ reply: answer });
  } catch (error) {
    console.error("AI 실행 오류:", error);

    return json({
      error:
        "AI 답변을 생성하지 못했어요. " +
        "무료 사용량이나 모델 상태를 확인해 주세요."
    }, 503);
  }
}

export function onRequestGet() {
  return json({
    error: "POST 요청만 사용할 수 있습니다."
  }, 405);
}
