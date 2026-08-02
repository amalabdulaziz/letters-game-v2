import { db, ref, set, update, onValue } from "./firebase-config.js";

window.connectOnlineMatch = function() {
  console.log("Connecting to Firebase Online Match...");
  window.startGame('online', 2);
};
