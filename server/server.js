"use strict";
/**
 * THAGAPPA — online multiplayer backend
 * Node + Express + Socket.IO, fully in-memory (no database).
 * Deployable on Railway with: npm install && npm start
 *
 * Game rule mirrors the offline 1v1 mode: each ball, BOTH players pick a
 * number 1-10 simultaneously. If they match, the batting player is out.
 * Otherwise the batting player scores their own number. Overs limit and a
 * single wicket per innings (team size is always 1 online) bound each innings.
 */

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "*"; // tighten to your Netlify URL in production

const BALLS_PER_OVER = 6;
const QUICK_MATCH_TIMEOUT_MS = 15 * 1000;
const CREATE_ROOM_TIMEOUT_MS = 2 * 60 * 1000;
const DISCONNECT_GRACE_MS = 30 * 1000;
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars

/* ============================= APP / SERVER ============================= */
const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.get("/", (req, res) => {
  res.json({ ok: true, service: "thagappa-server", rooms: Object.keys(rooms).length });
});
app.get("/health", (req, res) => res.send("ok"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CLIENT_ORIGIN, methods: ["GET", "POST"] },
});

/* ============================= STATE (IN-MEMORY ONLY) ============================= */
const rooms = {};          // code -> room
const matchmakingQueue = []; // [{ socketId, overs, timer }]
const socketToRoom = {};   // socketId -> room code (fast lookup on disconnect)

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]
    ).join("");
  } while (rooms[code]);
  return code;
}

function makeToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function otherRole(role) {
  return role === "p1" ? "p2" : "p1";
}

function newRoom(code, overs) {
  return {
    code,
    overs,
    maxBalls: overs * BALLS_PER_OVER,
    players: {}, // role -> { socketId, token, name, connected, disconnectTimer }
    createRoomTimer: null,
    match: null, // set when toss/match begins
    rematchVotes: {},
  };
}

function roleOfSocket(room, socketId) {
  if (room.players.p1 && room.players.p1.socketId === socketId) return "p1";
  if (room.players.p2 && room.players.p2.socketId === socketId) return "p2";
  return null;
}

function roomIsFull(room) {
  return !!(room.players.p1 && room.players.p2);
}

function emitToRole(room, role, event, payload) {
  const p = room.players[role];
  if (p && p.connected) io.to(p.socketId).emit(event, payload);
}
function emitToRoom(room, event, payload) {
  emitToRole(room, "p1", event, payload);
  emitToRole(room, "p2", event, payload);
}

function destroyRoom(code) {
  const room = rooms[code];
  if (!room) return;
  ["p1", "p2"].forEach((role) => {
    const p = room.players[role];
    if (p) {
      if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
      delete socketToRoom[p.socketId];
    }
  });
  if (room.createRoomTimer) clearTimeout(room.createRoomTimer);
  delete rooms[code];
}

/* ============================= MATCH ENGINE ============================= */
function startToss(room) {
  room.match = {
    phase: "toss",
    innings: 1,
    battingIs: null,
    scoreP1: 0, scoreP2: 0,
    wktP1: 0, wktP2: 0,
    ballsThisInnings: 0,
    target: null,
    log: [],
    picks: { p1: null, p2: null },
    callerRole: Math.random() < 0.5 ? "p1" : "p2",
    tossWinnerRole: null,
  };
  room.rematchVotes = {};
  const callerRole = room.match.callerRole;
  emitToRole(room, callerRole, "tossCallRequest", {});
  emitToRole(room, otherRole(callerRole), "tossWaitingForOpponentCall", {
    callerName: room.players[callerRole].name,
  });
}

function stateForRole(room, role) {
  const m = room.match;
  if (!m) return null;
  const you = role, opp = otherRole(role);
  return {
    phase: m.phase,
    innings: m.innings,
    youBatting: m.battingIs === you,
    scoreYou: m[`score${you === "p1" ? "P1" : "P2"}`],
    scoreOpp: m[`score${opp === "p1" ? "P1" : "P2"}`],
    wktYou: m[`wkt${you === "p1" ? "P1" : "P2"}`],
    wktOpp: m[`wkt${opp === "p1" ? "P1" : "P2"}`],
    ballsThisInnings: m.ballsThisInnings,
    maxBalls: room.maxBalls,
    overs: room.overs,
    target: m.target,
    opponentName: room.players[opp] ? room.players[opp].name : "Opponent",
  };
}

