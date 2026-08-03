import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  getDatabase,
  ref,
  get,
  set,
  update,
  onValue,
  runTransaction,
  onDisconnect
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
let activeGameId = "";
let presenceDisconnect = null;
let disconnectNoticeTimer = null;
let startingGame = false;

const ONLINE_NORMAL_TIME = 20;
const ONLINE_SETTINGS_VERSION = 642;

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

function status(text, loading=false) {
  const box = document.getElementById("onlineStatusBox");
  const label = document.getElementById("onlineStatusText");
  const spinner = document.getElementById("onlineSpinner");
  if (box) box.hidden = false;
  if (label) label.textContent = text;
  if (spinner) spinner.hidden = !loading;
}

function showDisconnectNotice(show, text="⚠️ انقطع اتصال اللاعب الآخر") {
  const notice = document.getElementById("connectionNotice");
  if (!notice) return;
  notice.textContent = text;
  notice.classList.toggle("show", !!show);
}

function playWinSound(won) {
  if (typeof window.beep !== "function") return;
  if (won) {
    window.beep(900, "triangle", .16, .14);
    setTimeout(()=>window.beep(1200, "triangle", .18, .14), 170);
    setTimeout(()=>window.beep(1550, "triangle", .24, .16), 350);
  } else {
    window.beep(430, "sine", .20, .12);
    setTimeout(()=>window.beep(320, "sine", .28, .12), 210);
  }
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
    time: ONLINE_NORMAL_TIME,
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
    timer: ONLINE_NORMAL_TIME,
    deadline: 0,
    msg: `${hostName} اختر حرفاً`,
    winner: "",
    swaps: { p1: 1, p2: 1 },
    settingsVersion: ONLINE_SETTINGS_VERSION,
    hostName,
    guestName,
    startedAt: Date.now(),
    gameId: "g_" + Date.now() + "_" + Math.random().toString(36).slice(2,8)
  };
}

function isMyTurn(game) {
  return game.turn === window.onlineSlot;
}


async function setMyPresence(slot, onlineState=true) {
  if (!db || !roomCode || !slot) return;
  const presenceRef = ref(db, `rooms/${roomCode}/presence/${slot}`);
  await set(presenceRef, {
    online: onlineState,
    uid,
    updatedAt: Date.now()
  });

  if (onlineState) {
    presenceDisconnect = onDisconnect(presenceRef);
    await presenceDisconnect.set({
      online: false,
      uid,
      updatedAt: Date.now()
    });
  }
}

function otherSlot() {
  return window.onlineSlot === "p1" ? "p2" : "p1";
}

