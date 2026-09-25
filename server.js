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

const MAX_PLAYERS = 35;
const MIN_PLAYERS = 3;
const RECONNECT_GRACE_MS = 2 * 60 * 1000; // Keep disconnected players for 2 minutes.

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
  if (n <= 10) return 1;
  if (n <= 20) return 2;
  return 3;
}

function publicRoom(room, viewerId = null) {
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
    maxPlayers: MAX_PLAYERS,
    minPlayers: MIN_PLAYERS,
    imposterCount:
      room.players.size >= MIN_PLAYERS ? imposterCount(room.players.size) : 0,
    votesSubmitted: room.votes.size,
    allVotesSubmitted:
      room.votes.size === Math.max(room.players.size - 1, 0) &&
      room.players.size > 1,
    revealed: room.revealed,
    hasVoted: viewerId ? room.votes.has(viewerId) : false,

    // Only the host receives the imposter identities.
    // Regular players never receive this information.
    hostImposters:
      viewerId === room.host
        ? [...room.assignments.entries()]
            .filter(([id, word]) => room.imposterWords.includes(word))
            .map(([id]) => {
              const player = room.players.get(id);
              return player
                ? { id: player.id, name: player.name }
                : null;
            })
            .filter(Boolean)
        : []
  };
}

function emitRoom(room) {
  // Send each connected player their own room state.
  // hasVoted is player-specific, so a single broadcast cannot be used.
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

  if (!player || playerId === room.host || room.phase !== "playing") {
    return;
  }

  const socket = io.sockets.sockets.get(player.socketId);

  if (!socket) return;

  socket.emit("secretWord", {
    word: room.assignments.get(playerId),
    playerCount: room.players.size - 1,
    imposterCount: imposterCount(room.players.size)
  });
}

function sendResults(room, playerId) {
  if (!room.result) return;

  const player = room.players.get(playerId);

  if (!player) return;

  const socket = io.sockets.sockets.get(player.socketId);

  if (socket) {
    socket.emit("results", room.result);
  }
}

function removePlayer(room, playerId, reason = null) {
  const player = room.players.get(playerId);

  if (!player) return;

  clearDisconnectTimer(playerId);

  room.players.delete(playerId);
  room.votes.delete(playerId);
  room.assignments.delete(playerId);

  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }

  const wasHost = room.host === playerId;

  if (wasHost) {
    // During an active game, give the host a reconnect grace period.
    // removePlayer is only called after that grace period expires.
    if (room.phase !== "lobby") {
      io.to(room.code).emit(
        "gameEnded",
        reason || "The host left the game."
      );

      rooms.delete(room.code);
      return;
    }

    // In the lobby, transfer control to the first remaining player.
    room.host = [...room.players.keys()][0];
    room.phase = "lobby";

    const newHost = room.players.get(room.host);

    if (newHost) {
      const newHostSocket = io.sockets.sockets.get(newHost.socketId);

      if (newHostSocket) {
        newHostSocket.emit("hostChanged");
      }
    }
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
        : "A player disconnected."
    );
  }, RECONNECT_GRACE_MS);

  disconnectTimers.set(playerId, timer);
}