function beginInnings(room, battingRole) {
  const m = room.match;
  m.phase = "batting";
  m.battingIs = battingRole;
  m.ballsThisInnings = 0;
  m.log = [];
  m.picks = { p1: null, p2: null };
}

function resolveBall(room) {
  const m = room.match;
  const battingRole = m.battingIs;
  const bowlingRole = otherRole(battingRole);
  const battingN = m.picks[battingRole];
  const bowlingN = m.picks[bowlingRole];
  const out = battingN === bowlingN;
  const runs = battingN;

  m.ballsThisInnings += 1;
  if (out) {
    if (battingRole === "p1") m.wktP1 += 1; else m.wktP2 += 1;
  } else {
    if (battingRole === "p1") m.scoreP1 += runs; else m.scoreP2 += runs;
  }
  m.log.push({ out, runs, battingRole });
  m.picks = { p1: null, p2: null };

  const battingScore = battingRole === "p1" ? m.scoreP1 : m.scoreP2;
  const battingWkt = battingRole === "p1" ? m.wktP1 : m.wktP2;

  emitToRoom(room, "ballResult", {
    battingRole, out, runs,
    p1: { n: battingRole === "p1" ? battingN : bowlingN },
    p2: { n: battingRole === "p2" ? battingN : bowlingN },
    stateP1: stateForRole(room, "p1"),
    stateP2: stateForRole(room, "p2"),
  });

  // chase completed mid-over
  if (m.innings === 2 && !out && battingScore >= m.target) {
    return endMatch(room);
  }

  const allOut = battingWkt >= 1; // team size is always 1 online
  const oversUp = m.ballsThisInnings >= room.maxBalls;

  if (allOut || oversUp) {
    if (m.innings === 1) {
      m.innings = 2;
      m.target = battingScore + 1;
      const nextBatter = otherRole(battingRole);
      beginInnings(room, nextBatter);
      emitToRoom(room, "inningsBreak", {
        target: m.target,
        allOut,
        stateP1: stateForRole(room, "p1"),
        stateP2: stateForRole(room, "p2"),
      });
    } else {
      endMatch(room);
    }
  }
}

function endMatch(room) {
  const m = room.match;
  let winnerRole;
  if (m.battingIs === "p1") {
    winnerRole = m.scoreP1 >= m.target ? "p1" : "p2";
  } else {
    winnerRole = m.scoreP2 >= m.target ? "p2" : "p1";
  }
  m.phase = "finished";
  emitToRole(room, "p1", "matchEnd", { youWon: winnerRole === "p1", stateP1: stateForRole(room, "p1") });
  emitToRole(room, "p2", "matchEnd", { youWon: winnerRole === "p2", stateP2: stateForRole(room, "p2") });
}

