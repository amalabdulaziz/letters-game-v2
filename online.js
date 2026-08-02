import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  getDatabase,
  ref,
  get,
  set,
  update,
  onValue,
  runTransaction
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

let app = null;
let auth = null;
let db = null;
let uid = "";

let roomCode = "";
let roomRef = null;
let unsubscribeRoom = null;
let onlineTimer = null;
let lastTimerBeep = -1;
let timerAudioContext = null;
let timerAudioUnlocked = false;
let finishingRoom = "";

window.onlineSlot = "";
window.onlineNames = { p1: "اللاعب 1", p2: "اللاعب 2" };


function unlockTimerAudio() {
  try {
    if (!timerAudioContext) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      timerAudioContext = new AudioCtx();
    }

    if (timerAudioContext.state === "suspended") {
      timerAudioContext.resume();
    }

    // نبضة صامتة لتفعيل الصوت في Safari من نفس ضغطة المستخدم.
    const oscillator = timerAudioContext.createOscillator();
    const gain = timerAudioContext.createGain();
    gain.gain.setValueAtTime(0.00001, timerAudioContext.currentTime);
    oscillator.connect(gain);
    gain.connect(timerAudioContext.destination);
    oscillator.start();
    oscillator.stop(timerAudioContext.currentTime + 0.02);
    timerAudioUnlocked = true;
  } catch (error) {
    console.warn("Audio unlock failed:", error);
  }
}

function playTimerBeep(remaining) {
  if (window.playerData && window.playerData.sound === false) return;

  try {
    if (!timerAudioContext || !timerAudioUnlocked) {
      unlockTimerAudio();
    }
    if (!timerAudioContext) return;

    if (timerAudioContext.state === "suspended") {
      timerAudioContext.resume();
    }

    const now = timerAudioContext.currentTime;
    const oscillator = timerAudioContext.createOscillator();
    const gain = timerAudioContext.createGain();

    oscillator.type = remaining <= 2 ? "square" : "sine";
    oscillator.frequency.setValueAtTime(
      remaining <= 2 ? 1450 : 1050,
      now
    );

    gain.gain.setValueAtTime(0.22, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.13);

    oscillator.connect(gain);
    gain.connect(timerAudioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.14);
  } catch (error) {
    // احتياط: استخدام صوت اللعبة الأصلي إن تعذر السياق المنفصل.
    if (typeof window.beep === "function") {
      window.beep(remaining <= 2 ? 1450 : 1050, "sine", 0.13, 0.22);
    }
  }
}

function status(text) {
  const box = document.getElementById("onlineStatusBox");
  const label = document.getElementById("onlineStatusText");
  if (box) box.hidden = false;
  if (label) label.textContent = text;
}

function setButtonsDisabled(value) {
  const create = document.getElementById("createRoomBtn");
  const join = document.getElementById("joinRoomBtn");
  if (create) create.disabled = value;
  if (join) join.disabled = value;
}

function showCode(code) {
  const view = document.getElementById("roomCodeView");
  const label = document.getElementById("roomCodeText");
  if (view) view.hidden = false;
  if (label) label.textContent = code;
}

function showPlayers(room) {
  const box = document.getElementById("onlinePlayers");
  if (!box) return;

  box.innerHTML = "";
  const people = [
    ["المضيف", room.host],
    ["الضيف", room.guest]
  ];

  people.forEach(([role, player]) => {
    const row = document.createElement("div");
    row.className = "onlinePlayerRow";
    row.textContent = player
      ? `${role}: ${player.name || "لاعب"} ✅`
      : `${role}: بانتظار اللاعب...`;
    box.appendChild(row);
  });
}

async function connectFirebase() {
  if (!window.playerData || !window.state) {
    throw new Error("لم تكتمل تهيئة اللعبة. حدّث الصفحة.");
  }

  if (!app) {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getDatabase(app);
  }

  if (!auth.currentUser) {
    const result = await signInAnonymously(auth);
    uid = result.user.uid;
  } else {
    uid = auth.currentUser.uid;
  }
}

function playerName() {
  return (window.playerData?.name || "لاعب").trim();
}

function randomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function freshGame(hostName, guestName) {
  const availableLetters = window.letters.filter(
    letter => !window.categoriesForLetter ||
      window.categoriesForLetter(letter).length > 0
  );

  return {
    mode: "online",
    diff: "normal",
    count: 2,
    time: 15,
    turn: "p1",
    status: "picking",
    round: 1,
    golden: window.rnd(availableLetters.length ? availableLetters : window.letters),
    used: {},
    scores: { p1: 0, p2: 0, p3: 0 },
    lives: { p1: 3, p2: 3, p3: 0 },
    currentL: "",
    cat: "",
    lastCat: "",
    timer: 15,
    deadline: 0,
    msg: `${hostName} اختر حرفاً`,
    winner: "",
    hostName,
    guestName,
    startedAt: Date.now()
  };
}

