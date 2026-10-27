const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static("public"));

const rooms = new Map();
const disconnectTimers = new Map();

const MAX_PLAYERS = 40;
const MIN_PLAYERS = 3;
const RECONNECT_GRACE_MS = 90 * 1000;

function makeCode() {
  let code;
  do code = crypto.randomBytes(3).toString("hex").toUpperCase();
  while (rooms.has(code));
  return code;
}

function makeSessionId() {
  return crypto.randomUUID();
}

function imposterCount(n) {
  // Host is a controller and does not play, so n is total room size including host.
  const playable = Math.max(n - 1, 0);
  if (playable <= 10) return 1;
  if (playable <= 20) return 2;
  if (playable <= 30) return 3;
  return 4;
}

function playablePlayers(room, { connectedOnly = false } = {}) {
  return [...room.players.values()].filter(p => {
    if (p.id === room.host) return false;
    if (connectedOnly && !p.connected) return false;
    return true;
  });
}

function expectedVoters(room) {
  // Only connected non-host players must vote. A player who left or
  // disconnected cannot block reveal / completion of the round.
  return playablePlayers(room, { connectedOnly: true });
}

function allVotesIn(room) {
  const voters = expectedVoters(room);
  // If nobody connected remains to vote, do not block the host from revealing.
  if (voters.length === 0) return true;
  return voters.every(p => room.votes.has(p.id));
}

function publicRoom(room, viewerId = null) {
  const voters = expectedVoters(room);
  const votesFromConnected = voters.filter(p => room.votes.has(p.id)).length;

  return {
    code: room.code,
    host: room.host,
    phase: room.phase,
    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      connected: p.connected
    })),
    playerCount: room.players.size,
    connectedCount: [...room.players.values()].filter(p => p.connected).length,
    maxPlayers: MAX_PLAYERS,
    minPlayers: MIN_PLAYERS,
    imposterCount:
      room.phase === "lobby" || room.phase === "setup"
        ? room.players.size >= MIN_PLAYERS
          ? imposterCount(room.players.size)
          : 0
        : room.assignedImposterCount ||
          room.imposterWords.length ||
          imposterCount(room.players.size),
    votesSubmitted: votesFromConnected,
    votesNeeded: voters.length,
    allVotesSubmitted: allVotesIn(room),
    revealed: room.revealed,
    hasVoted: viewerId ? room.votes.has(viewerId) : false,
    hostImposters:
      viewerId === room.host
        ? [...room.assignments.entries()]
            .filter(([, word]) => room.imposterWords.includes(word))
            .map(([id]) => {
              const player = room.players.get(id);
              return player ? { id: player.id, name: player.name } : null;
            })
            .filter(Boolean)
        : []
  };
}

function emitRoom(room) {
  for (const player of room.players.values()) {
    if (!player.connected) continue;
    const playerSocket = io.sockets.sockets.get(player.socketId);
    if (playerSocket) {
      playerSocket.emit("room", publicRoom(room, player.id));
    }
  }
}

function error(cb, message) {
  if (typeof cb === "function") cb({ ok: false, error: message });
}

function clearDisconnectTimer(playerId) {
  const timer = disconnectTimers.get(playerId);
  if (timer) {
    clearTimeout(timer);
    disconnectTimers.delete(playerId);
  }
}

function sendSecretWord(room, playerId) {
  const player = room.players.get(playerId);
  if (!player || playerId === room.host || room.phase !== "playing") return;

  const socket = io.sockets.sockets.get(player.socketId);
  if (!socket) return;

  socket.emit("secretWord", {
    word: room.assignments.get(playerId),
    playerCount: playablePlayers(room).length,
    imposterCount: imposterCount(room.players.size)
  });
}

function sendResults(room, playerId) {
  if (!room.result) return;
  const player = room.players.get(playerId);
  if (!player) return;
  const socket = io.sockets.sockets.get(player.socketId);
  if (socket) socket.emit("results", room.result);
}