function updateConnectionState(room) {
  if (!room?.guest || !window.onlineSlot) {
    showDisconnectNotice(false);
    return;
  }

  const other = room.presence?.[otherSlot()];
  if (other && other.online === false) {
    showDisconnectNotice(true);
  } else {
    showDisconnectNotice(false);
  }
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


async function normalizeOnlineGame(code, room) {
  if (!room?.game) return room;

  const game = room.game;
  const needsFix =
    game.settingsVersion !== ONLINE_SETTINGS_VERSION ||
    !game.swaps ||
    ((game.round || 1) % 7 !== 0 && game.time !== ONLINE_NORMAL_TIME);

  if (!needsFix) return room;

  const result = await runTransaction(
    ref(db, `rooms/${code}/game`),
    current => {
      if (!current) return;

      current.swaps = current.swaps || { p1: 1, p2: 1 };
      if (typeof current.swaps.p1 !== "number") current.swaps.p1 = 1;
      if (typeof current.swaps.p2 !== "number") current.swaps.p2 = 1;

      const lightning = (current.round || 1) % 7 === 0;
      if (!lightning) {
        current.time = ONLINE_NORMAL_TIME;
        current.timer = ONLINE_NORMAL_TIME;
        current.deadline = current.status === "answering"
          ? Date.now() + ONLINE_NORMAL_TIME * 1000
          : 0;
      }

      current.settingsVersion = ONLINE_SETTINGS_VERSION;
      return current;
    }
  );

  if (result.committed) {
    return { ...room, game: result.snapshot.val() };
  }
  return room;
}

function enterOnlineGame(room) {
  if (!room?.game) return;

  const incomingGameId =
    room.game.gameId || String(room.game.startedAt || "");
  const isNewGame = activeGameId !== incomingGameId;

  // عند ضغط لاعب واحد على إعادة اللعب يتغير rematch فقط،
  // فلا نعيد فتح شاشة المباراة المنتهية القديمة.
  if (room.game.status === "ended" && !isNewGame) {
    updateConnectionState(room);
    return;
  }

  if (isNewGame) {
    activeGameId = incomingGameId;
    finishingRoom = "";
    clearInterval(onlineTimer);
    lastTimerBeep = -1;
  }

  updateConnectionState(room);

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

  const restartButton = document.querySelector('#end .btn.green');
  if (restartButton) {
    restartButton.disabled = false;
    restartButton.textContent = "إعادة اللعب مع نفس الصديق";
  }

  window.show("game");
  window.render();
  window.onlineStartTimer();

  if (room.game.status === "ended" && room.game.winner) {
    finishOnline(room.game.winner);
  }
}

async function ensureGameExists(code) {
  if (startingGame) return null;
  startingGame = true;

  try {
    const targetRef = ref(db, `rooms/${code}`);

    const result = await runTransaction(targetRef, room => {
      if (!room || !room.host || !room.guest) return;

      if (!room.game) {
        room.game = freshGame(
          room.host.name || "اللاعب 1",
          room.guest.name || "اللاعب 2"
        );
      }

      room.status = "playing";
      room.updatedAt = Date.now();
      return room;
    });

    if (!result.committed) return null;
    return result.snapshot.val();
  } finally {
    startingGame = false;
  }
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
      updateConnectionState(room);

      window.onlineNames = {
        p1: room.host?.name || "اللاعب 1",
        p2: room.guest?.name || "اللاعب 2"
      };

      if (!room.guest) {
        status("بانتظار دخول اللاعب الثاني...", true);
        return;
      }

      if (!room.game) {
        status("تم اتصال اللاعبين، جاري بدء المباراة...", true);

        try {
          const startedRoom = await ensureGameExists(code);

          if (startedRoom?.game) {
            status("تم اتصال اللاعبين ✅");
            enterOnlineGame(startedRoom);
          }
        } catch (error) {
          status("تعذر بدء المباراة: " + error.message);
        }
        return;
      }

      room = await normalizeOnlineGame(code, room);
      status("تم اتصال اللاعبين ✅");

      const incomingGameId =
        room.game.gameId || String(room.game.startedAt || "");

      if (
        room.game.status === "ended" &&
        activeGameId === incomingGameId
      ) {
        updateConnectionState(room);
        return;
      }

      enterOnlineGame(room);
    },
    error => status("خطأ في الاتصال: " + error.message)
  );

  // فحص احتياطي لـ Safari إذا تأخر حدث Realtime.
  setTimeout(async () => {
    try {
      if (!roomRef || roomCode !== code) return;
      const latest = (await get(roomRef)).val();

      if (latest?.host && latest?.guest && !latest?.game) {
        const startedRoom = await ensureGameExists(code);
        if (startedRoom?.game) enterOnlineGame(startedRoom);
      } else if (latest?.game) {
        enterOnlineGame(latest);
      }
    } catch (e) {
      console.warn("Online start fallback:", e);
    }
  }, 4000);

}