/* ============================= SOCKET HANDLERS ============================= */
io.on("connection", (socket) => {

  socket.on("quickMatch", ({ name, overs }) => {
    const safeOvers = Math.min(20, Math.max(1, parseInt(overs, 10) || 2));
    const safeName = (name || "Player").toString().slice(0, 18);

    if (matchmakingQueue.length > 0) {
      const waiting = matchmakingQueue.shift();
      clearTimeout(waiting.timer);
      const code = generateRoomCode();
      const room = newRoom(code, waiting.overs);
      rooms[code] = room;

      room.players.p1 = { socketId: waiting.socketId, token: makeToken(), name: waiting.name, connected: true };
      room.players.p2 = { socketId: socket.id, token: makeToken(), name: safeName, connected: true };
      socketToRoom[waiting.socketId] = code;
      socketToRoom[socket.id] = code;

      emitToRole(room, "p1", "matchFound", { code, you: "p1", token: room.players.p1.token, opponentName: safeName, overs: room.overs });
      emitToRole(room, "p2", "matchFound", { code, you: "p2", token: room.players.p2.token, opponentName: room.players.p1.name, overs: room.overs });
      startToss(room);
      return;
    }

    const entry = { socketId: socket.id, name: safeName, overs: safeOvers, timer: null };
    entry.timer = setTimeout(() => {
      const idx = matchmakingQueue.findIndex((e) => e.socketId === socket.id);
      if (idx !== -1) matchmakingQueue.splice(idx, 1);
      io.to(socket.id).emit("quickMatchTimeout");
    }, QUICK_MATCH_TIMEOUT_MS);
    matchmakingQueue.push(entry);
    socket.emit("quickMatchWaiting");
  });

  socket.on("cancelQuickMatch", () => {
    const idx = matchmakingQueue.findIndex((e) => e.socketId === socket.id);
    if (idx !== -1) {
      clearTimeout(matchmakingQueue[idx].timer);
      matchmakingQueue.splice(idx, 1);
    }
  });

  socket.on("createRoom", ({ name, overs }) => {
    const safeOvers = Math.min(20, Math.max(1, parseInt(overs, 10) || 2));
    const safeName = (name || "Player").toString().slice(0, 18);
    const code = generateRoomCode();
    const room = newRoom(code, safeOvers);
    rooms[code] = room;
    const token = makeToken();
    room.players.p1 = { socketId: socket.id, token, name: safeName, connected: true };
    socketToRoom[socket.id] = code;

    room.createRoomTimer = setTimeout(() => {
      if (!roomIsFull(room)) {
        emitToRole(room, "p1", "createRoomTimeout", {});
      }
    }, CREATE_ROOM_TIMEOUT_MS);

    socket.emit("roomCreated", { code, token, overs: safeOvers });
  });

  socket.on("joinRoom", ({ name, code }) => {
    const safeName = (name || "Player").toString().slice(0, 18);
    const room = rooms[(code || "").toUpperCase()];
    if (!room) return socket.emit("roomError", { message: "Room not found." });
    if (roomIsFull(room)) return socket.emit("roomError", { message: "Room is already full." });

    const token = makeToken();
    room.players.p2 = { socketId: socket.id, token, name: safeName, connected: true };
    socketToRoom[socket.id] = room.code;
    if (room.createRoomTimer) clearTimeout(room.createRoomTimer);

    emitToRole(room, "p1", "opponentJoined", { opponentName: safeName });
    socket.emit("roomJoined", { code: room.code, token, you: "p2", opponentName: room.players.p1.name, overs: room.overs });
    // also give p1 its info so both sides know match is starting
    emitToRole(room, "p1", "matchFound", { code: room.code, you: "p1", token: room.players.p1.token, opponentName: safeName, overs: room.overs });
    startToss(room);
  });

  socket.on("cancelWaiting", ({ code }) => {
    const room = rooms[(code || "").toUpperCase()];
    if (room && !roomIsFull(room)) destroyRoom(room.code);
  });

  socket.on("tossCall", ({ code, call }) => {
    const room = rooms[code]; if (!room || !room.match) return;
    const m = room.match;
    if (m.phase !== "toss") return;
    const role = roleOfSocket(room, socket.id);
    if (!role || role !== m.callerRole) return; // only the assigned caller may call
    if (call !== "heads" && call !== "tails") return;
    const result = Math.random() < 0.5 ? "heads" : "tails";
    const callerWon = call === result;
    m.tossWinnerRole = callerWon ? m.callerRole : otherRole(m.callerRole);
    emitToRoom(room, "tossResult", {
      result, callerWon,
      callerName: room.players[m.callerRole].name,
      tossWinnerName: room.players[m.tossWinnerRole].name,
    });
    emitToRole(room, m.tossWinnerRole, "chooseBatBowl", {});
  });

  socket.on("tossChoice", ({ code, choice }) => {
    const room = rooms[code]; if (!room || !room.match) return;
    const m = room.match;
    if (m.phase !== "toss") return;
    const role = roleOfSocket(room, socket.id);
    if (!role || role !== m.tossWinnerRole) return; // only the toss winner may choose
    if (choice !== "bat" && choice !== "bowl") return;
    const battingRole = choice === "bat" ? m.tossWinnerRole : otherRole(m.tossWinnerRole);
    beginInnings(room, battingRole);
    emitToRole(room, "p1", "matchStart", { battingIsYou: battingRole === "p1", overs: room.overs, stateP1: stateForRole(room, "p1") });
    emitToRole(room, "p2", "matchStart", { battingIsYou: battingRole === "p2", overs: room.overs, stateP2: stateForRole(room, "p2") });
  });

  socket.on("submitPick", ({ code, n }) => {
    const room = rooms[code]; if (!room || !room.match) return;
    const m = room.match;
    if (m.phase !== "batting") return;
    const role = roleOfSocket(room, socket.id);
    if (!role) return;
    const num = parseInt(n, 10);
    if (!(num >= 1 && num <= 10)) return;
    m.picks[role] = num;

    const oppRole = otherRole(role);
    if (m.picks[oppRole] === null) {
      emitToRole(room, oppRole, "opponentPicked", {});
      return;
    }
    resolveBall(room);
  });

  socket.on("requestRematch", ({ code }) => {
    const room = rooms[code]; if (!room) return;
    const role = roleOfSocket(room, socket.id);
    if (!role) return;
    room.rematchVotes[role] = true;
    const oppRole = otherRole(role);
    if (room.rematchVotes[oppRole]) {
      startToss(room);
    } else {
      emitToRole(room, oppRole, "rematchRequested", {});
      emitToRole(room, role, "rematchWaiting", {});
    }
  });

  socket.on("leaveMatch", ({ code }) => {
    const room = rooms[code]; if (!room) return;
    const role = roleOfSocket(room, socket.id);
    if (!role) return;
    emitToRole(room, otherRole(role), "opponentLeft", {});
    destroyRoom(code);
  });

  socket.on("rejoinRoom", ({ code, token }) => {
    const room = rooms[(code || "").toUpperCase()]; if (!room) return socket.emit("rejoinFailed");
    const role = room.players.p1 && room.players.p1.token === token ? "p1"
      : (room.players.p2 && room.players.p2.token === token ? "p2" : null);
    if (!role) return socket.emit("rejoinFailed");

    const p = room.players[role];
    if (p.disconnectTimer) { clearTimeout(p.disconnectTimer); p.disconnectTimer = null; }
    p.socketId = socket.id;
    p.connected = true;
    socketToRoom[socket.id] = room.code;

    socket.emit("rejoinSuccess", {
      you: role,
      overs: room.overs,
      match: room.match ? {
        phase: room.match.phase,
        state: stateForRole(room, role),
      } : null,
    });
    emitToRole(room, otherRole(role), "opponentReconnected", {});
  });

  socket.on("disconnect", () => {
    const idx = matchmakingQueue.findIndex((e) => e.socketId === socket.id);
    if (idx !== -1) {
      clearTimeout(matchmakingQueue[idx].timer);
      matchmakingQueue.splice(idx, 1);
    }

    const code = socketToRoom[socket.id];
    if (!code) return;
    const room = rooms[code];
    if (!room) return;
    const role = roleOfSocket(room, socket.id);
    if (!role) return;
    const player = room.players[role];
    if (!player) return;
    player.connected = false;

    if (!roomIsFull(room) || !room.match) {
      // no opponent yet, or match hasn't started — just clean up
      destroyRoom(code);
      return;
    }

    const oppRole = otherRole(role);
    emitToRole(room, oppRole, "opponentDisconnected", { seconds: DISCONNECT_GRACE_MS / 1000 });

    player.disconnectTimer = setTimeout(() => {
      if (player.connected) return; // reconnected in the meantime
      if (room.match && room.match.phase !== "finished") {
        room.match.phase = "finished";
        emitToRole(room, oppRole, "youWinByDisconnect", {});
      }
      destroyRoom(code);
    }, DISCONNECT_GRACE_MS);
  });
});

server.listen(PORT, () => {
  console.log(`THAGAPPA server listening on port ${PORT}`);
});
