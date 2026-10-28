
import { auth, db } from "./firebase-config.js";

import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  setPersistence,
  browserLocalPersistence,
  reload,
  getIdToken
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";

import {
  collection,
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  query,
  where,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";

const $ = id => document.getElementById(id);

let currentUser = null;
let currentProfile = null;
let isAdmin = false;
let equipment = [];
let myLoans = [];
let selectedId = null;

let stopProfile = null;
let stopEquipment = null;
let stopLoans = null;
let authGeneration = 0;
let scanHandled = false;
let equipmentLoaded = false;
let loansLoaded = false;
let signingUp = false;
let refreshingVerification = false;

const scannedId = new URLSearchParams(
  location.search
).get("item");

// 기존 화면 전환
function showScreen(id) {
  [
    "loadingScreen",
    "loginScreen",
    "signupScreen",
    "profileScreen",
    "pendingScreen",
    "userApp"
  ].forEach(name => {
    $(name).hidden = name !== id;
  });

  $("userLogoutBtn").hidden =
    id === "loginScreen" ||
    id === "signupScreen" ||
    id === "loadingScreen";
}

function tell(id, message, error = false) {
  $(id).textContent = message;
  $(id).className = error
    ? "qr-error"
    : "qr-success";
}

function notify(message, error = false) {
  tell("userNotice", message, error);
}

function dateText(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);

  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0")
  ].join("-");
}

$("dueDate").min = dateText();
$("dueDate").value = dateText(7);

// 계정 관리 링크와 인증 확인 버튼 생성
// index.html을 수정하지 않아도 되도록 자바스크립트에서 추가
const accountHelp = document.createElement("div");
accountHelp.id = "accountHelp";
accountHelp.style.marginTop = "18px";
accountHelp.style.display = "grid";
accountHelp.style.gap = "12px";

const accountLink = document.createElement("a");
accountLink.href = "account.html";
accountLink.textContent = "📩 이메일 인증하러 가기";
accountLink.className = "qr-btn";
accountLink.style.display = "block";
accountLink.style.textAlign = "center";
accountLink.style.textDecoration = "none";
accountLink.style.padding = "12px";

const checkVerificationBtn = document.createElement("button");
checkVerificationBtn.type = "button";
checkVerificationBtn.className = "qr-btn";
checkVerificationBtn.textContent = "✅ 인증 상태 다시 확인";

const accountHelpMessage = document.createElement("p");
accountHelpMessage.style.margin = "0";
accountHelpMessage.setAttribute("role", "status");

accountHelp.append(
  accountLink,
  checkVerificationBtn,
  accountHelpMessage
);

$("pendingScreen").appendChild(accountHelp);

function showAccountHelp(visible) {
  accountHelp.hidden = !visible;
  accountHelp.style.display = visible ? "grid" : "none";
}

function showPendingMessage(message, needsVerification) {
  $("pendingText").textContent = message;
  showScreen("pendingScreen");
  showAccountHelp(needsVerification);
}

// 직원 이메일 인증 및 승인 상태에 따라 화면 표시
function applyProfileState() {
  if (!currentUser || isAdmin || !currentProfile) {
    return;
  }

  // 미인증 직원은 승인 여부와 관계없이 대여 불가
  if (!currentUser.emailVerified) {
    stopDataListeners();

    selectedId = null;
    $("rentPanel").hidden = true;

    const name = currentProfile.name || "직원";

    showPendingMessage(
      name + "님, 이메일 인증이 필요합니다. " +
      "아래 버튼을 눌러 인증을 완료해 주세요.",
      true
    );

    return;
  }

  // 이메일 인증은 했지만 관리자가 아직 승인하지 않은 경우
  if (currentProfile.status !== "approved") {
    stopDataListeners();

    selectedId = null;
    $("rentPanel").hidden = true;

    showPendingMessage(
      (currentProfile.name || "직원") +
      "님, 이메일 인증이 완료되었습니다. " +
      "이제 관리자 승인을 기다려 주세요.",
      false
    );

    return;
  }

  // 이메일 인증과 관리자 승인 모두 완료
  $("welcomeName").textContent =
    currentProfile.name + "님, 환영합니다!";

  showScreen("userApp");

  if (!stopEquipment || !stopLoans) {
    startDataListeners(authGeneration);
  }
}

