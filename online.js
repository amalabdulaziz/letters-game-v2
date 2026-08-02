import { db, ref, set, update, onValue } from "./firebase-config.js";
import { getRandomLetter, getBotWord } from "./dictionary.js";

const TURN_TIME_LIMIT = 20;

let gameMode = "online";
let currentRoomId = null;
let playerRole = "player1";
let timerInterval = null;
let roomDataCache = null;

const lobbySection = document.getElementById("lobbySection");
const statusHeader = document.getElementById("statusHeader");
const roomStatusText = document.getElementById("roomStatusText");
const playerRoleBadge = document.getElementById("playerRoleBadge");
const scoreBoard = document.getElementById("scoreBoard");
const p1NameLabel = document.getElementById("p1NameLabel");
const p2NameLabel = document.getElementById("p2NameLabel");
const p1Score = document.getElementById("p1Score");
const p2Score = document.getElementById("p2Score");
const timerDisplay = document.getElementById("timerDisplay");
const gamePlayArea = document.getElementById("gamePlayArea");
const currentLetterDisplay = document.getElementById("currentLetterDisplay");
const wordInput = document.getElementById("wordInput");
const submitWordBtn = document.getElementById("submitWordBtn");
const turnIndicator = document.getElementById("turnIndicator");
const historyList = document.getElementById("historyList");

export function startBotGame(playerName) {
  gameMode = "bot";
  playerRole = "player1";
  setupUIForGame();
  
  playerRoleBadge.innerText = "(ضد الروبوت 🤖)";
  p1NameLabel.innerText = playerName || "أنت";
  p2NameLabel.innerText = "الروبوت 🤖";
  
  roomDataCache = {
    status: "playing",
    currentTurn: "player1",
    currentLetter: getRandomLetter(),
    player1: { name: playerName || "أنت", score: 0 },
    player2: { name: "الروبوت 🤖", score: 0 },
    history: []
  };

  updateLocalBotUI();
  startLocalTimer();
}

function updateLocalBotUI() {
  p1Score.innerText = roomDataCache.player1.score;
  p2Score.innerText = roomDataCache.player2.score;
  currentLetterDisplay.innerText = roomDataCache.currentLetter;

  const isMyTurn = roomDataCache.currentTurn === "player1";
  roomStatusText.innerText = isMyTurn ? "دورك الآن!" : "الروبوت يفكر...";
  turnIndicator.innerText = isMyTurn ? "اكتب كلمة مناسبة قبل انتهاء الوقت!" : "جاري انتظار إجابة الروبوت...";

  if (isMyTurn) {
    gamePlayArea.classList.remove("disabled-area");
    wordInput.focus();
  } else {
    gamePlayArea.classList.add("disabled-area");
    setTimeout(playBotTurn, 2000);
  }

  updateHistoryUI(roomDataCache.history);
}

function playBotTurn() {
  if (gameMode !== "bot" || roomDataCache.currentTurn !== "player2") return;

  const letter = roomDataCache.currentLetter;
  const botAnswer = getBotWord(letter);

  roomDataCache.player2.score += 10;
  roomDataCache.history.unshift({
    player: "الروبوت 🤖",
    word: botAnswer,
    score: "+10"
  });

  roomDataCache.currentTurn = "player1";
  roomDataCache.currentLetter = getRandomLetter();

  updateLocalBotUI();
  startLocalTimer();
}

function startLocalTimer() {
  clearInterval(timerInterval);
  let timeLeft = TURN_TIME_LIMIT;
  timerDisplay.innerText = timeLeft;

  timerInterval = setInterval(() => {
    timeLeft--;
    timerDisplay.innerText = timeLeft;

    if (timeLeft <= 0) {
      clearInterval(timerInterval);
      roomDataCache.currentTurn = roomDataCache.currentTurn === "player1" ? "player2" : "player1";
      roomDataCache.currentLetter = getRandomLetter();
      updateLocalBotUI();
      startLocalTimer();
    }
  }, 1000);
}

export function createRoom(roomId, playerName) {
  gameMode = "online";
  currentRoomId = roomId;
  playerRole = "player1";

  const initialLetter = getRandomLetter();
  const roomRef = ref(db, "rooms/" + roomId);

  set(roomRef, {
    status: "waiting",
    currentTurn: "player1",
    currentLetter: initialLetter,
    turnDeadline: 0,
    player1: { name: playerName, score: 0 },
    player2: { name: "", score: 0 },
    history: []
  }).then(() => {
    setupUIForGame();
    listenToRoomUpdates(roomId);
  }).catch((err) => {
    alert("خطأ في الاتصال بـ Firebase: " + err.message);
  });
}

export function joinRoom(roomId, playerName) {
  gameMode = "online";
  currentRoomId = roomId;
  playerRole = "player2";

  const roomRef = ref(db, "rooms/" + roomId);

  update(roomRef, {
    status: "playing",
    "player2/name": playerName,
    turnDeadline: Date.now() + TURN_TIME_LIMIT * 1000
  }).then(() => {
    setupUIForGame();
    listenToRoomUpdates(roomId);
  }).catch((err) => {
    alert("تعذر الانضمام للغرفة: " + err.message);
  });
}