function isMyTurn(game) {
  return game.turn === window.onlineSlot;
}

function stopListening() {
  if (unsubscribeRoom) {
    unsubscribeRoom();
    unsubscribeRoom = null;
  }
  clearInterval(onlineTimer);
  onlineTimer = null;
}

function copyGameIntoLocal(game) {
  const local = window.state;
  Object.keys(local).forEach(key => delete local[key]);
  Object.assign(local, game, { mode: "online", count: 2 });
}

function enterOnlineGame(room) {
  if (!room?.game) return;

  window.onlineNames = {
    p1: room.host?.name || room.game.hostName || "اللاعب 1",
    p2: room.guest?.name || room.game.guestName || "اللاعب 2"
  };

  copyGameIntoLocal(room.game);

  const p3 = document.getElementById("p3Area");
  if (p3) p3.style.display = "none";

  if (!document.getElementById("letters").children.length) {
    window.buildLetters();
  }

  document.getElementById("onlineLobbyModal")?.classList.remove("show");
  const badge = document.getElementById("onlineBadge");
  if (badge) badge.hidden = false;

  window.show("game");
  window.render();
  window.onlineStartTimer();

  if (room.game.status === "ended" && room.game.winner) {
    finishOnline(room.game.winner);
  }
}

async function ensureGameExists(code, room) {
  if (!room?.host || !room?.guest) return;

  const gameRef = ref(db, `rooms/${code}/game`);
  await runTransaction(gameRef, current => {
    if (current) return current;
    return freshGame(room.host.name, room.guest.name);
  });

  await update(ref(db, `rooms/${code}`), {
    status: "playing",
    updatedAt: Date.now()
  });
}

function listenToRoom(code) {
  stopListening();

  roomCode = code;
  roomRef = ref(db, `rooms/${code}`);

  unsubscribeRoom = onValue(
    roomRef,
    async snapshot => {
      const room = snapshot.val();

      if (!room) {
        status("الغرفة غير موجودة أو انتهت.");
        return;
      }

      showCode(code);
      showPlayers(room);

      window.onlineNames = {
        p1: room.host?.name || "اللاعب 1",
        p2: room.guest?.name || "اللاعب 2"
      };

      if (!room.guest) {
        status("بانتظار دخول اللاعب الثاني...");
        return;
      }

      if (!room.game) {
        status("تم اتصال اللاعبين، جاري بدء المباراة...");
        try {
          await ensureGameExists(code, room);
        } catch (error) {
          status("تعذر بدء المباراة: " + error.message);
        }
        return;
      }

      status("تم اتصال اللاعبين ✅");
      enterOnlineGame(room);
    },
    error => status("خطأ في الاتصال: " + error.message)
  );
}

window.openOnlineLobby = async function () {
  unlockTimerAudio();
  document.getElementById("onlineLobbyModal")?.classList.add("show");
  const view = document.getElementById("roomCodeView");
  if (view) view.hidden = true;
  const players = document.getElementById("onlinePlayers");
  if (players) players.innerHTML = "";

  status("جاري الاتصال...");
  try {
    await connectFirebase();
    status("جاهز لإنشاء غرفة أو الدخول.");
  } catch (error) {
    status("تعذر الاتصال: " + error.message);
  }
};

window.closeOnlineLobby = function () {
  document.getElementById("onlineLobbyModal")?.classList.remove("show");
};

window.createOnlineRoom = async function () {
  unlockTimerAudio();
  setButtonsDisabled(true);

  try {
    await connectFirebase();
    status("جاري إنشاء الغرفة...");

    let code = "";

    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = randomCode();
      const candidateRef = ref(db, `rooms/${candidate}`);
      const snapshot = await get(candidateRef);

      if (!snapshot.exists()) {
        await set(candidateRef, {
          status: "waiting",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          host: {
            uid,
            name: playerName(),
            joinedAt: Date.now()
          }
        });
        code = candidate;
        break;
      }
    }

    if (!code) throw new Error("تعذر إنشاء كود، حاول مرة أخرى.");

    window.onlineSlot = "p1";
    showCode(code);
    listenToRoom(code);
  } catch (error) {
    status("تعذر إنشاء الغرفة: " + error.message);
  } finally {
    setButtonsDisabled(false);
  }
};

