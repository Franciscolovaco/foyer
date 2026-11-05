import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyAGIUmCq2Brg_X4d3ONCi1P2yESd06quH8",
  authDomain: "foyer-bourse.firebaseapp.com",
  databaseURL: "https://foyer-bourse-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "foyer-bourse",
  storageBucket: "foyer-bourse.firebasestorage.app",
  messagingSenderId: "1036825757284",
  appId: "1:1036825757284:web:43555fc57d6b69f4c7c171"
};

// Initialisation unique
const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);