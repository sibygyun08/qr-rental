
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

// ========================================
// QRental 운영 설정
// ========================================

const MAX_RENTAL_DAYS = 30;

const DEFAULT_CATEGORIES = [
  "노트북",
  "태블릿",
  "촬영 장비",
  "주변기기",
  "기타"
];

let customCategories = [];
let categoriesLoaded = false;

let currentUser = null;
let currentProfile = null;
let isAdmin = false;

let equipment = [];
let myLoans = [];
let selectedId = null;

let stopProfile = null;
let stopEquipment = null;
let stopLoans = null;
let stopCategories = null;

let authGeneration = 0;
let scanHandled = false;
let equipmentLoaded = false;
let loansLoaded = false;
let signingUp = false;
let refreshingVerification = false;

let selectedCategory = "all";

const scannedId = new URLSearchParams(
  location.search
).get("item");

// ========================================
// 기본 화면 함수
// ========================================

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

// ========================================
// 한국 날짜 및 최대 30일 제한
// ========================================

function localDateText(offset = 0) {
  const date = new Date();

  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);

  const year = date.getFullYear();

  const month = String(
    date.getMonth() + 1
  ).padStart(2, "0");

  const day = String(
    date.getDate()
  ).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function updateRentalDateLimit() {
  const input = $("dueDate");

  const minimum = localDateText(0);
  const maximum = localDateText(MAX_RENTAL_DAYS);

  input.min = minimum;
  input.max = maximum;

  if (
    !input.value ||
    input.value < minimum ||
    input.value > maximum
  ) {
    input.value = localDateText(7);
  }
}

updateRentalDateLimit();

const dateHelp = document.createElement("p");

dateHelp.className = "qr-note";

dateHelp.textContent =
  `최대 대여 기간은 ${MAX_RENTAL_DAYS}일입니다. ` +
  "오늘부터 30일 이내로 반납예정일을 선택해 주세요.";

$("dueDate").insertAdjacentElement(
  "afterend",
  dateHelp
);

$("dueDate").addEventListener(
  "focus",
  updateRentalDateLimit
);

document.addEventListener(
  "visibilitychange",
  () => {
    if (!document.hidden) {
      updateRentalDateLimit();
    }
  }
);

// ========================================
// 카테고리 관리 및 직원 필터
// ========================================

function getCategory(item) {
  const value =
    typeof item.category === "string"
      ? item.category.trim()
      : "";

  return value || "미분류";
}

function allCategories() {
  const result = [...DEFAULT_CATEGORIES];

  for (const item of customCategories) {
    const name = item.name;

    if (
      typeof name === "string" &&
      name.trim() &&
      !result.includes(name)
    ) {
      result.push(name);
    }
  }

  return result;
}

const categoryBox = document.createElement("div");

categoryBox.style.display = "grid";
categoryBox.style.gap = "8px";
categoryBox.style.margin = "18px 0";

const categoryLabel = document.createElement("label");

categoryLabel.htmlFor = "categoryFilter";
categoryLabel.textContent = "물품 카테고리";

const categoryFilter = document.createElement("select");

categoryFilter.id = "categoryFilter";
categoryFilter.className = "qr-input";

categoryBox.append(
  categoryLabel,
  categoryFilter
);

const equipmentSection = $("equipmentTable")
  .closest(".qr-box");

const equipmentScroll = $("equipmentTable")
  .closest(".qr-scroll");

equipmentSection.insertBefore(
  categoryBox,
  equipmentScroll
);

function updateCategoryOptions() {
  const previous = selectedCategory;

  categoryFilter.replaceChildren();

  const all = document.createElement("option");

  all.value = "all";
  all.textContent = "전체 카테고리";

  categoryFilter.appendChild(all);

  const known = allCategories();

  // 기존 물품에 등록된 분류도 유지
  const present = equipment.map(getCategory);

  const ordered = [
    ...known,
    ...present.filter(
      name => !known.includes(name)
    )
  ];

  const unique = [...new Set(ordered)];

  for (const name of unique) {
    const option = document.createElement("option");

    option.value = name;
    option.textContent = name;

    categoryFilter.appendChild(option);
  }

  if (unique.includes(previous)) {
    selectedCategory = previous;
  } else {
    selectedCategory = "all";
  }

  categoryFilter.value = selectedCategory;
}

categoryFilter.addEventListener(
  "change",
  () => {
    selectedCategory = categoryFilter.value;
    renderEquipment();
  }
);

// ========================================
// 이메일 인증 안내
// ========================================

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

const checkVerificationBtn =
  document.createElement("button");

checkVerificationBtn.type = "button";
checkVerificationBtn.className = "qr-btn";
checkVerificationBtn.textContent =
  "✅ 인증 상태 다시 확인";