window.joinOnlineRoom = async function () {
  unlockTimerAudio();
  setButtonsDisabled(true);

  try {
    await connectFirebase();

    const input = document.getElementById("roomCodeInput");
    const code = (input?.value || "").replace(/\D/g, "").slice(0, 6);

    if (code.length !== 6) {
      throw new Error("اكتب كود الغرفة المكوّن من 6 أرقام.");
    }

    status("جاري دخول الغرفة...");
    const targetRoomRef = ref(db, `rooms/${code}`);
    const roomSnapshot = await get(targetRoomRef);

    if (!roomSnapshot.exists()) {
      throw new Error("الغرفة غير موجودة.");
    }

    const room = roomSnapshot.val();

    if (room.status === "ended") {
      throw new Error("انتهت هذه الغرفة.");
    }

    const guestRef = ref(db, `rooms/${code}/guest`);
    const result = await runTransaction(guestRef, current => {
      if (current && current.uid !== uid) return;
      return {
        uid,
        name: playerName(),
        joinedAt: Date.now()
      };
    });

    if (!result.committed) {
      throw new Error("الغرفة ممتلئة بلاعبين.");
    }

    window.onlineSlot = "p2";
    await update(targetRoomRef, {
      status: "ready",
      updatedAt: Date.now()
    });

    showCode(code);
    listenToRoom(code);

    const latest = (await get(targetRoomRef)).val();
    await ensureGameExists(code, latest);
  } catch (error) {
    status("تعذر دخول الغرفة: " + error.message);
  } finally {
    setButtonsDisabled(false);
  }
};

window.copyOnlineRoomCode = async function () {
  try {
    await navigator.clipboard.writeText(roomCode);
    window.toast("تم نسخ الكود ✅");
  } catch {
    window.toast("كود الغرفة: " + roomCode);
  }
};

function advanceTurn(game) {
  game.turn = game.turn === "p1" ? "p2" : "p1";
  game.status = "picking";
  game.currentL = "";
  game.cat = "";
  game.round = (game.round || 1) + 1;
  game.time = game.round % 7 === 0 ? 6 : 15;
  game.timer = game.time;
  game.deadline = 0;
  game.msg = `${window.onlineNames[game.turn] || "اللاعب"} اختر حرفاً`;

  const allUsed = window.letters.every(letter => game.used?.[letter]);
  if (allUsed) {
    game.used = {};
    game.golden = window.rnd(window.letters);
  }
}

function checkEnd(game) {
  const alive = ["p1", "p2"].filter(player => (game.lives[player] || 0) > 0);

  if (alive.length <= 1) {
    game.status = "ended";
    game.winner = alive[0] ||
      ((game.scores.p1 || 0) >= (game.scores.p2 || 0) ? "p1" : "p2");
    game.deadline = 0;
    return true;
  }

  return false;
}

window.onlinePick = async function (letter) {
  if (!roomCode) return;

  const gameRef = ref(db, `rooms/${roomCode}/game`);
  const result = await runTransaction(gameRef, game => {
    if (
      !game ||
      game.status !== "picking" ||
      game.turn !== window.onlineSlot ||
      game.used?.[letter]
    ) return;

    game.used = game.used || {};
    game.used[letter] = true;
    game.currentL = letter;
    game.cat = window.chooseCategoryForLetter(letter);
    game.lastCat = game.cat;
    game.status = "answering";
    game.timer = game.time || 15;
    game.deadline = Date.now() + game.timer * 1000;
    game.msg =
      `${window.onlineNames[game.turn]} | ${game.cat} بحرف (${letter})`;

    return game;
  });

  if (!result.committed) {
    window.toast("ليس دورك الآن");
    return;
  }

  // نفس صوت اختيار الحرف في اللعب ضد روبو
  if (typeof window.beep === "function") {
    window.beep(620, "triangle", 0.12, 0.10);
  }
};

