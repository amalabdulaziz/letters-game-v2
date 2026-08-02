import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getDatabase, ref, set, update, onValue } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyCRerGp0Wfj7QoxzMNYnWX0zmtg1NAEBls",
  authDomain: "letters-game-ff80c.firebaseapp.com",
  databaseURL: "https://letters-game-ff80c-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "letters-game-ff80c",
  storageBucket: "letters-game-ff80c.appspot.com",
  messagingSenderId: "685369665098",
  appId: "1:685369665098:web:39620f12bd8a797a06a8b3"
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export { ref, set, update, onValue };