const accountHelpMessage =
  document.createElement("p");

accountHelpMessage.style.margin = "0";
accountHelpMessage.setAttribute(
  "role",
  "status"
);

accountHelp.append(
  accountLink,
  checkVerificationBtn,
  accountHelpMessage
);

$("pendingScreen").appendChild(accountHelp);

function showAccountHelp(visible) {
  accountHelp.hidden = !visible;

  accountHelp.style.display =
    visible ? "grid" : "none";
}

function showPendingMessage(
  message,
  needsVerification
) {
  $("pendingText").textContent = message;

  showScreen("pendingScreen");
  showAccountHelp(needsVerification);
}

// ========================================
// 직원 이용 가능 여부
// ========================================

function applyProfileState() {
  if (
    !currentUser ||
    isAdmin ||
    !currentProfile
  ) {
    return;
  }

  if (!currentUser.emailVerified) {
    stopDataListeners();

    selectedId = null;
    $("rentPanel").hidden = true;

    showPendingMessage(
      (currentProfile.name || "직원") +
      "님, 이메일 인증이 필요합니다. " +
      "아래 버튼을 눌러 인증을 완료해 주세요.",
      true
    );

    return;
  }

  if (currentProfile.status !== "approved") {
    stopDataListeners();

    selectedId = null;
    $("rentPanel").hidden = true;

    showPendingMessage(
      (currentProfile.name || "직원") +
      "님, 관리자 승인을 기다려 주세요.",
      false
    );

    return;
  }

  $("welcomeName").textContent =
    currentProfile.name + "님, 환영합니다!";

  showScreen("userApp");

  if (
    !stopEquipment ||
    !stopLoans ||
    !stopCategories
  ) {
    startDataListeners(authGeneration);
  }
}

checkVerificationBtn.onclick = async () => {
  if (
    !auth.currentUser ||
    refreshingVerification
  ) {
    return;
  }

  refreshingVerification = true;
  checkVerificationBtn.disabled = true;

  accountHelpMessage.textContent =
    "이메일 인증 상태를 확인하고 있어요...";

  const originalUid = auth.currentUser.uid;

  try {
    await reload(auth.currentUser);
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
        "이메일의 인증 링크를 눌러 주세요.";
    }
  } catch (error) {
    console.error(
      "이메일 인증 확인 오류:",
      error
    );

    accountHelpMessage.textContent =
      "인증 상태를 확인하지 못했어요.";
  } finally {
    refreshingVerification = false;
    checkVerificationBtn.disabled = false;
  }
};

// ========================================
// 로그인 및 회원가입
// ========================================

$("showSignupBtn").onclick = () => {
  showScreen("signupScreen");
};

$("backLoginBtn").onclick = () => {
  showScreen("loginScreen");
};

$("userLogoutBtn").onclick = async () => {
  await signOut(auth);
};

async function createPendingProfile(user, name) {
  const cleanName = name.trim();

  if (
    !cleanName ||
    cleanName.length > 40
  ) {
    throw new Error(
      "직원 이름을 확인해 주세요."
    );
  }

  await setDoc(
    doc(db, "profiles", user.uid),
    {
      uid: user.uid,
      name: cleanName,
      email: user.email,
      status: "pending",
      createdAt: serverTimestamp(),
      approvedAt: null
    }
  );
}

$("userLoginForm").addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    const button =
      event.target.querySelector("button");

    button.disabled = true;

    try {
      await setPersistence(
        auth,
        browserLocalPersistence
      );

      await signInWithEmailAndPassword(
        auth,
        $("userEmail").value.trim(),
        $("userPassword").value
      );

      $("userLoginForm").reset();
      $("loginNotice").textContent = "";
    } catch (error) {
      console.error(
        "로그인 오류:",
        error.code
      );

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

$("signupForm").addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    const button =
      event.target.querySelector("button");

    const name = $("signupName").value.trim();
    const email = $("signupEmail").value.trim();
    const password = $("signupPassword").value;

    button.disabled = true;
    signingUp = true;

    try {
      await setPersistence(
        auth,
        browserLocalPersistence
      );

      const result =
        await createUserWithEmailAndPassword(
          auth,
          email,
          password
        );

      await createPendingProfile(
        result.user,
        name
      );

      $("signupForm").reset();

      tell(
        "signupNotice",
        "가입 신청이 완료되었습니다. " +
        "이메일 인증과 관리자 승인을 진행해 주세요."
      );

      currentUser = result.user;

      showPendingMessage(
        name +
        "님, 먼저 이메일 인증을 진행해 주세요.",
        true
      );
    } catch (error) {
      console.error(
        "회원가입 오류:",
        error.code || error
      );

      tell(
        "signupNotice",
        error.code === "auth/email-already-in-use"
          ? "이미 등록된 이메일입니다."
          : "가입 신청에 실패했습니다.",
        true
      );
    } finally {
      signingUp = false;
      button.disabled = false;
    }
  }
);