window.openOnlineLobby = async function () {
  unlockTimerAudio();
  document.getElementById("onlineLobbyModal")?.classList.add("show");
  const view = document.getElementById("roomCodeView");
  if (view) view.hidden = true;
  const players = document.getElementById("onlinePlayers");
  if (players) players.innerHTML = "";

  status("جاري الاتصال...", true);
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
    status("جاري إنشاء الغرفة...", true);

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
    await setMyPresence("p1", true);
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

    status("جاري دخول الغرفة...", true);
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
    await setMyPresence("p2", true);

    const latest = (await get(targetRoomRef)).val();
    const startedRoom = await ensureGameExists(code);
    if (startedRoom?.game) enterOnlineGame(startedRoom);
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
  game.time = game.round % 7 === 0 ? 6 : ONLINE_NORMAL_TIME;
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


window.onlineSwapLetter = async function () {
  if (!roomCode || !window.onlineSlot) return;

  const result = await runTransaction(
    ref(db, `rooms/${roomCode}/game`),
    game => {
      if (
        !game ||
        game.status !== "answering" ||
        game.turn !== window.onlineSlot ||
        (game.swaps?.[game.turn] || 0) <= 0
      ) return;

      const available = window.letters.filter(letter =>
        !game.used?.[letter] &&
        (!window.categoriesForLetter ||
          window.categoriesForLetter(letter).length > 0)
      );

      if (!available.length) return;

      game.swaps = game.swaps || { p1: 1, p2: 1 };
      game.swaps[game.turn]--;

      const newLetter = window.rnd(available);
      game.used = game.used || {};
      game.used[newLetter] = true;
      game.currentL = newLetter;
      game.cat = window.chooseCategoryForLetter(newLetter);
      game.lastCat = game.cat;
      game.timer = game.time || ONLINE_NORMAL_TIME;
      game.deadline = Date.now() + game.timer * 1000;
      game.msg =
        `🔄 ${window.onlineNames[game.turn]} استبدل الحرف | ` +
        `${game.cat} بحرف (${newLetter})`;

      return game;
    }
  );

  if (!result.committed) {
    window.toast("لا يمكن استبدال الحرف الآن");
    return;
  }

  if (typeof window.beep === "function") {
    window.beep(760, "triangle", .14, .12);
  }
  window.toast("تم استبدال الحرف ✅");
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

    // تنبيه آخر خمس ثوانٍ في اللعب الأونلاين
    if (
      remaining <= 5 &&
      remaining > 0 &&
      remaining !== lastTimerBeep
    ) {
      lastTimerBeep = remaining;

      if (typeof window.beep === "function") {
        const frequency =
          remaining === 1 ? 1500 :
          remaining === 2 ? 1350 :
          remaining === 3 ? 1200 : 1000;
        window.beep(frequency, "sine", 0.13, 0.16);
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
  playWinSound(won);
}


window.requestOnlineRematch = async function () {
  if (!roomCode || !roomRef || !window.onlineSlot) {
    window.toast("تعذر إعادة المباراة");
    return;
  }

  const restartButton = document.querySelector('#end .btn.green');
  if (restartButton?.disabled) return;

  if (restartButton) {
    restartButton.disabled = true;
    restartButton.textContent = "⏳ بانتظار اللاعب الآخر...";
  }

  unlockTimerAudio();

  try {
    const slot = window.onlineSlot;

    const result = await runTransaction(roomRef, room => {
      if (!room || !room.host || !room.guest || !room.game) return;

      room.rematchVotes = room.rematchVotes || {};
      room.rematchVotes[slot] = {
        uid,
        requestedAt: Date.now()
      };
      room.updatedAt = Date.now();

      if (room.rematchVotes.p1 && room.rematchVotes.p2) {
        room.game = freshGame(room.host.name, room.guest.name);
        room.status = "playing";
        room.rematchVotes = {};
        room.updatedAt = Date.now();
      }

      return room;
    });

    if (!result.committed) {
      throw new Error("تعذر حفظ طلب إعادة اللعب");
    }

    const updatedRoom = result.snapshot.val();

    if (
      updatedRoom?.game?.status !== "ended" &&
      updatedRoom?.game?.gameId !== activeGameId
    ) {
      enterOnlineGame(updatedRoom);
      return;
    }

    const score = document.getElementById("finalScore");
    if (score) {
      score.innerHTML =
        `${window.onlineNames.p1}: ${window.state.scores.p1 || 0} | ` +
        `${window.onlineNames.p2}: ${window.state.scores.p2 || 0}` +
        `<div class="rematchWaiting">⏳ بانتظار موافقة اللاعب الآخر...</div>`;
    }

    window.toast("تم إرسال طلب إعادة المباراة");
  } catch (error) {
    if (restartButton) {
      restartButton.disabled = false;
      restartButton.textContent = "إعادة اللعب مع نفس الصديق";
    }
    window.toast("خطأ: " + error.message);
  }
};

window.leaveOnlineRoom = async function () {
  try {
    if (roomCode && window.onlineSlot) {
      await setMyPresence(window.onlineSlot, false);
    }
  } catch (e) {}

  stopListening();
  showDisconnectNotice(false);

  const badge = document.getElementById("onlineBadge");
  if (badge) badge.hidden = true;

  roomCode = "";
  roomRef = null;
  window.onlineSlot = "";
  finishingRoom = "";
  activeGameId = "";
};


// تهيئة احتياطية للصوت من أول لمسة أو نقرة.
document.addEventListener("pointerdown", unlockTimerAudio, { once: true, passive: true });
document.addEventListener("touchstart", unlockTimerAudio, { once: true, passive: true });