// 이메일 인증 완료 여부를 서버에서 새로 확인
checkVerificationBtn.onclick = async () => {
  if (!auth.currentUser || refreshingVerification) {
    return;
  }

  refreshingVerification = true;
  checkVerificationBtn.disabled = true;

  accountHelpMessage.textContent =
    "이메일 인증 상태를 확인하고 있어요...";

  const originalUid = auth.currentUser.uid;

  try {
    await reload(auth.currentUser);

    // Firestore 규칙에서 사용할 인증 토큰도 새로 받기
    await getIdToken(auth.currentUser, true);

    if (
      !auth.currentUser ||
      auth.currentUser.uid !== originalUid
    ) {
      return;
    }

    currentUser = auth.currentUser;

    if (currentUser.emailVerified) {
      accountHelpMessage.textContent =
        "이메일 인증 완료! 🎉";

      applyProfileState();
    } else {
      accountHelpMessage.textContent =
        "아직 인증되지 않았어요. " +
        "이메일에 있는 인증 링크를 먼저 눌러 주세요.";
    }
  } catch (error) {
    console.error("이메일 인증 확인 오류:", error);

    accountHelpMessage.textContent =
      "인증 상태를 확인하지 못했어요. " +
      "잠시 후 다시 시도해 주세요.";
  } finally {
    refreshingVerification = false;
    checkVerificationBtn.disabled = false;
  }
};

// 화면 버튼
$("showSignupBtn").onclick = () => {
  showScreen("signupScreen");
};

$("backLoginBtn").onclick = () => {
  showScreen("loginScreen");
};

$("userLogoutBtn").onclick = async () => {
  await signOut(auth);
};

// 직원 프로필 만들기
async function createPendingProfile(user, name) {
  const cleanName = name.trim();

  if (!cleanName || cleanName.length > 40) {
    throw new Error("직원 이름을 확인해 주세요.");
  }

  await setDoc(doc(db, "profiles", user.uid), {
    uid: user.uid,
    name: cleanName,
    email: user.email,
    status: "pending",
    createdAt: serverTimestamp(),
    approvedAt: null
  });
}

// 이메일 로그인
$("userLoginForm").addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    const button = event.target.querySelector("button");
    button.disabled = true;

    try {
      await setPersistence(auth, browserLocalPersistence);

      await signInWithEmailAndPassword(
        auth,
        $("userEmail").value.trim(),
        $("userPassword").value
      );

      $("userLoginForm").reset();
      $("loginNotice").textContent = "";
    } catch (error) {
      console.error("로그인 오류:", error.code);

      tell(
        "loginNotice",
        "이메일 또는 비밀번호를 확인해 주세요.",
        true
      );
    } finally {
      button.disabled = false;
    }
  }
);

// 직원 회원가입
$("signupForm").addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    const button = event.target.querySelector("button");

    const name = $("signupName").value.trim();
    const email = $("signupEmail").value.trim();
    const password = $("signupPassword").value;

    button.disabled = true;
    signingUp = true;

    try {
      await setPersistence(auth, browserLocalPersistence);

      const result = await createUserWithEmailAndPassword(
        auth,
        email,
        password
      );

      await createPendingProfile(result.user, name);

      $("signupForm").reset();

      tell(
        "signupNotice",
        "가입 신청이 완료되었습니다. " +
        "이메일 인증과 관리자 승인을 진행해 주세요."
      );

      currentUser = result.user;

      showPendingMessage(
        name + "님, 가입 신청이 완료되었습니다. " +
        "먼저 이메일 인증을 진행해 주세요.",
        true
      );

    } catch (error) {
      console.error("회원가입 오류:", error.code || error);

      tell(
        "signupNotice",
        error.code === "auth/email-already-in-use"
          ? "이미 등록된 이메일입니다. 로그인해 주세요."
          : "가입 신청에 실패했습니다. 이름, 이메일, 비밀번호를 확인해 주세요.",
        true
      );
    } finally {
      signingUp = false;
      button.disabled = false;
    }
  }
);