$("profileForm").addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    if (!currentUser) return;

    const button =
      event.target.querySelector("button");

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
      console.error(
        "프로필 등록 오류:",
        error
      );

      tell(
        "profileNotice",
        "등록에 실패했습니다.",
        true
      );
    } finally {
      button.disabled = false;
    }
  }
);

// ========================================
// Firebase 실시간 구독 관리
// ========================================

function stopDataListeners() {
  if (stopEquipment) stopEquipment();
  if (stopLoans) stopLoans();
  if (stopCategories) stopCategories();

  stopEquipment = null;
  stopLoans = null;
  stopCategories = null;

  equipmentLoaded = false;
  loansLoaded = false;
  categoriesLoaded = false;
}

function stopAllListeners() {
  stopDataListeners();

  if (stopProfile) stopProfile();

  stopProfile = null;
}

// ========================================
// 물품 선택 및 화면
// ========================================

function chooseItem(item) {
  if (
    !currentUser ||
    (
      !isAdmin &&
      (
        !currentUser.emailVerified ||
        currentProfile?.status !== "approved"
      )
    )
  ) {
    return;
  }

  if (item.status !== "available") {
    notify(
      "현재 대여할 수 없는 물품입니다.",
      true
    );
    return;
  }

  selectedId = item.id;

  $("selectedItem").textContent =
    item.name +
    " / 카테고리: " +
    getCategory(item);

  updateRentalDateLimit();

  $("rentPanel").hidden = false;

  $("rentPanel").scrollIntoView({
    behavior: "smooth",
    block: "center"
  });
}

function renderEquipment() {
  const tbody = $("equipmentTable");
  tbody.replaceChildren();

  const filtered = equipment.filter(
    item =>
      selectedCategory === "all" ||
      getCategory(item) === selectedCategory
  );

  $("emptyMessage").hidden =
    filtered.length > 0;

  for (const item of filtered) {
    const row = document.createElement("tr");

    const name = document.createElement("td");

    const title = document.createElement("strong");
    title.textContent = item.name || "-";

    const category = document.createElement("div");
    category.className = "qr-muted";
    category.style.fontSize = "13px";
    category.textContent = getCategory(item);

    name.append(title, category);

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

      button.onclick = () => {
        chooseItem(item);
      };

      action.appendChild(button);
    } else {
      action.textContent = "-";
    }

    row.append(
      name,
      status,
      action
    );

    tbody.appendChild(row);
  }

  if (selectedId) {
    const selected = equipment.find(
      item => item.id === selectedId
    );

    if (
      !selected ||
      selected.status !== "available"
    ) {
      selectedId = null;
      $("rentPanel").hidden = true;
    }
  }
}

// ========================================
// 내 대여 기록
// ========================================

function renderLoans() {
  const box = $("myLoans");
  box.replaceChildren();

  $("noLoans").hidden =
    myLoans.length > 0;

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
      "반납예정일: " +
      loan.dueDate +
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

      button.onclick = () => {
        returnLoan(loan, button);
      };

      line.appendChild(button);
    }

    box.appendChild(line);
  }
}

// ========================================
// QR코드 스캔 처리
// ========================================

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
      item.name +
      "은(는) 내가 대여 중입니다."
    );

    const line = [
      ...$("myLoans").children
    ].find(
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
      item.name +
      " QR코드를 인식했어요!"
    );
  } else {
    notify(
      "현재 다른 사용자가 대여 중인 물품입니다.",
      true
    );
  }
}

// ========================================
// 물품 대여
// ========================================

$("rentForm").addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    if (
      !currentUser ||
      !selectedId
    ) {
      return;
    }

    if (
      !isAdmin &&
      !currentUser.emailVerified
    ) {
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

    updateRentalDateLimit();

    const dueDate = $("dueDate").value;

    const minimum = localDateText(0);
    const maximum = localDateText(MAX_RENTAL_DAYS);

    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) ||
      dueDate < minimum ||
      dueDate > maximum
    ) {
      notify(
        "반납예정일은 오늘부터 " +
        "최대 30일 이내로 선택해야 합니다.",
        true
      );
      return;
    }

    const button = $("rentButton");
    button.disabled = true;

    const itemId = selectedId;
    const borrower = currentUser;

    const itemRef = doc(
      db,
      "equipment",
      itemId
    );

    const loanRef = doc(
      collection(db, "loans")
    );

    try {
      await runTransaction(
        db,
        async tx => {
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
        }
      );

      selectedId = null;
      $("rentPanel").hidden = true;

      notify("대여 완료! 🎉");
    } catch (error) {
      console.error("대여 오류:", error);

      notify(
        error.message === "ALREADY_RENTED"
          ? "이미 다른 사용자가 빌린 물품입니다."
          : "대여에 실패했습니다. " +
            "이메일 인증, 관리자 승인 및 " +
            "반납예정일을 확인해 주세요.",
        true
      );
    } finally {
      button.disabled = false;
    }
  }
);

