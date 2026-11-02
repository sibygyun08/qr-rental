
(async function () {
  const { auth, db } = await import("./firebase-config.js");

  const { onAuthStateChanged } = await import(
    "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js"
  );

  const {
    collection,
    doc,
    getDoc,
    addDoc,
    deleteDoc,
    updateDoc,
    onSnapshot,
    runTransaction,
    serverTimestamp
  } = await import(
    "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js"
  );

  const $ = id => document.getElementById(id);

  // ========================================
  // QRental 물품 카테고리 설정
  // ========================================

  const CATEGORIES = [
    "노트북",
    "태블릿",
    "촬영 장비",
    "주변기기",
    "기타"
  ];

  let equipment = [];
  let loans = [];
  let profiles = [];

  let authenticated = false;
  let adminUid = null;

  let unsubEquipment = null;
  let unsubLoans = null;
  let unsubProfiles = null;

  let generation = 0;

  let equipmentLoaded = false;
  let loansLoaded = false;
  let profilesLoaded = false;

  // ========================================
  // 공통 함수
  // ========================================

  function notice(message, error = false) {
    $("adminNotice").textContent = message;
    $("adminNotice").className =
      error ? "notice error" : "notice success";
  }

  function cell(row, value) {
    const td = document.createElement("td");
    td.textContent =
      value == null ? "-" : String(value);

    row.appendChild(td);
    return td;
  }

  function dateValue(timestamp) {
    if (!timestamp?.toDate) return "-";

    return timestamp.toDate()
      .toLocaleDateString("ko-KR");
  }

  function personName(uid, email) {
    const profile = profiles.find(
      p => p.uid === uid
    );

    return profile
      ? `${profile.name} (${profile.email})`
      : email || uid || "-";
  }

  function categoryName(item) {
    const category =
      typeof item.category === "string"
        ? item.category.trim()
        : "";

    return category || "미분류";
  }

  function categorySelect(selected = "") {
    const select = document.createElement("select");

    select.style.padding = "10px";
    select.style.borderRadius = "8px";
    select.style.background = "#202936";
    select.style.color = "white";
    select.style.border = "1px solid #70829a";
    select.style.maxWidth = "100%";

    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "카테고리 선택";
    select.appendChild(empty);

    for (const category of CATEGORIES) {
      const option = document.createElement("option");
      option.value = category;
      option.textContent = category;

      select.appendChild(option);
    }

    // 기존 데이터에 사용자 정의 카테고리가 있을 경우 유지
    if (
      selected &&
      !CATEGORIES.includes(selected)
    ) {
      const old = document.createElement("option");
      old.value = selected;
      old.textContent = selected + " (기존)";
      select.appendChild(old);
    }

    select.value = selected;
    return select;
  }

  // ========================================
  // 대시보드 통계
  // ========================================

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
      x =>
        x.status === "active" &&
        x.dueDate < todayText
    ).length;

    $("totalCount").textContent = equipment.length;
    $("availableCount").textContent = available;
    $("rentedCount").textContent = rented;
    $("overdueCount").textContent = overdue;
  }

  // ========================================
  // 관리자 대리 반납
  // ========================================

  async function adminReturn(item, loan, button) {
    if (!authenticated || !adminUid) return;

    if (!loan || loan.status !== "active") {
      notice(
        "활성 대여 기록을 찾을 수 없습니다.",
        true
      );
      return;
    }

    const borrower = personName(
      loan.borrowerUid,
      loan.borrowerEmail
    );

    const confirmed = confirm(
      "관리자 대리 반납\n\n" +
      "물품: " + item.name + "\n" +
      "대여자: " + borrower + "\n\n" +
      "실제 물품을 회수했나요?\n\n" +
      "확인을 누르면 반납 완료로 처리됩니다."
    );

    if (!confirmed) return;

    const originalAdminUid = adminUid;

    const itemRef = doc(
      db,
      "equipment",
      item.id
    );

    const loanRef = doc(
      db,
      "loans",
      loan.id
    );

    button.disabled = true;

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
          loanDoc.data().itemId !== item.id
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

      if (
        authenticated &&
        adminUid === originalAdminUid
      ) {
        notice(
          item.name +
          " 관리자 대리 반납 완료! " +
          "대여 기록은 보관됩니다."
        );
      }

    } catch (error) {
      console.error(
        "관리자 대리 반납 오류:",
        error
      );

      if (error.message === "NOT_ACTIVE") {
        notice(
          "이미 반납됐거나 대여 상태가 변경됐습니다.",
          true
        );

      } else if (error.code === "permission-denied") {
        notice(
          "Firestore 규칙이 관리자 대리 반납을 " +
          "허용하지 않습니다.",
          true
        );

      } else {
        notice(
          "관리자 대리 반납에 실패했습니다.",
          true
        );
      }

    } finally {
      button.disabled = false;
    }
  }

  // ========================================
  // 기존 물품 카테고리 변경
  // ========================================

  async function changeCategory(
    item,
    select,
    button
  ) {
    if (!authenticated || !adminUid) return;

    const category = select.value;

    if (
      !category ||
      !CATEGORIES.includes(category)
    ) {
      notice(
        "변경할 카테고리를 선택해 주세요.",
        true
      );
      return;
    }

    if (category === item.category) {
      notice("이미 해당 카테고리입니다.");
      return;
    }

    const confirmed = confirm(
      item.name + " 물품의 카테고리를\n" +
      category + "(으)로 변경할까요?"
    );

    if (!confirmed) return;

    button.disabled = true;
    select.disabled = true;

    try {
      await updateDoc(
        doc(db, "equipment", item.id),
        { category }
      );

      notice(
        item.name +
        " 카테고리를 변경했어요."
      );

    } catch (error) {
      console.error(
        "카테고리 변경 오류:",
        error
      );

      notice(
        error.code === "permission-denied"
          ? "카테고리 변경은 새 Firestore " +
            "보안 규칙 적용 후 사용할 수 있어요."
          : "카테고리 변경에 실패했습니다.",
        true
      );

      select.value = item.category || "";

    } finally {
      button.disabled = false;
      select.disabled = false;
    }
  }

  // ========================================
  // 전체 물품 현황
  // ========================================

  function renderEquipment() {
    const table = $("adminItems");
    table.replaceChildren();

    const keyword = $("searchInput").value
      .trim()
      .toLowerCase();

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
        (item.name || "")
          .toLowerCase()
          .includes(keyword) ||

        (item.description || "")
          .toLowerCase()
          .includes(keyword) ||

        categoryName(item)
          .toLowerCase()
          .includes(keyword) ||

        borrower
          .toLowerCase()
          .includes(keyword)
      );
    });

    $("adminEmptyMessage").hidden =
      filtered.length > 0;

    for (const item of filtered) {
      const row = document.createElement("tr");

      const activeLoan = loans.find(
        x => x.id === item.activeLoanId
      );

      // 물품명 및 카테고리
      const nameCell = cell(row, item.name);

      const categoryLabel =
        document.createElement("div");

      categoryLabel.className = "hint";
      categoryLabel.textContent =
        "카테고리: " + categoryName(item);

      nameCell.appendChild(categoryLabel);

      if (item.description) {
        const description =
          document.createElement("div");

        description.className = "hint";
        description.textContent =
          item.description;

        nameCell.appendChild(description);
      }

      // 상태
      cell(
        row,
        item.status === "available"
          ? "대여 가능"
          : "대여 중"
      );

      // 대여자
      cell(
        row,
        activeLoan
          ? personName(
              activeLoan.borrowerUid,
              activeLoan.borrowerEmail
            )
          : "-"
      );

      // 대여일
      cell(
        row,
        activeLoan
          ? dateValue(activeLoan.borrowedAt)
          : "-"
      );

      // 반납예정일
      cell(
        row,
        activeLoan ? activeLoan.dueDate : "-"
      );

      const action = document.createElement("td");

      action.style.minWidth = "170px";

      // 기존 물품의 카테고리 지정
      const categoryControls =
        document.createElement("div");

      categoryControls.style.display = "grid";
      categoryControls.style.gap = "6px";
      categoryControls.style.marginBottom = "10px";

      const currentCategory =
        typeof item.category === "string"
          ? item.category
          : "";

      const select = categorySelect(
        currentCategory
      );

      const saveButton =
        document.createElement("button");

      saveButton.type = "button";
      saveButton.className = "button primary";
      saveButton.textContent = "카테고리 저장";

      saveButton.onclick = () => {
        changeCategory(
          item,
          select,
          saveButton
        );
      };

      categoryControls.append(
        select,
        saveButton
      );

      action.appendChild(categoryControls);

      // 기존 물품 삭제
      if (item.status === "available") {
        const button =
          document.createElement("button");

        button.type = "button";
        button.textContent = "삭제";
        button.className = "button danger";

        button.onclick = async () => {
          if (!authenticated) return;

          if (
            !confirm(
              item.name + "을(를) 삭제할까요?"
            )
          ) {
            return;
          }

          button.disabled = true;

          try {
            await deleteDoc(
              doc(db, "equipment", item.id)
            );

            notice("물품 삭제 완료");

          } catch (error) {
            console.error(error);
            notice(
              "물품 삭제 실패",
              true
            );

            button.disabled = false;
          }
        };

        action.appendChild(button);

      } else if (
        item.status === "rented" &&
        activeLoan &&
        activeLoan.status === "active"
      ) {
        const button =
          document.createElement("button");

        button.type = "button";
        button.textContent = "관리자 반납";
        button.className = "button primary";

        button.onclick = () => {
          adminReturn(
            item,
            activeLoan,
            button
          );
        };

        action.appendChild(button);

      } else {
        const info =
          document.createElement("div");

        info.textContent =
          "대여 정보 확인 필요";

        action.appendChild(info);
      }

      row.appendChild(action);
      table.appendChild(row);
    }

    renderCounts();
  }

  // ========================================
  // CSV 다운로드
  // ========================================

  function csvSafe(value) {
    let text = value == null
      ? ""
      : String(value);

    // 엑셀 수식 실행 방지
    if (/^\s*[=+\-@\t\r\n]/.test(text)) {
      text = "'" + text;
    }

    return '"' +
      text.replace(/"/g, '""') +
      '"';
  }

  function csvDate(timestamp) {
    if (!timestamp?.toDate) return "";

    const date = timestamp.toDate();

    if (Number.isNaN(date.getTime())) {
      return "";
    }

    const pad = value =>
      String(value).padStart(2, "0");

    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate())
    ].join("-") +
    " " +
    [
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds())
    ].join(":");
  }

  function exportLoanHistory() {
    if (!authenticated || !adminUid) {
      notice(
        "관리자로 로그인해야 다운로드할 수 있습니다.",
        true
      );
      return;
    }

    if (
      !loansLoaded ||
      !equipmentLoaded ||
      !profilesLoaded
    ) {
      notice(
        "데이터를 모두 불러온 다음 다시 시도해 주세요.",
        true
      );
      return;
    }

    if (loans.length === 0) {
      notice(
        "다운로드할 대여 기록이 없습니다.",
        true
      );
      return;
    }

    const rows = [[
      "대여기록ID",
      "물품ID",
      "물품명",
      "카테고리",
      "대여자이름",
      "대여자이메일",
      "대여자UID",
      "대여일시",
      "반납예정일",
      "실제반납일시",
      "상태"
    ]];

    const sorted = [...loans].sort(
      (a, b) =>
        (b.borrowedAt?.seconds || 0) -
        (a.borrowedAt?.seconds || 0)
    );

    for (const loan of sorted) {
      const item = equipment.find(
        x => x.id === loan.itemId
      );

      const profile = profiles.find(
        x => x.uid === loan.borrowerUid
      );

      rows.push([
        loan.id,
        loan.itemId,
        item?.name ||
          "(삭제되었거나 조회 불가한 물품)",
        item ? categoryName(item) : "미분류",
        profile?.name || "",
        loan.borrowerEmail ||
          profile?.email || "",
        loan.borrowerUid || "",
        csvDate(loan.borrowedAt),
        loan.dueDate || "",
        csvDate(loan.returnedAt),
        loan.status === "active"
          ? "대여 중"
          : loan.status === "returned"
            ? "반납 완료"
            : String(loan.status || "")
      ]);
    }

    const csv = "\uFEFF" +
      rows
        .map(
          row =>
            row.map(csvSafe).join(",")
        )
        .join("\r\n");

    const blob = new Blob(
      [csv],
      {
        type: "text/csv;charset=utf-8;"
      }
    );

    const url =
      URL.createObjectURL(blob);

    const anchor =
      document.createElement("a");

    const now = new Date();

    const pad = value =>
      String(value).padStart(2, "0");

    const filename =
      "QRental_대여기록_" +
      now.getFullYear() +
      pad(now.getMonth() + 1) +
      pad(now.getDate()) +
      ".csv";

    anchor.href = url;
    anchor.download = filename;

    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);

    notice(
      `대여 기록 ${loans.length}건을 CSV 파일로 저장했어요.`
    );
  }

  function createDownloadButton() {
    if ($("downloadLoansCsv")) return;

    const historyTable =
      $("historyTable");

    const historySection =
      historyTable?.closest(".panel");

    const historyHeader =
      historySection?.querySelector(
        ".section-title"
      );

    if (!historyHeader) {
      console.warn(
        "CSV 다운로드 버튼을 넣을 영역을 찾지 못했습니다."
      );
      return;
    }

    const button =
      document.createElement("button");

    button.type = "button";
    button.id = "downloadLoansCsv";
    button.className = "button primary";
    button.textContent =
      "⬇ 대여 기록 CSV 다운로드";

    button.disabled = true;

    button.addEventListener(
      "click",
      exportLoanHistory
    );

    historyHeader.appendChild(button);
  }

  function updateDownloadButton() {
    const button =
      $("downloadLoansCsv");

    if (!button) return;

    button.disabled =
      !authenticated ||
      !loansLoaded ||
      !equipmentLoaded ||
      !profilesLoaded ||
      loans.length === 0;
  }

  createDownloadButton();

  // ========================================
  // 대여 및 반납 기록
  // ========================================

  function renderHistory() {
    const table = $("historyTable");
    table.replaceChildren();

    const sorted = [...loans].sort(
      (a, b) =>
        (b.borrowedAt?.seconds || 0) -
        (a.borrowedAt?.seconds || 0)
    );

    $("historyEmpty").hidden =
      sorted.length > 0;

    for (const loan of sorted) {
      const row =
        document.createElement("tr");

      const item = equipment.find(
        x => x.id === loan.itemId
      );

      cell(
        row,
        item?.name || loan.itemId
      );

      cell(
        row,
        personName(
          loan.borrowerUid,
          loan.borrowerEmail
        )
      );

      cell(
        row,
        dateValue(loan.borrowedAt)
      );

      cell(row, loan.dueDate);

      cell(
        row,
        dateValue(loan.returnedAt)
      );

      cell(
        row,
        loan.status === "active"
          ? "대여 중"
          : "반납 완료"
      );

      table.appendChild(row);
    }
  }

  // ========================================
  // 직원 승인 및 계정 상태 관리
  // ========================================

  function renderProfiles() {
    const table = $("userTable");
    table.replaceChildren();

    const priority = {
      pending: 0,
      approved: 1,
      blocked: 2
    };

    const sorted = [...profiles].sort(
      (a, b) => {
        const pa =
          priority[a.status] ?? 3;

        const pb =
          priority[b.status] ?? 3;

        return (
          pa - pb ||
          (a.name || "").localeCompare(
            b.name || "",
            "ko"
          )
        );
      }
    );

    for (const profile of sorted) {
      const row =
        document.createElement("tr");

      const nameCell = cell(
        row,
        profile.name
      );

      const email =
        document.createElement("div");

      email.className = "hint";
      email.textContent = profile.email;

      nameCell.appendChild(email);

      const statusCell =
        document.createElement("td");

      const statusText =
        document.createElement("span");

      const button =
        document.createElement("button");

      button.type = "button";

      if (profile.status === "pending") {
        statusText.textContent =
          "승인 대기 ";

        button.textContent =
          "승인하기";

        button.className =
          "button primary";

      } else if (
        profile.status === "approved"
      ) {
        statusText.textContent =
          "✅ 이용 가능 ";

        button.textContent =
          "이용 중지";

        button.className =
          "button danger";

      } else if (
        profile.status === "blocked"
      ) {
        statusText.textContent =
          "⛔ 이용 중지 ";

        button.textContent =
          "재활성화";

        button.className =
          "button primary";

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
            " (" + profile.email + ")" +
            " 직원의 가입을 승인할까요?\n" +
            "직원 본인인지 확인한 경우에만 " +
            "승인해 주세요.";

          changes = {
            status: "approved",
            approvedAt: serverTimestamp()
          };

        } else if (
          profile.status === "approved"
        ) {
          message =
            profile.name +
            " 직원의 QRental 이용을 중지할까요?\n" +
            "중지하면 물품 조회와 대여가 차단됩니다.";

          if (activeCount > 0) {
            message +=
              "\n\n주의: 현재 대여 중인 물품 " +
              activeCount +
              "건이 있습니다. " +
              "실제 물품을 회수한 뒤 " +
              "관리자 반납으로 처리해 주세요.";
          }

          changes = {
            status: "blocked"
          };

        } else {
          message =
            profile.name +
            " 직원의 QRental 이용을 " +
            "다시 허용할까요?\n" +
            "이메일 인증도 완료되어 있어야 " +
            "이용할 수 있습니다.";

          changes = {
            status: "approved"
          };
        }

        if (!confirm(message)) return;

        button.disabled = true;

        try {
          await updateDoc(
            doc(
              db,
              "profiles",
              profile.uid
            ),
            changes
          );

          notice(
            profile.name +
            " 직원 상태 변경 완료"
          );

        } catch (error) {
          console.error(
            "직원 상태 변경 오류:",
            error
          );

          notice(
            "직원 상태 변경에 실패했습니다.",
            true
          );

          button.disabled = false;
        }
      };

      statusCell.append(
        statusText,
        button
      );

      row.appendChild(statusCell);
      table.appendChild(row);
    }
  }

  function refresh() {
    renderEquipment();
    renderHistory();
    renderProfiles();
    updateDownloadButton();
  }

  // ========================================
  // 물품 등록 시 카테고리 선택창 생성
  // ========================================

  function createRegistrationCategory() {
    if ($("itemCategory")) return;

    const form = $("itemForm");

    const label =
      document.createElement("label");

    label.textContent = "물품 카테고리";

    const select =
      categorySelect("");

    select.id = "itemCategory";
    select.name = "category";
    select.required = true;
    select.style.width = "100%";

    label.appendChild(select);

    const submitButton =
      form.querySelector(
        'button[type="submit"]'
      );

    form.insertBefore(
      label,
      submitButton
    );

    const hint =
      document.createElement("p");

    hint.className = "hint";
    hint.textContent =
      "카테고리 저장은 새 Firestore " +
      "보안 규칙 적용 후 사용할 수 있어요.";

    form.insertBefore(
      hint,
      submitButton
    );
  }

  createRegistrationCategory();

  // ========================================
  // 새 물품 등록
  // ========================================

  $("itemForm").addEventListener(
    "submit",
    async event => {
      event.preventDefault();

      if (!authenticated) return;

      const name =
        $("itemName").value.trim();

      const description =
        $("itemDescription").value.trim();

      const category =
        $("itemCategory").value;

      if (
        !name ||
        name.length > 80 ||
        description.length > 150 ||
        !CATEGORIES.includes(category)
      ) {
        notice(
          "물품 이름, 설명, 카테고리를 " +
          "확인해 주세요.",
          true
        );

        return;
      }

      const button =
        event.target.querySelector(
          'button[type="submit"]'
        );

      button.disabled = true;

      try {
        await addDoc(
          collection(db, "equipment"),
          {
            name,
            description,
            category,
            createdAt: serverTimestamp(),
            status: "available",
            activeLoanId: ""
          }
        );

        event.target.reset();

        notice(
          "물품이 등록됐어요! " +
          "QR코드 관리 화면에서 " +
          "확인할 수 있습니다."
        );

      } catch (error) {
        console.error(
          "물품 등록 오류:",
          error
        );

        notice(
          error.code === "permission-denied"
            ? "현재 Firestore 규칙에서는 " +
              "카테고리 저장을 허용하지 않습니다. " +
              "새 규칙 적용 후 다시 시도해 주세요."
            : "물품 등록에 실패했습니다.",
          true
        );

      } finally {
        button.disabled = false;
      }
    }
  );

  $("searchInput").addEventListener(
    "input",
    renderEquipment
  );

  // ========================================
  // Firebase 실시간 데이터 연결
  // ========================================

  function stopListeners() {
    if (unsubEquipment) {
      unsubEquipment();
    }

    if (unsubLoans) {
      unsubLoans();
    }

    if (unsubProfiles) {
      unsubProfiles();
    }

    unsubEquipment = null;
    unsubLoans = null;
    unsubProfiles = null;
  }

  onAuthStateChanged(
    auth,
    async user => {
      generation++;

      const currentGeneration =
        generation;

      stopListeners();

      authenticated = false;
      adminUid = null;

      equipment = [];
      loans = [];
      profiles = [];

      equipmentLoaded = false;
      loansLoaded = false;
      profilesLoaded = false;

      refresh();

      if (!user) return;

      try {
        const snapshot = await getDoc(
          doc(
            db,
            "admins",
            user.uid
          )
        );

        if (
          currentGeneration !== generation
        ) {
          return;
        }

        if (
          !snapshot.exists() ||
          snapshot.data().role !== "admin"
        ) {
          notice(
            "관리자 권한이 없습니다.",
            true
          );

          return;
        }

        authenticated = true;
        adminUid = user.uid;

        unsubEquipment = onSnapshot(
          collection(db, "equipment"),
          snapshot => {
            if (
              currentGeneration !== generation
            ) {
              return;
            }

            equipment =
              snapshot.docs.map(d => ({
                id: d.id,
                ...d.data()
              }));

            equipmentLoaded = true;
            refresh();
          },
          error => {
            console.error(
              "물품 조회 오류:",
              error
            );

            equipmentLoaded = false;
            updateDownloadButton();

            notice(
              "물품 목록 조회 실패",
              true
            );
          }
        );

        unsubLoans = onSnapshot(
          collection(db, "loans"),
          snapshot => {
            if (
              currentGeneration !== generation
            ) {
              return;
            }

            loans =
              snapshot.docs.map(d => ({
                id: d.id,
                ...d.data()
              }));

            loansLoaded = true;
            refresh();
          },
          error => {
            console.error(
              "대여 기록 오류:",
              error
            );

            loansLoaded = false;
            updateDownloadButton();

            notice(
              "대여 기록 조회 실패",
              true
            );
          }
        );

        unsubProfiles = onSnapshot(
          collection(db, "profiles"),
          snapshot => {
            if (
              currentGeneration !== generation
            ) {
              return;
            }

            profiles =
              snapshot.docs.map(d => ({
                id: d.id,
                ...d.data()
              }));

            profilesLoaded = true;
            refresh();
          },
          error => {
            console.error(
              "직원 목록 오류:",
              error
            );

            profilesLoaded = false;
            updateDownloadButton();

            notice(
              "직원 목록 조회 실패",
              true
            );
          }
        );

        notice(
          "QRental 관리자 데이터 연결 완료"
        );

      } catch (error) {
        console.error(
          "관리자 권한 확인 오류:",
          error
        );

        notice(
          "관리자 권한 확인 실패",
          true
        );
      }
    }
  );

})().catch(error => {
  console.error(
    "관리자 화면 초기화 실패:",
    error
  );
});
