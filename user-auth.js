
import { auth, db } from "./firebase-config.js";

import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";

import {
  collection,
  doc,
  onSnapshot,
  query,
  where,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";

const $ = id => document.getElementById(id);

let user = null;
let equipment = [];
let myLoans = [];
let chosenId = null;
let stopEquipment = null;
let stopLoans = null;
let equipmentLoaded = false;
let loansLoaded = false;
let scanHandled = false;

const params = new URLSearchParams(location.search);
const scannedId = params.get("item");

function notice(text, error = false) {
  $("userNotice").textContent = text;
  $("userNotice").className =
    "notice " + (error ? "error" : "success");
}

function localDate(offset = 0) {
  const date = new Date();
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

$("dueDate").min = localDate();
$("dueDate").value = localDate(7);

// 처음 로그인할 때 이후에도 상태 유지
$("userLoginForm").addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    const button = event.target.querySelector("button");
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

      event.target.reset();
      $("loginNotice").textContent = "";
    } catch (error) {
      console.error("로그인 오류:", error.code);

      $("loginNotice").textContent =
        "로그인에 실패했습니다. 계정 정보를 확인해 주세요.";

      $("loginNotice").className = "notice error";
    } finally {
      button.disabled = false;
    }
  }
);

$("userLogoutBtn").addEventListener(
  "click",
  async () => {
    await signOut(auth);
  }
);

// 물품 선택
function chooseItem(item) {
  chosenId = item.id;

  $("selectedItem").textContent =
    "대여할 물품: " + item.name;

  $("rentPanel").hidden = false;

  $("rentPanel").scrollIntoView({
    behavior: "smooth",
    block: "center"
  });
}

// 물품 목록 표시
function renderEquipment() {
  const table = $("equipmentTable");
  table.replaceChildren();

  $("emptyMessage").hidden = equipment.length !== 0;

  for (const item of equipment) {
    const row = document.createElement("tr");

    const nameCell = document.createElement("td");
    nameCell.textContent = item.name;

    const statusCell = document.createElement("td");
    const badge = document.createElement("span");

    const available = item.status === "available";

    badge.className =
      "badge " + (available ? "available" : "rented");

    badge.textContent =
      available ? "대여 가능" : "대여 중";

    statusCell.appendChild(badge);

    const actionCell = document.createElement("td");

    if (available) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button primary";
      button.textContent = "대여";

      button.addEventListener(
        "click",
        () => chooseItem(item)
      );

      actionCell.appendChild(button);
    } else {
      actionCell.textContent = "-";
    }

    row.append(
      nameCell,
      statusCell,
      actionCell
    );

    table.appendChild(row);
  }

  // 선택 중인 물품이 다른 사용자에게 대여된 경우
  if (chosenId) {
    const selected = equipment.find(
      item => item.id === chosenId
    );

    if (!selected || selected.status !== "available") {
      chosenId = null;
      $("rentPanel").hidden = true;
    }
  }
}

// 내 대여 기록
function renderLoans() {
  const box = $("myLoans");
  box.replaceChildren();

  $("noLoans").hidden = myLoans.length !== 0;

  const sorted = [...myLoans].sort(
    (a, b) =>
      (b.borrowedAt?.seconds || 0) -
      (a.borrowedAt?.seconds || 0)
  );

  for (const loan of sorted) {
    const line = document.createElement("div");
    line.className = "loan-item";
    line.dataset.itemId = loan.itemId;

    const item = equipment.find(
      equipmentItem =>
        equipmentItem.id === loan.itemId
    );

    const title = document.createElement("strong");

    title.textContent =
      (item?.name || loan.itemId) +
      " · " +
      (loan.status === "active"
        ? "대여 중"
        : "반납 완료");

    line.appendChild(title);

    const description = document.createElement("p");
    description.className = "hint";

    description.textContent =
      "반납예정일: " + loan.dueDate +
      (loan.returnedAt
        ? " / 실제 반납: " +
          loan.returnedAt.toDate()
            .toLocaleDateString("ko-KR")
        : "");

    line.appendChild(description);

    if (loan.status === "active") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button primary";
      button.textContent = "내 물품 반납";

      button.addEventListener(
        "click",
        () => returnLoan(loan, button)
      );

      line.appendChild(button);
    }

    box.appendChild(line);
  }
}

// QR코드로 들어온 물품 자동 선택
function handleScannedItem() {
  if (
    !scannedId ||
    !user ||
    !equipmentLoaded ||
    !loansLoaded ||
    scanHandled
  ) {
    return;
  }

  scanHandled = true;

  const item = equipment.find(
    equipmentItem => equipmentItem.id === scannedId
  );

  if (!item) {
    notice(
      "QR코드에 해당하는 물품을 찾을 수 없습니다.",
      true
    );
    return;
  }

  const myActiveLoan = myLoans.find(
    loan =>
      loan.itemId === scannedId &&
      loan.status === "active"
  );

  // 내가 이미 빌린 물품이면 반납 화면으로
  if (myActiveLoan) {
    notice(
      item.name +
      "은(는) 내가 대여 중인 물품입니다. 아래에서 반납하세요."
    );

    const activeLine = [...$("myLoans").children].find(
      element => element.dataset.itemId === scannedId
    );

    activeLine?.scrollIntoView({
      behavior: "smooth",
      block: "center"
    });

    return;
  }

  // 대여 가능한 물품이면 자동 선택
  if (item.status === "available") {
    chooseItem(item);

    notice(
      item.name +
      " QR코드를 인식했어요! 반납예정일을 선택해 주세요."
    );
    return;
  }

  // 다른 사람이 대여 중인 경우
  notice(
    item.name +
    "은(는) 현재 다른 사용자가 대여 중입니다.",
    true
  );
}

