
(async function () {
  const { auth, db } = await import("./firebase-config.js");

  const { onAuthStateChanged } = await import(
    "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js"
  );

  const {
    collection, doc, getDoc, addDoc, deleteDoc,
    updateDoc, onSnapshot, serverTimestamp
  } = await import(
    "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js"
  );

  const $ = id => document.getElementById(id);

  let equipment = [];
  let loans = [];
  let profiles = [];
  let authenticated = false;

  let unsubEquipment = null;
  let unsubLoans = null;
  let unsubProfiles = null;
  let generation = 0;

  function notice(message, error = false) {
    $("adminNotice").textContent = message;
    $("adminNotice").className =
      error ? "notice error" : "notice success";
  }

  function cell(row, value) {
    const td = document.createElement("td");
    td.textContent = value == null ? "-" : String(value);
    row.appendChild(td);
    return td;
  }

  function dateValue(timestamp) {
    if (!timestamp?.toDate) return "-";
    return timestamp.toDate().toLocaleDateString("ko-KR");
  }

  function personName(uid, email) {
    const profile = profiles.find(p => p.uid === uid);
    return profile
      ? `${profile.name} (${profile.email})`
      : email || uid || "-";
  }

  function renderCounts() {
    const available = equipment.filter(
      x => x.status === "available"
    ).length;

    const rented = equipment.filter(
      x => x.status === "rented"
    ).length;

    const today = new Date();
    const todayText = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, "0"),
      String(today.getDate()).padStart(2, "0")
    ].join("-");

    const overdue = loans.filter(
      x => x.status === "active" &&
      x.dueDate < todayText
    ).length;

    $("totalCount").textContent = equipment.length;
    $("availableCount").textContent = available;
    $("rentedCount").textContent = rented;
    $("overdueCount").textContent = overdue;
  }

  function renderEquipment() {
    const table = $("adminItems");
    table.replaceChildren();

    const keyword = $("searchInput").value
      .trim().toLowerCase();

    const filtered = equipment.filter(item => {
      const activeLoan = loans.find(
        loan => loan.id === item.activeLoanId
      );

      const borrower = activeLoan
        ? personName(
            activeLoan.borrowerUid,
            activeLoan.borrowerEmail
          )
        : "";

      return (
        (item.name || "").toLowerCase().includes(keyword) ||
        (item.description || "").toLowerCase().includes(keyword) ||
        borrower.toLowerCase().includes(keyword)
      );
    });

    $("adminEmptyMessage").hidden = filtered.length > 0;

    for (const item of filtered) {
      const row = document.createElement("tr");

      const activeLoan = loans.find(
        x => x.id === item.activeLoanId
      );

      const nameCell = cell(row, item.name);

      if (item.description) {
        const description = document.createElement("div");
        description.className = "hint";
        description.textContent = item.description;
        nameCell.appendChild(description);
      }

      cell(
        row,
        item.status === "available"
          ? "대여 가능"
          : "대여 중"
      );

      cell(
        row,
        activeLoan
          ? personName(
              activeLoan.borrowerUid,
              activeLoan.borrowerEmail
            )
          : "-"
      );

      cell(
        row,
        activeLoan
          ? dateValue(activeLoan.borrowedAt)
          : "-"
      );

      cell(row, activeLoan ? activeLoan.dueDate : "-");

      const action = document.createElement("td");

      if (item.status === "available") {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "삭제";
        button.className = "button danger";

        button.onclick = async () => {
          if (!authenticated) return;
          if (!confirm(item.name + "을(를) 삭제할까요?")) return;

          button.disabled = true;

          try {
            await deleteDoc(doc(db, "equipment", item.id));
            notice("물품 삭제 완료");
          } catch (error) {
            console.error(error);
            notice("물품 삭제 실패", true);
            button.disabled = false;
          }
        };

        action.appendChild(button);
      } else {
        action.textContent = "대여 중";
      }

      row.appendChild(action);
      table.appendChild(row);
    }

    renderCounts();
  }

  function renderHistory() {
    const table = $("historyTable");
    table.replaceChildren();

    const sorted = [...loans].sort(
      (a, b) =>
        (b.borrowedAt?.seconds || 0) -
        (a.borrowedAt?.seconds || 0)
    );

    $("historyEmpty").hidden = sorted.length > 0;

    for (const loan of sorted) {
      const row = document.createElement("tr");

      const item = equipment.find(
        x => x.id === loan.itemId
      );

      cell(row, item?.name || loan.itemId);

      cell(
        row,
        personName(
          loan.borrowerUid,
          loan.borrowerEmail
        )
      );

      cell(row, dateValue(loan.borrowedAt));
      cell(row, loan.dueDate);
      cell(row, dateValue(loan.returnedAt));

      cell(
        row,
        loan.status === "active"
          ? "대여 중"
          : "반납 완료"
      );

      table.appendChild(row);
    }
  }

  // 직원 승인, 이용 중지, 재활성화
  function renderProfiles() {
    const table = $("userTable");
    table.replaceChildren();

    const priority = {
      pending: 0,
      approved: 1,
      blocked: 2
    };

    const sorted = [...profiles].sort((a, b) => {
      const pa = priority[a.status] ?? 3;
      const pb = priority[b.status] ?? 3;

      return pa - pb ||
        (a.name || "").localeCompare(
          b.name || "", "ko"
        );
    });

    for (const profile of sorted) {
      const row = document.createElement("tr");

      const nameCell = cell(row, profile.name);

      const email = document.createElement("div");
      email.className = "hint";
      email.textContent = profile.email;
      nameCell.appendChild(email);

      const statusCell = document.createElement("td");
      const statusText = document.createElement("span");

      const button = document.createElement("button");
      button.type = "button";

      if (profile.status === "pending") {
        statusText.textContent = "승인 대기 ";
        button.textContent = "승인하기";
        button.className = "button primary";

      } else if (profile.status === "approved") {
        statusText.textContent = "✅ 이용 가능 ";
        button.textContent = "이용 중지";
        button.className = "button danger";

      } else if (profile.status === "blocked") {
        statusText.textContent = "⛔ 이용 중지 ";
        button.textContent = "재활성화";
        button.className = "button primary";

      } else {
        statusCell.textContent =
          "알 수 없는 상태: " +
          String(profile.status);

        row.appendChild(statusCell);
        table.appendChild(row);
        continue;
      }

      button.onclick = async () => {
        if (!authenticated) return;

        const activeCount = loans.filter(
          loan =>
            loan.borrowerUid === profile.uid &&
            loan.status === "active"
        ).length;

        let message = "";
        let changes = null;

        if (profile.status === "pending") {
          message =
            profile.name +
            " (" + profile.email + ") 직원의 가입을 승인할까요?\n" +
            "직원 본인인지 확인한 경우에만 승인해 주세요.";

          changes = {
            status: "approved",
            approvedAt: serverTimestamp()
          };

        } else if (profile.status === "approved") {
          message =
            profile.name +
            " 직원의 QRental 이용을 중지할까요?\n" +
            "중지하면 물품 조회와 대여가 차단됩니다.";

          if (activeCount > 0) {
            message +=
              "\n\n주의: 현재 대여 중인 물품 " +
              activeCount +
              "건이 있습니다. 이용 중지 후에는 " +
              "관리자가 물품 회수 및 반납을 처리해야 합니다.";
          }

          changes = { status: "blocked" };

        } else {
          message =
            profile.name +
            " 직원의 QRental 이용을 다시 허용할까요?\n" +
            "이메일 인증도 완료되어 있어야 이용할 수 있습니다.";

          changes = { status: "approved" };
        }

        if (!confirm(message)) return;

        button.disabled = true;

        try {
          await updateDoc(
            doc(db, "profiles", profile.uid),
            changes
          );

          notice(profile.name + " 직원 상태 변경 완료");

        } catch (error) {
          console.error("직원 상태 변경 실패:", error);

          notice(
            "직원 상태 변경에 실패했습니다.",
            true
          );

          button.disabled = false;
        }
      };

      statusCell.append(statusText, button);
      row.appendChild(statusCell);
      table.appendChild(row);
    }
  }

  function refresh() {
    renderEquipment();
    renderHistory();
    renderProfiles();
  }

  // 물품 등록
  $("itemForm").addEventListener(
    "submit",
    async event => {
      event.preventDefault();
      if (!authenticated) return;

      const name = $("itemName").value.trim();

      const description =
        $("itemDescription").value.trim();

      if (
        !name ||
        name.length > 80 ||
        description.length > 150
      ) {
        notice(
          "물품 이름과 설명을 확인해 주세요.",
          true
        );
        return;
      }

      const button = event.target.querySelector(
        'button[type="submit"]'
      );

      button.disabled = true;

      try {
        await addDoc(collection(db, "equipment"), {
          name,
          description,
          createdAt: serverTimestamp(),
          status: "available",
          activeLoanId: ""
        });

        event.target.reset();
        notice("물품이 Firebase에 등록됐어요!");

      } catch (error) {
        console.error(error);
        notice("물품 등록 실패", true);

      } finally {
        button.disabled = false;
      }
    }
  );

  $("searchInput").addEventListener(
    "input",
    renderEquipment
  );

  // 예전 PIN 등록 기능 비활성화
  $("userForm").addEventListener(
    "submit",
    event => event.preventDefault()
  );

  $("userForm").querySelectorAll(
    "input, button"
  ).forEach(input => {
    input.disabled = true;
  });

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent =
    "이제 직원이 사용자 화면에서 직접 가입합니다. " +
    "승인은 아래 등록된 사용자 목록에서 처리해 주세요.";

  $("userForm").after(hint);

  function stopListeners() {
    if (unsubEquipment) unsubEquipment();
    if (unsubLoans) unsubLoans();
    if (unsubProfiles) unsubProfiles();

    unsubEquipment = null;
    unsubLoans = null;
    unsubProfiles = null;
  }

  onAuthStateChanged(auth, async user => {
    generation++;
    const currentGeneration = generation;

    stopListeners();
    authenticated = false;

    equipment = [];
    loans = [];
    profiles = [];
    refresh();

    if (!user) return;

    try {
      const snapshot = await getDoc(
        doc(db, "admins", user.uid)
      );

      if (currentGeneration !== generation) return;

      if (
        !snapshot.exists() ||
        snapshot.data().role !== "admin"
      ) {
        notice("관리자 권한이 없습니다.", true);
        return;
      }

      authenticated = true;

      unsubEquipment = onSnapshot(
        collection(db, "equipment"),
        snapshot => {
          if (currentGeneration !== generation) return;

          equipment = snapshot.docs.map(d => ({
            id: d.id,
            ...d.data()
          }));

          refresh();
        },
        error => {
          console.error("물품 조회 오류:", error);
          notice("물품 목록 조회 실패", true);
        }
      );

      unsubLoans = onSnapshot(
        collection(db, "loans"),
        snapshot => {
          if (currentGeneration !== generation) return;

          loans = snapshot.docs.map(d => ({
            id: d.id,
            ...d.data()
          }));

          refresh();
        },
        error => {
          console.error("대여 기록 오류:", error);
          notice("대여 기록 조회 실패", true);
        }
      );

      unsubProfiles = onSnapshot(
        collection(db, "profiles"),
        snapshot => {
          if (currentGeneration !== generation) return;

          profiles = snapshot.docs.map(d => ({
            id: d.id,
            ...d.data()
          }));

          refresh();
        },
        error => {
          console.error("직원 목록 오류:", error);
          notice("가입 신청 목록 조회 실패", true);
        }
      );

      notice("QRental 관리자 데이터 연결 완료");

    } catch (error) {
      console.error(error);
      notice("관리자 권한 확인 실패", true);
    }
  });

})().catch(error => {
  console.error("관리자 화면 초기화 실패:", error);
});