// 기존 Firebase 계정의 프로필 등록
$("profileForm").addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    if (!currentUser) return;

    const button = event.target.querySelector("button");
    button.disabled = true;

    try {
      await createPendingProfile(
        currentUser,
        $("profileName").value
      );

      tell(
        "profileNotice",
        "승인 요청이 등록되었습니다."
      );
    } catch (error) {
      console.error("프로필 등록 오류:", error);

      tell(
        "profileNotice",
        "등록에 실패했습니다. 다시 확인해 주세요.",
        true
      );
    } finally {
      button.disabled = false;
    }
  }
);

function stopDataListeners() {
  if (stopEquipment) stopEquipment();
  if (stopLoans) stopLoans();

  stopEquipment = null;
  stopLoans = null;
}

function stopAllListeners() {
  stopDataListeners();

  if (stopProfile) stopProfile();

  stopProfile = null;
}

function chooseItem(item) {
  // 미인증 직원의 대여 화면 접근 차단
  if (
    !currentUser ||
    (!isAdmin && (
      !currentUser.emailVerified ||
      currentProfile?.status !== "approved"
    ))
  ) {
    return;
  }

  selectedId = item.id;

  $("selectedItem").textContent = item.name;
  $("rentPanel").hidden = false;

  $("rentPanel").scrollIntoView({
    behavior: "smooth",
    block: "center"
  });
}

function renderEquipment() {
  const tbody = $("equipmentTable");
  tbody.replaceChildren();

  $("emptyMessage").hidden = equipment.length > 0;

  for (const item of equipment) {
    const row = document.createElement("tr");

    const name = document.createElement("td");
    name.textContent = item.name || "-";

    const status = document.createElement("td");
    status.textContent =
      item.status === "available"
        ? "대여 가능"
        : "대여 중";

    const action = document.createElement("td");

    if (item.status === "available") {
      const button = document.createElement("button");

      button.className = "qr-btn";
      button.type = "button";
      button.textContent = "대여";
      button.onclick = () => chooseItem(item);

      action.appendChild(button);
    } else {
      action.textContent = "-";
    }

    row.append(name, status, action);
    tbody.appendChild(row);
  }

  if (selectedId) {
    const item = equipment.find(
      x => x.id === selectedId
    );

    if (!item || item.status !== "available") {
      selectedId = null;
      $("rentPanel").hidden = true;
    }
  }
}

function renderLoans() {
  const box = $("myLoans");
  box.replaceChildren();

  $("noLoans").hidden = myLoans.length > 0;

  const sorted = [...myLoans].sort(
    (a, b) =>
      (b.borrowedAt?.seconds || 0) -
      (a.borrowedAt?.seconds || 0)
  );

  for (const loan of sorted) {
    const line = document.createElement("div");

    line.className = "qr-record";
    line.dataset.itemId = loan.itemId;

    const item = equipment.find(
      x => x.id === loan.itemId
    );

    const title = document.createElement("strong");

    title.textContent =
      (item?.name || loan.itemId) +
      (
        loan.status === "active"
          ? " · 대여 중"
          : " · 반납 완료"
      );

    const info = document.createElement("p");
    info.className = "qr-muted";

    info.textContent =
      "반납예정일: " + loan.dueDate +
      (
        loan.returnedAt?.toDate
          ? " / 반납일: " +
            loan.returnedAt.toDate()
              .toLocaleDateString("ko-KR")
          : ""
      );

    line.append(title, info);

    if (loan.status === "active") {
      const button = document.createElement("button");

      button.className = "qr-btn";
      button.type = "button";
      button.textContent = "내 물품 반납";

      button.onclick = () => returnLoan(loan, button);

      line.appendChild(button);
    }

    box.appendChild(line);
  }
}