// 대여하기
$("rentForm").addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    if (!user || !chosenId) return;

    const due = $("dueDate").value;

    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(due) ||
      due < localDate()
    ) {
      notice(
        "반납예정일을 확인해 주세요.",
        true
      );
      return;
    }

    const button = $("rentButton");
    button.disabled = true;

    const currentUser = user;
    const itemId = chosenId;

    const equipmentRef = doc(
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
        async transaction => {
          const snapshot = await transaction.get(
            equipmentRef
          );

          if (
            !snapshot.exists() ||
            snapshot.data().status !== "available" ||
            snapshot.data().activeLoanId !== ""
          ) {
            throw new Error("ALREADY_RENTED");
          }

          transaction.set(loanRef, {
            itemId,
            borrowerUid: currentUser.uid,
            borrowerEmail: currentUser.email,
            borrowedAt: serverTimestamp(),
            dueDate: due,
            returnedAt: null,
            status: "active"
          });

          transaction.update(
            equipmentRef,
            {
              status: "rented",
              activeLoanId: loanRef.id
            }
          );
        }
      );

      $("rentPanel").hidden = true;
      chosenId = null;

      notice("대여가 완료되었습니다! 🎉");
    } catch (error) {
      console.error("대여 오류:", error);

      notice(
        error.message === "ALREADY_RENTED"
          ? "이미 다른 사용자가 대여한 물품입니다."
          : "대여에 실패했습니다. 다시 확인해 주세요.",
        true
      );
    } finally {
      button.disabled = false;
    }
  }
);

// 반납하기
async function returnLoan(loan, button) {
  if (
    !user ||
    loan.borrowerUid !== user.uid
  ) {
    return;
  }

  button.disabled = true;

  const equipmentRef = doc(
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
      async transaction => {
        const equipmentSnapshot =
          await transaction.get(equipmentRef);

        const loanSnapshot =
          await transaction.get(loanRef);

        if (
          !equipmentSnapshot.exists() ||
          !loanSnapshot.exists() ||
          equipmentSnapshot.data().activeLoanId !== loan.id ||
          loanSnapshot.data().status !== "active" ||
          loanSnapshot.data().borrowerUid !== user.uid
        ) {
          throw new Error("NOT_ACTIVE");
        }

        transaction.update(
          loanRef,
          {
            status: "returned",
            returnedAt: serverTimestamp()
          }
        );

        transaction.update(
          equipmentRef,
          {
            status: "available",
            activeLoanId: ""
          }
        );
      }
    );

    notice(
      "반납이 완료되었습니다! 기록도 보관됩니다."
    );
  } catch (error) {
    console.error("반납 오류:", error);

    notice(
      "반납에 실패했습니다. 다시 확인해 주세요.",
      true
    );
  } finally {
    button.disabled = false;
  }
}

// Firebase 로그인 상태 확인 및 실시간 데이터 연결
onAuthStateChanged(
  auth,
  currentUser => {
    if (stopEquipment) {
      stopEquipment();
      stopEquipment = null;
    }

    if (stopLoans) {
      stopLoans();
      stopLoans = null;
    }

    user = currentUser;
    equipment = [];
    myLoans = [];
    chosenId = null;

    equipmentLoaded = false;
    loansLoaded = false;
    scanHandled = false;

    $("rentPanel").hidden = true;
    $("equipmentTable").replaceChildren();
    $("myLoans").replaceChildren();

    $("loginScreen").hidden = !!currentUser;
    $("userApp").hidden = !currentUser;

    if (!currentUser) return;

    $("accountName").textContent =
      currentUser.email || "로그인됨";

    stopEquipment = onSnapshot(
      collection(db, "equipment"),
      snapshot => {
        equipment = snapshot.docs.map(
          itemDoc => ({
            id: itemDoc.id,
            ...itemDoc.data()
          })
        );

        equipmentLoaded = true;
        renderEquipment();
        renderLoans();
        handleScannedItem();
      },
      error => {
        console.error(
          "물품 조회 오류:",
          error
        );

        notice(
          "물품 목록을 불러오지 못했습니다.",
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
        myLoans = snapshot.docs.map(
          loanDoc => ({
            id: loanDoc.id,
            ...loanDoc.data()
          })
        );

        loansLoaded = true;
        renderLoans();
        handleScannedItem();
      },
      error => {
        console.error(
          "내 대여 기록 조회 오류:",
          error
        );

        notice(
          "내 대여 기록을 불러오지 못했습니다.",
          true
        );
      }
    );
  }
);