// ========================================
// 본인 물품 반납
// ========================================

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
    await runTransaction(
      db,
      async tx => {
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
      }
    );

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

// ========================================
// Firestore 실시간 데이터 연결
// ========================================

function startDataListeners(generation) {
  stopDataListeners();

  equipment = [];
  myLoans = [];
  customCategories = [];

  equipmentLoaded = false;
  loansLoaded = false;
  categoriesLoaded = false;
  scanHandled = false;

  // 신규: 직접 추가한 카테고리 실시간 구독
  stopCategories = onSnapshot(
    collection(db, "categories"),
    snapshot => {
      if (generation !== authGeneration) {
        return;
      }

      customCategories = snapshot.docs.map(
        item => ({
          id: item.id,
          ...item.data()
        })
      );

      categoriesLoaded = true;

      updateCategoryOptions();
      renderEquipment();
    },
    error => {
      if (generation !== authGeneration) return;

      console.error(
        "카테고리 조회 오류:",
        error
      );

      categoriesLoaded = false;

      // 카테고리 조회 실패 시에도
      // 기존 물품 조회 및 대여·반납 기능 유지
      updateCategoryOptions();

      notify(
        "카테고리 목록을 불러오지 못했습니다. " +
        "Firebase 보안 규칙을 확인해 주세요.",
        true
      );
    }
  );

  stopEquipment = onSnapshot(
    collection(db, "equipment"),
    snapshot => {
      if (generation !== authGeneration) {
        return;
      }

      equipment = snapshot.docs.map(d => ({
        id: d.id,
        ...d.data()
      }));

      equipmentLoaded = true;

      updateCategoryOptions();
      renderEquipment();
      renderLoans();
      handleScannedItem();
    },
    error => {
      if (generation !== authGeneration) return;

      console.error(
        "물품 목록 오류:",
        error
      );

      notify(
        "물품을 불러오지 못했습니다.",
        true
      );
    }
  );

  stopLoans = onSnapshot(
    query(
      collection(db, "loans"),
      where(
        "borrowerUid",
        "==",
        currentUser.uid
      )
    ),
    snapshot => {
      if (generation !== authGeneration) {
        return;
      }

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

      console.error(
        "대여 기록 오류:",
        error
      );

      notify(
        "대여 기록을 불러오지 못했습니다.",
        true
      );
    }
  );
}

// ========================================
// Firebase 로그인 상태 확인
// ========================================

onAuthStateChanged(
  auth,
  async user => {
    authGeneration++;

    const generation = authGeneration;

    stopAllListeners();

    currentUser = user;
    currentProfile = null;
    isAdmin = false;
    selectedId = null;

    equipment = [];
    myLoans = [];
    customCategories = [];

    equipmentLoaded = false;
    loansLoaded = false;
    categoriesLoaded = false;
    scanHandled = false;

    selectedCategory = "all";

    $("rentPanel").hidden = true;
    $("equipmentTable").replaceChildren();
    $("myLoans").replaceChildren();

    updateCategoryOptions();

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

      if (generation !== authGeneration) {
        return;
      }

      isAdmin =
        adminDoc.exists() &&
        adminDoc.data().role === "admin";

      if (isAdmin) {
        $("welcomeName").textContent =
          "관리자 (" + user.email + ")";

        showScreen("userApp");
        startDataListeners(generation);
        return;
      }

      stopProfile = onSnapshot(
        doc(db, "profiles", user.uid),
        snapshot => {
          if (generation !== authGeneration) {
            return;
          }

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
          if (generation !== authGeneration) {
            return;
          }

          console.error(
            "직원 정보 오류:",
            error
          );

          showScreen("profileScreen");

          tell(
            "profileNotice",
            "직원 정보를 확인하지 못했습니다. " +
            "Firestore 규칙을 확인해 주세요.",
            true
          );
        }
      );
    } catch (error) {
      if (generation !== authGeneration) {
        return;
      }

      console.error(
        "인증 확인 오류:",
        error
      );

      showScreen("loginScreen");

      tell(
        "loginNotice",
        "계정 권한 확인에 실패했습니다.",
        true
      );
    }
  }
);
