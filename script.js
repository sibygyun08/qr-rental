
const initialItems = [
  { id: "001", name: "노트북 A", borrower: "" },
  { id: "002", name: "빔프로젝터", borrower: "" },
  { id: "003", name: "테스트폰", borrower: "" }
];

// 저장된 정보가 있으면 불러오기
const saved = localStorage.getItem("rentalItems");
let items = saved ? JSON.parse(saved) : initialItems;

// URL의 물품번호 확인
const params = new URLSearchParams(window.location.search);
const itemId = params.get("id") || "001";

function currentItem() {
  return items.find(item => item.id === itemId);
}

// 데이터 저장
function saveItems() {
  localStorage.setItem("rentalItems", JSON.stringify(items));
}

// 대여하기
function rentItem() {
  const name = document.getElementById("username").value.trim();
  const item = currentItem();

  if (!item) return;

  if (!name) {
    alert("이름을 입력해 주세요!");
    return;
  }

  if (item.borrower) {
    alert("이미 대여 중인 물품입니다.");
    return;
  }

  item.borrower = name;
  saveItems();
  updateScreen();
  alert("대여가 완료되었습니다!");
}

// 반납하기
function returnItem() {
  const name = document.getElementById("username").value.trim();
  const item = currentItem();

  if (!item || !item.borrower) return;

  if (name !== item.borrower) {
    alert("대여할 때 입력한 이름을 입력해 주세요.");
    return;
  }

  item.borrower = "";
  saveItems();
  updateScreen();
  alert("반납이 완료되었습니다!");
}

// 화면 갱신
function updateScreen() {
  const item = currentItem();
  const table = document.getElementById("itemTable");

  table.replaceChildren();

  items.forEach(data => {
    const row = document.createElement("tr");

    [data.name,
     data.borrower ? "대여 중" : "대여 가능",
     data.borrower || "-"].forEach(value => {
       const cell = document.createElement("td");
       cell.textContent = value;
       row.appendChild(cell);
     });

    table.appendChild(row);
  });

  if (!item) {
    document.getElementById("itemName").textContent =
      "물품을 찾을 수 없습니다";
    document.getElementById("message").textContent =
      "물품번호를 확인해 주세요.";
    document.getElementById("rentBtn").disabled = true;
    document.getElementById("returnBtn").disabled = true;
    return;
  }

  document.getElementById("itemName").textContent = item.name;
  document.getElementById("itemId").textContent = item.id;

  document.getElementById("status").textContent =
    item.borrower ? "대여 중" : "대여 가능";

  document.getElementById("borrowerInfo").textContent =
    item.borrower ? "대여자: " + item.borrower : "";

  document.getElementById("rentBtn").disabled =
    Boolean(item.borrower);

  document.getElementById("returnBtn").disabled =
    !item.borrower;
}

updateScreen();