function listenToRoomUpdates(roomId) {
  const roomRef = ref(db, "rooms/" + roomId);

  onValue(roomRef, (snapshot) => {
    const data = snapshot.val();
    if (!data) return;

    roomDataCache = data;

    p1NameLabel.innerText = data.player1.name || "اللاعب 1";
    p2NameLabel.innerText = data.player2.name || "اللاعب 2";
    p1Score.innerText = data.player1.score || 0;
    p2Score.innerText = data.player2.score || 0;
    currentLetterDisplay.innerText = data.currentLetter || "أ";

    if (data.status === "waiting") {
      roomStatusText.innerText = "في انتظار انضمام المنافس...";
      gamePlayArea.classList.add("disabled-area");
    } else if (data.status === "playing") {
      const isMyTurn = data.currentTurn === playerRole;
      roomStatusText.innerText = isMyTurn ? "دورك الآن!" : "دور المنافس...";
      turnIndicator.innerText = isMyTurn ? "اكتب كلمة مناسبة قبل انتهاء الوقت!" : "انتظار إجابة المنافس...";

      if (isMyTurn) {
        gamePlayArea.classList.remove("disabled-area");
        wordInput.focus();
      } else {
        gamePlayArea.classList.add("disabled-area");
      }

      handleOnlineTimer(data.turnDeadline);
    }

    updateHistoryUI(data.history);
  });
}

function handleOnlineTimer(deadline) {
  clearInterval(timerInterval);
  if (!deadline) return;

  function updateTimer() {
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    timerDisplay.innerText = remaining;

    if (remaining <= 0) {
      clearInterval(timerInterval);
      if (roomDataCache && roomDataCache.currentTurn === playerRole) {
        const nextTurn = playerRole === "player1" ? "player2" : "player1";
        const roomRef = ref(db, "rooms/" + currentRoomId);
        update(roomRef, {
          currentTurn: nextTurn,
          currentLetter: getRandomLetter(),
          turnDeadline: Date.now() + TURN_TIME_LIMIT * 1000
        });
      }
    }
  }

  updateTimer();
  timerInterval = setInterval(updateTimer, 1000);
}

function setupUIForGame() {
  lobbySection.style.display = "none";
  statusHeader.style.display = "flex";
  scoreBoard.style.display = "flex";
  gamePlayArea.style.display = "flex";
  playerRoleBadge.innerText = playerRole === "player1" ? "(اللاعب الأول)" : "(اللاعب الثاني)";
}

function submitWord() {
  const word = wordInput.value.trim();
  if (!word) return;

  const requiredLetter = roomDataCache.currentLetter;
  if (word[0] !== requiredLetter) {
    alert(`الكلمة يجب أن تبدأ بحرف (${requiredLetter})`);
    return;
  }

  if (gameMode === "bot") {
    roomDataCache.player1.score += 10;
    roomDataCache.history.unshift({
      player: roomDataCache.player1.name,
      word: word,
      score: "+10"
    });
    roomDataCache.currentTurn = "player2";
    roomDataCache.currentLetter = getRandomLetter();
    wordInput.value = "";
    updateLocalBotUI();
    startLocalTimer();
  } else {
    const roomRef = ref(db, "rooms/" + currentRoomId);
    const nextTurn = playerRole === "player1" ? "player2" : "player1";
    const nextLetter = getRandomLetter();
    const currentScore = roomDataCache[playerRole].score || 0;

    const history = roomDataCache.history || [];
    history.unshift({
      player: roomDataCache[playerRole].name,
      word: word,
      score: "+10"
    });

    const updates = {
      currentTurn: nextTurn,
      currentLetter: nextLetter,
      turnDeadline: Date.now() + TURN_TIME_LIMIT * 1000,
      history: history
    };
    updates[`${playerRole}/score`] = currentScore + 10;

    update(roomRef, updates).then(() => {
      wordInput.value = "";
    });
  }
}

function updateHistoryUI(historyArray) {
  if (!historyArray) {
    historyList.innerHTML = "<div style='text-align:center; color:#94a3b8;'>لا توجد كلمات سابقة</div>";
    return;
  }
  historyList.innerHTML = historyArray.map(item => `
    <div class="history-item">
      <span><strong>${item.player}:</strong> ${item.word}</span>
      <span style="color: #10b981; font-weight: bold;">${item.score}</span>
    </div>
  `).join("");
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("createRoomBtn")?.addEventListener("click", () => {
    const roomCode = document.getElementById("roomIdInput").value.trim();
    const name = document.getElementById("playerNameInput").value.trim() || "لاعب 1";
    if (roomCode) createRoom(roomCode, name);
    else alert("يرجى إدخال رمز الغرفة");
  });

  document.getElementById("joinRoomBtn")?.addEventListener("click", () => {
    const roomCode = document.getElementById("roomIdInput").value.trim();
    const name = document.getElementById("playerNameInput").value.trim() || "لاعب 2";
    if (roomCode) joinRoom(roomCode, name);
    else alert("يرجى إدخال رمز الغرفة");
  });

  document.getElementById("playBotBtn")?.addEventListener("click", () => {
    const name = document.getElementById("playerNameInput").value.trim() || "أنت";
    startBotGame(name);
  });

  submitWordBtn?.addEventListener("click", submitWord);
  wordInput?.addEventListener("keypress", (e) => {
    if (e.key === "Enter") submitWord();
  });
});