function transferHost(room) {
  const next = [...room.players.values()].find(p => p.connected) ||
    [...room.players.values()][0];
  if (!next) return;
  room.host = next.id;
  const sock = io.sockets.sockets.get(next.socketId);
  if (sock) sock.emit("hostChanged");
}

function removePlayer(room, playerId, reason = null) {
  const player = room.players.get(playerId);
  if (!player) return;

  clearDisconnectTimer(playerId);
  room.players.delete(playerId);
  room.votes.delete(playerId);
  room.assignments.delete(playerId);

  // Drop votes that targeted the removed player so tallies stay valid.
  for (const [voterId, targets] of room.votes.entries()) {
    const filtered = targets.filter(id => id !== playerId);
    if (filtered.length === 0) {
      room.votes.delete(voterId);
    } else if (filtered.length !== targets.length) {
      room.votes.set(voterId, filtered);
    }
  }

  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }

  const wasHost = room.host === playerId;

  if (wasHost) {
    if (room.phase !== "lobby") {
      io.to(room.code).emit(
        "gameEnded",
        reason || "The host left the game."
      );
      for (const id of room.players.keys()) clearDisconnectTimer(id);
      rooms.delete(room.code);
      return;
    }
    transferHost(room);
    room.phase = "lobby";
  }

  emitRoom(room);
}

function scheduleDisconnectRemoval(room, playerId) {
  clearDisconnectTimer(playerId);

  const timer = setTimeout(() => {
    disconnectTimers.delete(playerId);
    const currentRoom = rooms.get(room.code);
    if (!currentRoom) return;
    const player = currentRoom.players.get(playerId);
    if (!player || player.connected) return;

    removePlayer(
      currentRoom,
      playerId,
      playerId === currentRoom.host
        ? "The host disconnected and did not reconnect."
        : null
    );
  }, RECONNECT_GRACE_MS);

  disconnectTimers.set(playerId, timer);
}

function resetRound(room) {
  room.phase = "setup";
  room.normalWord = "";
  room.imposterWords = [];
  room.assignedImposterCount = 0;
  room.assignments = new Map();
  room.votes = new Map();
  room.revealed = false;
  room.result = null;
}

function destroyRoom(room, message) {
  io.to(room.code).emit("newGameStarted", message);
  for (const id of room.players.keys()) clearDisconnectTimer(id);
  rooms.delete(room.code);
}

io.on("connection", socket => {
  socket.on("heartbeat", cb => {
    if (typeof cb === "function") cb({ ok: true, time: Date.now() });
  });

  socket.on("restoreSession", ({ sessionId, code }, cb) => {
    sessionId = String(sessionId || "").trim();
    code = String(code || "").trim().toUpperCase();

    const room = rooms.get(code);
    const player = room?.players.get(sessionId);

    if (!room || !player) {
      return error(cb, "Your previous game session could not be restored.");
    }

    clearDisconnectTimer(sessionId);
    player.socketId = socket.id;
    player.connected = true;
    socket.data.playerId = sessionId;
    socket.data.roomCode = code;
    socket.join(code);

    const restoredRoom = publicRoom(room, sessionId);
    cb?.({ ok: true, id: sessionId, code, room: restoredRoom });
    socket.emit("room", restoredRoom);

    if (room.phase === "playing") sendSecretWord(room, sessionId);
    else if (room.phase === "results") sendResults(room, sessionId);

    emitRoom(room);
  });

  socket.on("createGame", (name, sessionId, cb) => {
    if (typeof sessionId === "function") {
      cb = sessionId;
      sessionId = makeSessionId();
    }

    sessionId = String(sessionId || "").trim() || makeSessionId();
    name = String(name || "").trim().slice(0, 30);
    if (!name) return error(cb, "Enter your name.");

    const code = makeCode();
    const room = {
      code,
      host: sessionId,
      phase: "lobby",
      players: new Map(),
      normalWord: "",
      imposterWords: [],
      assignedImposterCount: 0,
      assignments: new Map(),
      votes: new Map(),
      revealed: false,
      result: null
    };

    room.players.set(sessionId, {
      id: sessionId,
      name,
      joinedAt: Date.now(),
      socketId
