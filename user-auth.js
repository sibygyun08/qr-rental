
import { auth, db } from "./firebase-config.js";

import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";

import {
  collection, doc, getDoc, setDoc,
  onSnapshot, query, where, runTransaction,
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

const scannedId = new URLSearchParams(
  location.search
).get("item");

function showScreen(id) {
  [
    "loadingScreen", "loginScreen", "signupScreen",
    "profileScreen", "pendingScreen", "userApp"
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
  $(id).className = error ? "qr-error" : "qr-success";
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

$("showSignupBtn").onclick = () => {
  showScreen("signupScreen");
};

$("backLoginBtn").onclick = () => {
  showScreen("loginScreen");
};

$("userLogoutBtn").onclick = async () => {
  await signOut(auth);
};

// 기존 계정 또는 신규 계정의 프로필 만들기
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

// 직원 직접 회원가입
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
        "가입 신청이 완료되었습니다. 관리자 승인을 기다려 주세요."
      );
      showScreen("pendingScreen");

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

// 기존에 만들어진 Firebase 계정용
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
      item.status === "available" ? "대여 가능" : "대여 중";

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
    const item = equipment.find(x => x.id === selectedId);
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
      (loan.status === "active"
        ? " · 대여 중"
        : " · 반납 완료");

    const info = document.createElement("p");
    info.className = "qr-muted";
    info.textContent =
      "반납예정일: " + loan.dueDate +
      (loan.returnedAt?.toDate
        ? " / 반납일: " +
          loan.returnedAt.toDate()
            .toLocaleDateString("ko-KR")
        : "");

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

function handleScannedItem() {
  if (
    scanHandled || !scannedId ||
    !equipmentLoaded || !loansLoaded
  ) return;

  scanHandled = true;

  const item = equipment.find(x => x.id === scannedId);

  if (!item) {
    notify("QR코드에 해당하는 물품이 없습니다.", true);
    return;
  }

  const active = myLoans.find(
    x => x.itemId === scannedId &&
      x.status === "active"
  );

  if (active) {
    notify(item.name + "은(는) 내가 대여 중입니다.");

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
    notify(item.name + " QR코드를 인식했어요!");
  } else {
    notify("현재 다른 사용자가 대여 중인 물품입니다.", true);
  }
}

// 기존 Firestore 트랜잭션 기반 대여
$("rentForm").addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    if (!currentUser || !selectedId) return;
    if (!isAdmin && currentProfile?.status !== "approved") {
      notify("관리자 승인 후 대여할 수 있습니다.", true);
      return;
    }

    const dueDate = $("dueDate").value;

    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) ||
      dueDate < dateText()
    ) {
      notify("반납예정일을 확인해 주세요.", true);
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
          : "대여에 실패했습니다. 관리자 승인 여부와 연결 상태를 확인해 주세요.",
        true
      );
    } finally {
      button.disabled = false;
    }
  }
);

// 본인 반납
async function returnLoan(loan, button) {
  if (!currentUser ||
      loan.borrowerUid !== currentUser.uid) return;

  button.disabled = true;

  const itemRef = doc(db, "equipment", loan.itemId);
  const loanRef = doc(db, "loans", loan.id);

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

    notify("반납 완료! 기록은 그대로 보관됩니다.");

  } catch (error) {
    console.error("반납 오류:", error);
    notify("반납에 실패했습니다.", true);
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
      console.error("물품 목록 오류:", error);
      notify("물품을 불러오지 못했습니다.", true);
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
      console.error("대여 기록 오류:", error);
      notify("대여 기록을 불러오지 못했습니다.", true);
    }
  );
}

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
    if (!signingUp) showScreen("loginScreen");
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

    // 관리자 계정도 사용자 페이지를 이용할 수 있음
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
        if (generation !== authGeneration) return;

        if (!snapshot.exists()) {
          currentProfile = null;
          stopDataListeners();
          if (!signingUp) showScreen("profileScreen");
          return;
        }

        currentProfile = snapshot.data();

        if (currentProfile.status !== "approved") {
          stopDataListeners();

          $("pendingText").textContent =
            currentProfile.name +
            "님, 가입 신청이 접수되었습니다.";

          showScreen("pendingScreen");
          return;
        }

        $("welcomeName").textContent =
          currentProfile.name + "님, 환영합니다!";

        showScreen("userApp");

        if (!stopEquipment || !stopLoans) {
          startDataListeners(generation);
        }
      },
      error => {
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
    console.error("인증 확인 오류:", error);
    showScreen("loginScreen");
    tell(
      "loginNotice",
      "계정 권한 확인에 실패했습니다.",
      true
    );
  }
});