io.on("connection", socket => {
  socket.on("heartbeat", cb => {
    if (typeof cb === "function") {
      cb({
        ok: true,
        time: Date.now()
      });
    }
  });

  socket.on("restoreSession", ({ sessionId, code }, cb) => {
    sessionId = String(sessionId || "").trim();
    code = String(code || "").trim().toUpperCase();

    const room = rooms.get(code);
    const player = room?.players.get(sessionId);

    if (!room || !player) {
      return error(
        cb,
        "Your previous game session could not be restored."
      );
    }

    clearDisconnectTimer(sessionId);

    player.socketId = socket.id;
    player.connected = true;

    socket.data.playerId = sessionId;
    socket.data.roomCode = code;

    socket.join(code);

    const restoredRoom = publicRoom(room, sessionId);

    cb?.({
      ok: true,
      id: sessionId,
      code,
      room: restoredRoom
    });

    socket.emit("room", restoredRoom);

    if (room.phase === "playing") {
      sendSecretWord(room, sessionId);
    } else if (room.phase === "results") {
      sendResults(room, sessionId);
    }

    emitRoom(room);
  });

  socket.on("createGame", (name, sessionId, cb) => {
    // Backward-compatible argument handling:
    // createGame(name, callback)
    if (typeof sessionId === "function") {
      cb = sessionId;
      sessionId = makeSessionId();
    }

    sessionId =
      String(sessionId || "").trim() || makeSessionId();

    name = String(name || "")
      .trim()
      .slice(0, 30);

    if (!name) {
      return error(cb, "Enter your name.");
    }

    const code = makeCode();

    const room = {
      code,
      host: sessionId,
      phase: "lobby",
      players: new Map(),
      normalWord: "",
      imposterWords: [],
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

    cb?.({
      ok: true,
      id: sessionId,
      code,
      room: publicRoom(room, sessionId)
    });

    emitRoom(room);
  });

  socket.on("joinGame", ({ code, name, sessionId }, cb) => {
    code = String(code || "")
      .trim()
      .toUpperCase();

    name = String(name || "")
      .trim()
      .slice(0, 30);

    sessionId =
      String(sessionId || "").trim() || makeSessionId();

    const room = rooms.get(code);

    if (!room) {
      return error(
        cb,
        "Game not found. Check the code."
      );
    }

    // Allow a returning browser session to rejoin its existing lobby entry.
    const existingPlayer = room.players.get(sessionId);

    if (existingPlayer) {
      clearDisconnectTimer(sessionId);

      existingPlayer.socketId = socket.id;
      existingPlayer.connected = true;

      if (name) {
        existingPlayer.name = name;
      }

      socket.data.playerId = sessionId;
      socket.data.roomCode = code;

      socket.join(code);

      cb?.({
        ok: true,
        id: sessionId,
        code,
        room: publicRoom(room, sessionId)
      });

      emitRoom(room);
      return;
    }

    if (room.phase !== "lobby") {
      return error(
        cb,
        "This game has already started."
      );
    }

    if (!name) {
      return error(cb, "Enter your name.");
    }

    if (room.players.size >= MAX_PLAYERS) {
      return error(cb, "This game is full.");
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

    cb?.({
      ok: true,
      id: sessionId,
      code,
      room: publicRoom(room, sessionId)
    });

    emitRoom(room);
  });

  socket.on("openSetup", (code, cb) => {
    code = String(code || "")
      .trim()
      .toUpperCase();

    const room = rooms.get(code);

    if (!room) {
      return error(cb, "Game not found.");
    }

    if (room.host !== socket.data.playerId) {
      return error(
        cb,
        "Only the host can start the game."
      );
    }

    if (room.players.size < MIN_PLAYERS) {
      return error(
        cb,
        `At least ${MIN_PLAYERS} players are required.`
      );
    }

    room.phase = "setup";

    cb?.({
      ok: true,
      room: publicRoom(room, socket.data.playerId)
    });

    emitRoom(room);
  });

  socket.on(
    "startGame",
    ({ code, normalWord, imposterWords }, cb) => {
      code = String(code || "")
        .trim()
        .toUpperCase();

      const room = rooms.get(code);

      if (!room) {
        return error(cb, "Game not found.");
      }

      if (room.host !== socket.data.playerId) {
        return error(
          cb,
          "Only the host can submit the words."
        );
      }

      if (room.phase !== "setup") {
        return error(
          cb,
          "Game setup is not open."
        );
      }

      const count = imposterCount(room.players.size);

      normalWord = String(normalWord || "").trim();

      imposterWords = Array.isArray(imposterWords)
        ? imposterWords.map(w =>
            String(w || "").trim()
          )
        : [];

      if (!normalWord) {
        return error(
          cb,
          "Enter the normal-player word."
        );
      }

      if (
        imposterWords.length !== count ||
        imposterWords.some(w => !w)
      ) {
        return error(
          cb,
          `Enter ${count} imposter word${
            count > 1 ? "s" : ""
          }.`
        );
      }

      const allWords = [
        normalWord,
        ...imposterWords
      ].map(w => w.toLowerCase());

      if (new Set(allWords).size !== allWords.length) {
        return error(
          cb,
          "All words must be different."
        );
      }

      const playerIds = [
        ...room.players.keys()
      ];

      // Shuffle players randomly.
      for (
        let i = playerIds.length - 1;
        i > 0;
        i--
      ) {
        const j = Math.floor(
          Math.random() * (i + 1)
        );

        [
          playerIds[i],
          playerIds[j]
        ] = [
          playerIds[j],
          playerIds[i]
        ];
      }

      room.normalWord = normalWord;
      room.imposterWords = imposterWords;
      room.assignments = new Map();
      room.votes = new Map();
      room.revealed = false;
      room.result = null;

      // The host is a controller only and is never assigned a word.
      const playableIds = playerIds.filter(
        id => id !== room.host
      );

      if (playableIds.length < count) {
        return error(
          cb,
          "Not enough players to assign the imposters."
        );
      }

      const imposterIds =
        playableIds.slice(0, count);

      const imposterById = new Map();

      imposterIds.forEach(
        (id, index) => {
          imposterById.set(
            id,
            imposterWords[index]
          );
        }
      );

      for (const id of playableIds) {
        room.assignments.set(
          id,
          imposterById.get(id) || normalWord
        );
      }

      room.phase = "playing";

      // Send each player only their own secret word.
      for (const id of playableIds) {
        sendSecretWord(room, id);
      }

      cb?.({
        ok: true
      });

      emitRoom(room);
    }
  );

  socket.on("openVoting", (code, cb) => {
    code = String(code || "")
      .trim()
      .toUpperCase();

    const room = rooms.get(code);

    if (!room) {
      return error(cb, "Game not found.");
    }

    if (room.host !== socket.data.playerId) {
      return error(
        cb,
        "Only the host can open voting."
      );
    }

    if (room.phase !== "playing") {
      return error(
        cb,
        "Voting cannot be opened yet."
      );
    }

    room.phase = "voting";
    room.votes = new Map();
    room.revealed = false;
    room.result = null;

    cb?.({
      ok: true
    });

    emitRoom(room);
  });

  socket.on(
    "submitVote",
    ({ code, targets }, cb) => {
      code = String(code || "")
        .trim()
        .toUpperCase();

      const room = rooms.get(code);

      if (!room) {
        return error(cb, "Game not found.");
      }

      if (room.phase !== "voting") {
        return error(
          cb,
          "Voting is not open."
        );
      }

      const playerId =
        socket.data.playerId;

      if (playerId === room.host) {
        return error(
          cb,
          "The host does not vote."
        );
      }

      if (!room.players.has(playerId)) {
        return error(
          cb,
          "You are no longer in this game."
        );
      }

      const playableIds =
        [...room.players.keys()].filter(
          id => id !== room.host
        );

      const required =
        imposterCount(room.players.size);

      const uniqueTargets = [
        ...new Set(
          Array.isArray(targets)
            ? targets
            : []
        )
      ];

      if (
        uniqueTargets.length !== required
      ) {
        return error(
          cb,
          `Select exactly ${required} player${
            required > 1 ? "s" : ""
          }.`
        );
      }

      if (
        uniqueTargets.some(
          id =>
            !playableIds.includes(id) ||
            id === playerId
        )
      ) {
        return error(
          cb,
          "Invalid vote selection."
        );
      }

      room.votes.set(
        playerId,
        uniqueTargets
      );

      cb?.({
        ok: true
      });

      emitRoom(room);
    }
  );

  socket.on(
    "revealResults",
    (code, cb) => {
      code = String(code || "")
        .trim()
        .toUpperCase();

      const room = rooms.get(code);

      if (!room) {
        return error(cb, "Game not found.");
      }

      if (room.host !== socket.data.playerId) {
        return error(
          cb,
          "Only the host can reveal results."
        );
      }

      if (room.phase !== "voting") {
        return error(
          cb,
          "Voting is not open."
        );
      }

      if (
        room.votes.size !==
        room.players.size - 1
      ) {
        return error(
          cb,
          "Wait until every player has voted."
        );
      }

      room.phase = "results";
      room.revealed = true;

      const counts = {};

      for (const p of room.players.values()) {
        if (p.id !== room.host) {
          counts[p.id] = 0;
        }
      }

      for (const targets of room.votes.values()) {
        for (const target of targets) {
          counts[target] =
            (counts[target] || 0) + 1;
        }
      }

      const imposters =
        [...room.assignments.entries()]
          .filter(
            ([id, word]) =>
              room.imposterWords.includes(word)
          )
          .map(([id]) => id);

      room.result = {
        playerCount:
          room.players.size - 1,

        imposterCount:
          imposterCount(room.players.size),

        players:
          [...room.players.values()]
            .filter(
              p => p.id !== room.host
            )
            .map(p => ({
              id: p.id,
              name: p.name,
              votes:
                counts[p.id] || 0,
              word:
                room.assignments.get(p.id),
              isImposter:
                imposters.includes(p.id)
            })),

        normalWord:
          room.normalWord,

        imposterWords:
          room.imposterWords
      };

      io.to(room.code).emit(
        "results",
        room.result
      );

      cb?.({
        ok: true
      });

      emitRoom(room);
    }
  );

  socket.on(
    "playAgain",
    (code, cb) => {
      code = String(code || "")
        .trim()
        .toUpperCase();

      const room = rooms.get(code);

      if (!room) {
        return error(cb, "Game not found.");
      }

      const playerId =
        socket.data.playerId;

      if (room.host !== playerId) {
        return error(
          cb,
          "Only the host can start another round."
        );
      }

      if (room.phase !== "results") {
        return error(
          cb,
          "The current round is not finished yet."
        );
      }

      // Keep the same players and same game code.
      // Only reset the current round.
      room.phase = "setup";
      room.normalWord = "";
      room.imposterWords = [];
      room.assignments = new Map();
      room.votes = new Map();
      room.revealed = false;
      room.result = null;

      // Tell every connected player that another round is starting.
      io.to(room.code).emit(
        "roundStarting",
        "Starting another round… The host is setting up the new words."
      );

      cb?.({
        ok: true,
        room: publicRoom(
          room,
          playerId
        )
      });

      emitRoom(room);
    }
  );

  socket.on(
    "startNewGame",
    (code, cb) => {
      code = String(code || "")
        .trim()
        .toUpperCase();

      const room = rooms.get(code);

      if (!room) {
        return error(
          cb,
          "Game not found."
        );
      }

      const playerId =
        socket.data.playerId;

      if (room.host !== playerId) {
        return error(
          cb,
          "Only the host can start a new game."
        );
      }

      // Tell all current players to leave the old game.
      io.to(room.code).emit(
        "newGameStarted",
        "The host started a new game. Returning to the home screen."
      );

      // Cancel reconnect timers for everyone in this room.
      for (const id of room.players.keys()) {
        clearDisconnectTimer(id);
      }

      // Completely destroy the old room.
      // A refresh can no longer restore it.
      rooms.delete(room.code);

      cb?.({
        ok: true
      });
    }
  );

  socket.on("disconnect", () => {
    const playerId =
      socket.data.playerId;

    const code =
      socket.data.roomCode;

    if (!playerId || !code) {
      return;
    }

    const room =
      rooms.get(code);

    if (!room) {
      return;
    }

    const player =
      room.players.get(playerId);

    if (!player) {
      return;
    }

    // Ignore a stale socket disconnect if the player already
    // reconnected with a newer socket.
    if (player.socketId !== socket.id) {
      return;
    }

    player.connected = false;

    // Do NOT immediately remove the player.
    // Give Socket.IO/browser time to reconnect so the room
    // and game state are preserved.
    scheduleDisconnectRemoval(
      room,
      playerId
    );

    emitRoom(room);
  });
});

const PORT =
  process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(
    `Imposter game server listening on ${PORT}`
  );
});