// QR코드로 들어온 물품 자동 선택
function handleScannedItem() {
  if (
    scanHandled ||
    !scannedId ||
    !equipmentLoaded ||
    !loansLoaded
  ) {
    return;
  }

  scanHandled = true;

  const item = equipment.find(
    x => x.id === scannedId
  );

  if (!item) {
    notify(
      "QR코드에 해당하는 물품이 없습니다.",
      true
    );
    return;
  }

  const active = myLoans.find(
    x =>
      x.itemId === scannedId &&
      x.status === "active"
  );

  if (active) {
    notify(
      item.name + "은(는) 내가 대여 중입니다."
    );

    const line = [...$("myLoans").children].find(
      x => x.dataset.itemId === scannedId
    );

    line?.scrollIntoView({
      behavior: "smooth",
      block: "center"
    });

    return;
  }

  if (item.status === "available") {
    chooseItem(item);

    notify(
      item.name + " QR코드를 인식했어요!"
    );
  } else {
    notify(
      "현재 다른 사용자가 대여 중인 물품입니다.",
      true
    );
  }
}

// Firestore 트랜잭션 기반 대여
$("rentForm").addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    if (!currentUser || !selectedId) return;

    if (!isAdmin && !currentUser.emailVerified) {
      notify(
        "이메일 인증 완료 후 대여할 수 있습니다.",
        true
      );
      return;
    }

    if (
      !isAdmin &&
      currentProfile?.status !== "approved"
    ) {
      notify(
        "관리자 승인 후 대여할 수 있습니다.",
        true
      );
      return;
    }

    const dueDate = $("dueDate").value;

    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) ||
      dueDate < dateText()
    ) {
      notify(
        "반납예정일을 확인해 주세요.",
        true
      );
      return;
    }

    const button = $("rentButton");
    button.disabled = true;

    const itemId = selectedId;
    const borrower = currentUser;

    const itemRef = doc(db, "equipment", itemId);
    const loanRef = doc(collection(db, "loans"));

    try {
      await runTransaction(db, async tx => {
        const itemDoc = await tx.get(itemRef);

        if (
          !itemDoc.exists() ||
          itemDoc.data().status !== "available" ||
          itemDoc.data().activeLoanId !== ""
        ) {
          throw new Error("ALREADY_RENTED");
        }

        tx.set(loanRef, {
          itemId,
          borrowerUid: borrower.uid,
          borrowerEmail: borrower.email,
          borrowedAt: serverTimestamp(),
          dueDate,
          returnedAt: null,
          status: "active"
        });

        tx.update(itemRef, {
          status: "rented",
          activeLoanId: loanRef.id
        });
      });

      selectedId = null;
      $("rentPanel").hidden = true;

      notify("대여 완료! 🎉");

    } catch (error) {
      console.error("대여 오류:", error);

      notify(
        error.message === "ALREADY_RENTED"
          ? "이미 다른 사용자가 빌린 물품입니다."
          : "대여에 실패했습니다. 이메일 인증, 관리자 승인 및 연결 상태를 확인해 주세요.",
        true
      );
    } finally {
      button.disabled = false;
    }
  }
);

// 본인 물품 반납
async function returnLoan(loan, button) {
  if (
    !currentUser ||
    loan.borrowerUid !== currentUser.uid
  ) {
    return;
  }

  if (
    !isAdmin &&
    (
      !currentUser.emailVerified ||
      currentProfile?.status !== "approved"
    )
  ) {
    notify(
      "이메일 인증과 관리자 승인을 확인해 주세요.",
      true
    );
    return;
  }

  button.disabled = true;

  const itemRef = doc(
    db,
    "equipment",
    loan.itemId
  );

  const loanRef = doc(
    db,
    "loans",
    loan.id
  );

  try {
    await runTransaction(db, async tx => {
      const itemDoc = await tx.get(itemRef);
      const loanDoc = await tx.get(loanRef);

      if (
        !itemDoc.exists() ||
        !loanDoc.exists() ||
        itemDoc.data().status !== "rented" ||
        itemDoc.data().activeLoanId !== loan.id ||
        loanDoc.data().status !== "active" ||
        loanDoc.data().borrowerUid !== currentUser.uid
      ) {
        throw new Error("NOT_ACTIVE");
      }

      tx.update(loanRef, {
        status: "returned",
        returnedAt: serverTimestamp()
      });

      tx.update(itemRef, {
        status: "available",
        activeLoanId: ""
      });
    });

    notify(
      "반납 완료! 기록은 그대로 보관됩니다."
    );

  } catch (error) {
    console.error("반납 오류:", error);

    notify(
      "반납에 실패했습니다.",
      true
    );
  } finally {
    button.disabled = false;
  }
}