window.onlineSubmitAnswer = async function () {
  if (!roomCode) return;

  const input = document.getElementById("answer");
  const answer = (input?.value || "").trim();
  if (!answer) return;

  const currentGame = window.state;
  const isCorrect = window
    .getWords(currentGame.cat, currentGame.currentL)
    .some(word => window.norm(word) === window.norm(answer));

  let awardedCorrect = false;
  let awardedGolden = false;

  const gameRef = ref(db, `rooms/${roomCode}/game`);
  const result = await runTransaction(gameRef, game => {
    if (
      !game ||
      game.status !== "answering" ||
      game.turn !== window.onlineSlot
    ) return;

    if (isCorrect) {
      const points = game.currentL === game.golden ? 2 : 1;
      game.scores[game.turn] = (game.scores[game.turn] || 0) + points;
      game.msg = "✅ إجابة صحيحة: " + answer;
      awardedCorrect = true;
      awardedGolden = game.currentL === game.golden;
    } else {
      game.lives[game.turn] = Math.max(0, (game.lives[game.turn] || 0) - 1);
      game.msg = "❌ إجابة غير صحيحة";
    }

    if (!checkEnd(game)) advanceTurn(game);
    return game;
  });

  if (input) input.value = "";

  if (!result.committed) {
    window.toast("انتهى الدور أو ليست هذه جولتك");
    return;
  }

  if (awardedCorrect) {
    window.playerData.correctAnswers =
      (window.playerData.correctAnswers || 0) + 1;
    window.addXP(10, "إجابة صحيحة");

    if (awardedGolden) {
      window.playerData.golden =
        (window.playerData.golden || 0) + 1;
      window.playerData.coins =
        (window.playerData.coins || 0) + 20;
      window.addXP(20, "حرف ذهبي");
    }

    window.savePlayer();
    window.checkAchievements();
  }
};

window.onlineStartTimer = function () {
  clearInterval(onlineTimer);
  lastTimerBeep = -1;

  if (
    window.state.status !== "answering" ||
    !window.state.deadline
  ) return;

  const tick = () => {
    const remaining = Math.max(
      0,
      Math.ceil((window.state.deadline - Date.now()) / 1000)
    );

    window.state.timer = remaining;

    // نفس تنبيه اللعب ضد روبو عند 3، 2، 1
    if (
      remaining <= 3 &&
      remaining > 0 &&
      remaining !== lastTimerBeep
    ) {
      lastTimerBeep = remaining;

      if (typeof window.beep === "function") {
        window.beep(
          remaining === 1 ? 1450 : 1050,
          "sine",
          0.13,
          0.16
        );
      } else {
        playTimerBeep(remaining);
      }

      try { navigator.vibrate?.(45); } catch (e) {}
    }

    window.render();

    if (remaining <= 0) {
      clearInterval(onlineTimer);
      lastTimerBeep = -1;
      if (isMyTurn(window.state)) handleTimeout();
    }
  };

  tick();
  onlineTimer = setInterval(tick, 500);
};

async function handleTimeout() {
  if (!roomCode) return;

  const gameRef = ref(db, `rooms/${roomCode}/game`);
  await runTransaction(gameRef, game => {
    if (
      !game ||
      game.status !== "answering" ||
      game.turn !== window.onlineSlot ||
      Date.now() < game.deadline - 300
    ) return;

    game.lives[game.turn] = Math.max(0, (game.lives[game.turn] || 0) - 1);
    game.msg = "⏰ انتهى الوقت!";

    if (!checkEnd(game)) advanceTurn(game);
    return game;
  });
}

function finishOnline(winner) {
  if (finishingRoom === roomCode) return;
  finishingRoom = roomCode;
  clearInterval(onlineTimer);

  const won = winner === window.onlineSlot;
  window.playerData.games = (window.playerData.games || 0) + 1;

  const myScore = window.state.scores[window.onlineSlot] || 0;
  window.playerData.highScore = Math.max(
    window.playerData.highScore || 0,
    myScore
  );

  if (won) {
    window.playerData.wins = (window.playerData.wins || 0) + 1;
    window.playerData.coins = (window.playerData.coins || 0) + 50;
    window.addXP(100, "فوز أونلاين");
  }

  window.savePlayer();
  window.checkAchievements();
  window.show("end");

  document.getElementById("winnerText").textContent =
    "👑 الفائز: " + (window.onlineNames[winner] || winner);

  document.getElementById("finalScore").textContent =
    `${window.onlineNames.p1}: ${window.state.scores.p1 || 0} | ` +
    `${window.onlineNames.p2}: ${window.state.scores.p2 || 0}`;

  window.fireworks();
}

window.leaveOnlineRoom = function () {
  stopListening();
  const badge = document.getElementById("onlineBadge");
  if (badge) badge.hidden = true;

  roomCode = "";
  roomRef = null;
  window.onlineSlot = "";
  finishingRoom = "";
};


// تهيئة احتياطية للصوت من أول لمسة أو نقرة.
document.addEventListener("pointerdown", unlockTimerAudio, { once: true, passive: true });
document.addEventListener("touchstart", unlockTimerAudio, { once: true, passive: true });
