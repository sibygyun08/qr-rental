
import { auth } from "./firebase-config.js";

import {
  onAuthStateChanged,
  getIdToken
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";

// ========================================
// QRental AI 챗봇
// ========================================

const chat = document.getElementById("assistantChat");
const form = document.getElementById("assistantForm");
const questionInput =
  document.getElementById("assistantQuestion");
const askButton =
  document.getElementById("assistantAskBtn");
const userApp = document.getElementById("userApp");

const exampleButtons = [
  ...document.querySelectorAll(".assistant-example")
];

let history = [];
let sending = false;
let currentUid = null;
let activeRequest = null;

// ========================================
// 화면 표시
// ========================================

function addMessage(text, role = "bot") {
  const message = document.createElement("div");

  message.className =
    "assistant-message " +
    (role === "user" ? "user" : "bot");

  message.textContent = text;

  chat.appendChild(message);
  chat.scrollTop = chat.scrollHeight;

  return message;
}

function setChatReady(ready) {
  const enabled = ready && !sending;

  questionInput.disabled = !enabled;
  askButton.disabled = !enabled;

  for (const button of exampleButtons) {
    button.disabled = !enabled;
  }
}

function canUseChat() {
  return (
    !!auth.currentUser &&
    !userApp.hidden
  );
}

function refreshChatAccess() {
  setChatReady(canUseChat());
}

function resetChat() {
  if (activeRequest) {
    activeRequest.abort();
    activeRequest = null;
  }

  history = [];
  sending = false;

  chat.replaceChildren();

  addMessage(
    "안녕하세요! 🤖\n" +
    "QRental AI 챗봇이에요.\n\n" +
    "장비 사용법, 발표 준비, " +
    "일반적인 질문까지 편하게 물어보세요!\n\n" +
    "※ 실시간 재고 조회 기능은 " +
    "아직 연결 준비 중이에요."
  );

  questionInput.value = "";
  refreshChatAccess();
}

// ========================================
// 로그인 및 승인 화면 감지
// ========================================

onAuthStateChanged(auth, user => {
  const nextUid = user?.uid || null;

  if (nextUid !== currentUid) {
    currentUid = nextUid;
    resetChat();
  }

  refreshChatAccess();
});

const screenObserver = new MutationObserver(() => {
  if (!canUseChat() && activeRequest) {
    activeRequest.abort();
  }

  refreshChatAccess();
});

screenObserver.observe(userApp, {
  attributes: true,
  attributeFilter: ["hidden"]
});

// ========================================
// 실제 AI 질문 보내기
// ========================================

async function sendQuestion(question) {
  const text = String(question || "").trim();

  if (
    !text ||
    text.length > 200 ||
    sending ||
    !canUseChat()
  ) {
    return;
  }

  const user = auth.currentUser;
  const uid = user.uid;

  const previousHistory = history.slice(-6);

  addMessage(text, "user");

  questionInput.value = "";
  sending = true;
  setChatReady(false);

  const waitingMessage = addMessage(
    "답변을 생각하고 있어요... ✨"
  );

  const controller = new AbortController();
  activeRequest = controller;

  try {
    const token = await getIdToken(user);

    if (
      controller.signal.aborted ||
      auth.currentUser?.uid !== uid ||
      !canUseChat()
    ) {
      return;
    }

    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        message: text,
        history: previousHistory
      }),
      signal: controller.signal
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(
        result.error ||
        "AI 서버에 연결하지 못했어요."
      );
    }

    if (
      controller.signal.aborted ||
      auth.currentUser?.uid !== uid ||
      !canUseChat()
    ) {
      return;
    }

    const reply = String(
      result.reply || ""
    ).trim();

    if (!reply) {
      throw new Error(
        "AI가 빈 답변을 보냈어요."
      );
    }

    waitingMessage.textContent = reply;

    history.push(
      { role: "user", content: text },
      { role: "assistant", content: reply }
    );

    history = history.slice(-6);

  } catch (error) {
    if (controller.signal.aborted) {
      waitingMessage.remove();
      return;
    }

    console.error("QRental AI 오류:", error);

    waitingMessage.textContent =
      "⚠️ " +
      (
        error.message ||
        "AI 답변을 가져오지 못했어요."
      );

  } finally {
    if (activeRequest === controller) {
      activeRequest = null;
    }

    sending = false;
    refreshChatAccess();

    chat.scrollTop = chat.scrollHeight;
  }
}

// ========================================
// 질문 버튼 및 예시 질문
// ========================================

form.addEventListener("submit", event => {
  event.preventDefault();

  sendQuestion(questionInput.value);
});

for (const button of exampleButtons) {
  button.addEventListener("click", () => {
    const question = button.dataset.question;

    if (!question) {
      return;
    }

    sendQuestion(question);
  });
}

resetChat();