function startDataListeners(generation) {
  stopDataListeners();

  equipment = [];
  myLoans = [];
  equipmentLoaded = false;
  loansLoaded = false;
  scanHandled = false;

  stopEquipment = onSnapshot(
    collection(db, "equipment"),
    snapshot => {
      if (generation !== authGeneration) return;

      equipment = snapshot.docs.map(d => ({
        id: d.id,
        ...d.data()
      }));

      equipmentLoaded = true;

      renderEquipment();
      renderLoans();
      handleScannedItem();
    },
    error => {
      if (generation !== authGeneration) return;

      console.error("물품 목록 오류:", error);

      notify(
        "물품을 불러오지 못했습니다.",
        true
      );
    }
  );

  stopLoans = onSnapshot(
    query(
      collection(db, "loans"),
      where("borrowerUid", "==", currentUser.uid)
    ),
    snapshot => {
      if (generation !== authGeneration) return;

      myLoans = snapshot.docs.map(d => ({
        id: d.id,
        ...d.data()
      }));

      loansLoaded = true;

      renderLoans();
      handleScannedItem();
    },
    error => {
      if (generation !== authGeneration) return;

      console.error("대여 기록 오류:", error);

      notify(
        "대여 기록을 불러오지 못했습니다.",
        true
      );
    }
  );
}

// Firebase 로그인 상태 확인
onAuthStateChanged(auth, async user => {
  authGeneration++;
  const generation = authGeneration;

  stopAllListeners();

  currentUser = user;
  currentProfile = null;
  isAdmin = false;
  selectedId = null;

  equipment = [];
  myLoans = [];

  $("rentPanel").hidden = true;
  $("equipmentTable").replaceChildren();
  $("myLoans").replaceChildren();

  if (!user) {
    if (!signingUp) {
      showScreen("loginScreen");
    }
    return;
  }

  showScreen("loadingScreen");

  try {
    const adminDoc = await getDoc(
      doc(db, "admins", user.uid)
    );

    if (generation !== authGeneration) return;

    isAdmin =
      adminDoc.exists() &&
      adminDoc.data().role === "admin";

    // 관리자 권한은 기존처럼 유지
    if (isAdmin) {
      $("welcomeName").textContent =
        "관리자 (" + user.email + ")";

      showScreen("userApp");
      startDataListeners(generation);
      return;
    }

    // 직원 프로필 상태 실시간 확인
    stopProfile = onSnapshot(
      doc(db, "profiles", user.uid),
      snapshot => {
        if (generation !== authGeneration) return;

        if (!snapshot.exists()) {
          currentProfile = null;
          stopDataListeners();

          if (!signingUp) {
            showScreen("profileScreen");
          }
          return;
        }

        currentProfile = snapshot.data();

        applyProfileState();
      },
      error => {
        if (generation !== authGeneration) return;

        console.error("직원 정보 오류:", error);

        showScreen("profileScreen");

        tell(
          "profileNotice",
          "직원 정보를 확인하지 못했습니다. Firestore 규칙을 확인해 주세요.",
          true
        );
      }
    );

  } catch (error) {
    if (generation !== authGeneration) return;

    console.error("인증 확인 오류:", error);

    showScreen("loginScreen");

    tell(
      "loginNotice",
      "계정 권한 확인에 실패했습니다.",
      true
    );
  }
});
