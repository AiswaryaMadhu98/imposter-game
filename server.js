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
      socketId: socket.id,
      connected: true
    });

    rooms.set(code, room);
    socket.data.playerId = sessionId;
    socket.data.roomCode = code;
    socket.join(code);

    cb?.({ ok: true, id: sessionId, code, room: publicRoom(room, sessionId) });
    emitRoom(room);
  });

  socket.on("joinGame", ({ code, name, sessionId }, cb) => {
    code = String(code || "").trim().toUpperCase();
    name = String(name || "").trim().slice(0, 30);
    sessionId = String(sessionId || "").trim() || makeSessionId();

    const room = rooms.get(code);
    if (!room) return error(cb, "Game not found. Check the code.");

    const existingPlayer = room.players.get(sessionId);
    if (existingPlayer) {
      clearDisconnectTimer(sessionId);
      existingPlayer.socketId = socket.id;
      existingPlayer.connected = true;
      if (name) existingPlayer.name = name;
      socket.data.playerId = sessionId;
      socket.data.roomCode = code;
      socket.join(code);
      cb?.({ ok: true, id: sessionId, code, room: publicRoom(room, sessionId) });
      emitRoom(room);
      return;
    }

    if (room.phase !== "lobby") {
      return error(cb, "This game has already started.");
    }
    if (!name) return error(cb, "Enter your name.");
    if (room.players.size >= MAX_PLAYERS) {
      return error(cb, "This game is full (40 players max).");
    }

    room.players.set(sessionId, {
      id: sessionId,
      name,
      joinedAt: Date.now(),
      socketId: socket.id,
      connected: true
    });

    socket.data.playerId = sessionId;
    socket.data.roomCode = code;
    socket.join(code);

    cb?.({ ok: true, id: sessionId, code, room: publicRoom(room, sessionId) });
    emitRoom(room);
  });

  socket.on("leaveRoom", (code, cb) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    const playerId = socket.data.playerId;

    if (!room || !playerId || !room.players.has(playerId)) {
      return error(cb, "You are not in this game.");
    }

    socket.leave(code);
    socket.data.roomCode = null;
    socket.data.playerId = null;

    removePlayer(room, playerId, "The host left the game.");
    cb?.({ ok: true });
  });

  socket.on("openSetup", (code, cb) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return error(cb, "Game not found.");
    if (room.host !== socket.data.playerId) {
      return error(cb, "Only the host can start the game.");
    }
    if (room.players.size < MIN_PLAYERS) {
      return error(cb, `At least ${MIN_PLAYERS} players are required.`);
    }

    room.phase = "setup";
    cb?.({ ok: true, room: publicRoom(room, socket.data.playerId) });
    emitRoom(room);
  });

  socket.on("startGame", ({ code, normalWord, imposterWords }, cb) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return error(cb, "Game not found.");
    if (room.host !== socket.data.playerId) {
      return error(cb, "Only the host can submit the words.");
    }
    if (room.phase !== "setup") {
      return error(cb, "Game setup is not open.");
    }

    const count = imposterCount(room.players.size);
    normalWord = String(normalWord || "").trim();
    imposterWords = Array.isArray(imposterWords)
      ? imposterWords.map(w => String(w || "").trim())
      : [];

    if (!normalWord) return error(cb, "Enter the normal-player word.");
    if (imposterWords.length !== count || imposterWords.some(w => !w)) {
      return error(
        cb,
        `Enter ${count} imposter word${count > 1 ? "s" : ""}.`
      );
    }

    const allWords = [normalWord, ...imposterWords].map(w => w.toLowerCase());
    if (new Set(allWords).size !== allWords.length) {
      return error(cb, "All words must be different.");
    }

    const playerIds = [...room.players.keys()];
    for (let i = playerIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [playerIds[i], playerIds[j]] = [playerIds[j], playerIds[i]];
    }

    room.normalWord = normalWord;
    room.imposterWords = imposterWords;
    room.assignedImposterCount = count;
    room.assignments = new Map();
    room.votes = new Map();
    room.revealed = false;
    room.result = null;

    const playableIds = playerIds.filter(id => id !== room.host);
    if (playableIds.length < count) {
      return error(cb, "Not enough players to assign the imposters.");
    }

    const imposterIds = playableIds.slice(0, count);
    const imposterById = new Map();
    imposterIds.forEach((id, index) => {
      imposterById.set(id, imposterWords[index]);
    });

    for (const id of playableIds) {
      room.assignments.set(id, imposterById.get(id) || normalWord);
    }

    room.phase = "playing";
    for (const id of playableIds) sendSecretWord(room, id);

    cb?.({ ok: true });
    emitRoom(room);
  });

  socket.on("openVoting", (code, cb) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return error(cb, "Game not found.");
    if (room.host !== socket.data.playerId) {
      return error(cb, "Only the host can open voting.");
    }
    if (room.phase !== "playing") {
      return error(cb, "Voting cannot be opened yet.");
    }

    room.phase = "voting";
    room.votes = new Map();
    room.revealed = false;
    room.result = null;

    cb?.({ ok: true });
    emitRoom(room);
  });

  socket.on("submitVote", ({ code, targets }, cb) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return error(cb, "Game not found.");
    if (room.phase !== "voting") return error(cb, "Voting is not open.");

    const playerId = socket.data.playerId;
    if (playerId === room.host) return error(cb, "The host does not vote.");
    if (!room.players.has(playerId)) {
      return error(cb, "You are no longer in this game.");
    }

    const playableIds = playablePlayers(room).map(p => p.id);
    // Vote for the number of imposters that were assigned at start,
    // capped by remaining playable players (minus self).
    const assignedCount =
      room.assignedImposterCount ||
      room.imposterWords.length ||
      imposterCount(room.players.size);
    const maxSelectable = Math.max(playableIds.filter(id => id !== playerId).length, 1);
    const required = Math.min(assignedCount, maxSelectable);

    const uniqueTargets = [...new Set(Array.isArray(targets) ? targets : [])];

    if (uniqueTargets.length !== required) {
      return error(
        cb,
        `Select exactly ${required} player${required > 1 ? "s" : ""}.`
      );
    }

    if (uniqueTargets.some(id => !playableIds.includes(id) || id === playerId)) {
      return error(cb, "Invalid vote selection.");
    }

    room.votes.set(playerId, uniqueTargets);
    cb?.({ ok: true });
    emitRoom(room);
  });

  socket.on("revealResults", (code, cb) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return error(cb, "Game not found.");
    if (room.host !== socket.data.playerId) {
      return error(cb, "Only the host can reveal results.");
    }
    if (room.phase !== "voting") return error(cb, "Voting is not open.");

    if (!allVotesIn(room)) {
      return error(
        cb,
        "Wait until every connected player has voted. Players who left no longer block the game."
      );
    }

    room.phase = "results";
    room.revealed = true;

    const counts = {};
    for (const p of playablePlayers(room)) counts[p.id] = 0;

    for (const targets of room.votes.values()) {
      for (const target of targets) {
        if (counts[target] !== undefined) counts[target] += 1;
      }
    }

    const imposters = [...room.assignments.entries()]
      .filter(([, word]) => room.imposterWords.includes(word))
      .map(([id]) => id)
      .filter(id => room.players.has(id));

    room.result = {
      playerCount: playablePlayers(room).length,
      imposterCount: imposters.length,
      players: playablePlayers(room).map(p => ({
        id: p.id,
        name: p.name,
        votes: counts[p.id] || 0,
        word: room.assignments.get(p.id),
        isImposter: imposters.includes(p.id),
        connected: p.connected
      })),
      normalWord: room.normalWord,
      imposterWords: room.imposterWords
    };

    io.to(room.code).emit("results", room.result);
    cb?.({ ok: true });
    emitRoom(room);
  });

  // Host can restart the round from any non-lobby phase (fixes stuck mid-game).
  socket.on("playAgain", (code, cb) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return error(cb, "Game not found.");
    if (room.host !== socket.data.playerId) {
      return error(cb, "Only the host can start another round.");
    }
    if (room.phase === "lobby") {
      return error(cb, "The game has not started yet.");
    }
    if (room.players.size < MIN_PLAYERS) {
      return error(cb, `At least ${MIN_PLAYERS} players are required.`);
    }

    resetRound(room);

    io.to(room.code).emit(
      "roundStarting",
      "Starting another round… The host is setting up the new words."
    );

    cb?.({ ok: true, room: publicRoom(room, socket.data.playerId) });
    emitRoom(room);
  });

  socket.on("returnToLobby", (code, cb) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return error(cb, "Game not found.");
    if (room.host !== socket.data.playerId) {
      return error(cb, "Only the host can return to the lobby.");
    }

    room.phase = "lobby";
    room.normalWord = "";
    room.imposterWords = [];
    room.assignedImposterCount = 0;
    room.assignments = new Map();
    room.votes = new Map();
    room.revealed = false;
    room.result = null;

    io.to(room.code).emit(
      "roundStarting",
      "The host returned everyone to the lobby."
    );

    cb?.({ ok: true, room: publicRoom(room, socket.data.playerId) });
    emitRoom(room);
  });

  socket.on("startNewGame", (code, cb) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return error(cb, "Game not found.");
    if (room.host !== socket.data.playerId) {
      return error(cb, "Only the host can start a new game.");
    }

    destroyRoom(
      room,
      "The host started a new game. Returning to the home screen."
    );
    cb?.({ ok: true });
  });

  socket.on("disconnect", () => {
    const playerId = socket.data.playerId;
    const code = socket.data.roomCode;
    if (!playerId || !code) return;

    const room = rooms.get(code);
    if (!room) return;

    const player = room.players.get(playerId);
    if (!player) return;
    if (player.socketId !== socket.id) return;

    player.connected = false;

    // During voting, a disconnect must not block the round.
    // Drop their pending vote requirement immediately via connectedOnly counting,
    // and remove their incomplete vote so progress stays accurate.
    if (room.phase === "voting" && !room.votes.has(playerId)) {
      // no-op: expectedVoters already ignores disconnected players
    }

    scheduleDisconnectRemoval(room, playerId);
    emitRoom(room);
  });
});

const PORT = process.env.PORT || 3847;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Imposter game server listening on ${PORT}`);
});
