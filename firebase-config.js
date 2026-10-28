
import { initializeApp } from
  "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";

import { getAuth } from
  "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";

import { getFirestore } from
  "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";

// Firebase 프로젝트 설정
const firebaseConfig = {
  apiKey: "AIzaSyBOTbyxBuYblA8ARNWsxu9LEc_Fil1u8xg",
  authDomain: "qr-rental-system-6df07.firebaseapp.com",
  projectId: "qr-rental-system-6df07",
  storageBucket: "qr-rental-system-6df07.firebasestorage.app",
  messagingSenderId: "96976087198",
  appId: "1:96976087198:web:e6f4b3f32fd849607f338f"
};

// Firebase 시작
const app = initializeApp(firebaseConfig);

// 로그인 서비스
export const auth = getAuth(app);

// 데이터베이스 서비스
export const db = getFirestore(app);

console.log("QRental Firebase 연결 초기화 완료!");
