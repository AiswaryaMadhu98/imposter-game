
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static("public"));

const rooms = new Map();
const MAX_PLAYERS = 35;
const MIN_PLAYERS = 3;

function makeCode() {
  let code;
  do code = crypto.randomBytes(3).toString("hex").toUpperCase();
  while (rooms.has(code));
  return code;
}

function imposterCount(n) {
  if (n <= 10) return 1;
  if (n <= 20) return 2;
  return 3;
}

function publicRoom(room) {
  return {
    code: room.code,
    host: room.host,
    phase: room.phase,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name })),
    playerCount: room.players.size,
    maxPlayers: MAX_PLAYERS,
    minPlayers: MIN_PLAYERS,
    imposterCount: room.players.size >= MIN_PLAYERS ? imposterCount(room.players.size) : 0,
    votesSubmitted: room.votes.size,
    allVotesSubmitted: room.votes.size === room.players.size && room.players.size > 0,
    revealed: room.revealed
  };
}

function emitRoom(room) {
  io.to(room.code).emit("room", publicRoom(room));
}

function error(cb, message) {
  if (typeof cb === "function") cb({ ok: false, error: message });
}

io.on("connection", socket => {
  socket.on("createGame", (name, cb) => {
    name = String(name || "").trim().slice(0, 30);
    if (!name) return error(cb, "Enter your name.");

    const code = makeCode();
    const room = {
      code,
      host: socket.id,
      phase: "lobby",
      players: new Map(),
      normalWord: "",
      imposterWords: [],
      assignments: new Map(),
      votes: new Map(),
      revealed: false
    };

    room.players.set(socket.id, { id: socket.id, name, joinedAt: Date.now() });
    rooms.set(code, room);
    socket.join(code);

    cb?.({ ok: true, id: socket.id, code, room: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("joinGame", ({ code, name }, cb) => {
    code = String(code || "").trim().toUpperCase();
    name = String(name || "").trim().slice(0, 30);

    const room = rooms.get(code);
    if (!room) return error(cb, "Game not found. Check the code.");
    if (room.phase !== "lobby") return error(cb, "This game has already started.");
    if (!name) return error(cb, "Enter your name.");
    if (room.players.size >= MAX_PLAYERS) return error(cb, "This game is full.");

    room.players.set(socket.id, { id: socket.id, name, joinedAt: Date.now() });
    socket.join(code);

    cb?.({ ok: true, id: socket.id, code, room: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("openSetup", (code, cb) => {
    const room = rooms.get(code);
    if (!room) return error(cb, "Game not found.");
    if (room.host !== socket.id) return error(cb, "Only the host can start the game.");
    if (room.players.size < MIN_PLAYERS) {
      return error(cb, `At least ${MIN_PLAYERS} players are required.`);
    }

    room.phase = "setup";
    cb?.({ ok: true, room: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("startGame", ({ code, normalWord, imposterWords }, cb) => {
    const room = rooms.get(code);
    if (!room) return error(cb, "Game not found.");
    if (room.host !== socket.id) return error(cb, "Only the host can submit the words.");
    if (room.phase !== "setup") return error(cb, "Game setup is not open.");

    const count = imposterCount(room.players.size);
    normalWord = String(normalWord || "").trim();
    imposterWords = Array.isArray(imposterWords)
      ? imposterWords.map(w => String(w || "").trim())
      : [];

    if (!normalWord) return error(cb, "Enter the normal-player word.");
    if (imposterWords.length !== count || imposterWords.some(w => !w)) {
      return error(cb, `Enter ${count} imposter word${count > 1 ? "s" : ""}.`);
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
    room.assignments = new Map();
    room.votes = new Map();
    room.revealed = false;

    // The host is a controller only and is never assigned a word.
    const playableIds = playerIds.filter(id => id !== room.host);
    if (playableIds.length < count) {
      return error(cb, "Not enough players to assign the imposters.");
    }

    const imposterIds = playableIds.slice(0, count);
    const imposterById = new Map();
    imposterIds.forEach((id, index) => imposterById.set(id, imposterWords[index]));

    for (const id of playableIds) {
      room.assignments.set(id, imposterById.get(id) || normalWord);
    }

    room.phase = "playing";

    // Send each player only their own secret word.
    for (const id of playableIds) {
      io.to(id).emit("secretWord", {
        word: room.assignments.get(id),
        playerCount: room.players.size - 1,
        imposterCount: count
      });
    }

    cb?.({ ok: true });
    emitRoom(room);
  });

  socket.on("openVoting", (code, cb) => {
    const room = rooms.get(code);
    if (!room) return error(cb, "Game not found.");
    if (room.host !== socket.id) return error(cb, "Only the host can open voting.");
    if (room.phase !== "playing") return error(cb, "Voting cannot be opened yet.");

    room.phase = "voting";
    room.votes = new Map();
    room.revealed = false;
    cb?.({ ok: true });
    emitRoom(room);
  });

  socket.on("submitVote", ({ code, targets }, cb) => {
    const room = rooms.get(code);
    if (!room) return error(cb, "Game not found.");
    if (room.phase !== "voting") return error(cb, "Voting is not open.");
    if (socket.id === room.host) return error(cb, "The host does not vote.");

    const playableIds = [...room.players.keys()].filter(id => id !== room.host);
    const required = imposterCount(room.players.size);
    const uniqueTargets = [...new Set(Array.isArray(targets) ? targets : [])];

    if (uniqueTargets.length !== required) {
      return error(cb, `Select exactly ${required} player${required > 1 ? "s" : ""}.`);
    }
    if (uniqueTargets.some(id => !playableIds.includes(id) || id === socket.id)) {
      return error(cb, "Invalid vote selection.");
    }

    room.votes.set(socket.id, uniqueTargets);
    cb?.({ ok: true });
    emitRoom(room);
  });

  socket.on("revealResults", (code, cb) => {
    const room = rooms.get(code);
    if (!room) return error(cb, "Game not found.");
    if (room.host !== socket.id) return error(cb, "Only the host can reveal results.");
    if (room.phase !== "voting") return error(cb, "Voting is not open.");
    if (room.votes.size !== room.players.size - 1) {
      return error(cb, "Wait until every player has voted.");
    }

    room.phase = "results";
    room.revealed = true;

    const counts = {};
    for (const p of room.players.values()) {
      if (p.id !== room.host) counts[p.id] = 0;
    }
    for (const targets of room.votes.values()) {
      for (const target of targets) counts[target] = (counts[target] || 0) + 1;
    }

    const imposters = [...room.assignments.entries()]
      .filter(([id]) => room.imposterWords.includes(room.assignments.get(id)))
      .map(([id]) => id);

    const result = {
      playerCount: room.players.size - 1,
      imposterCount: imposterCount(room.players.size),
      players: [...room.players.values()]
        .filter(p => p.id !== room.host)
        .map(p => ({
          id: p.id,
          name: p.name,
          votes: counts[p.id] || 0,
          word: room.assignments.get(p.id),
          isImposter: imposters.includes(p.id)
        })),
      normalWord: room.normalWord,
      imposterWords: room.imposterWords
    };

    io.to(room.code).emit("results", result);
    cb?.({ ok: true });
    emitRoom(room);
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms) {
      if (!room.players.has(socket.id)) continue;

      const wasHost = room.host === socket.id;
      room.players.delete(socket.id);
      room.votes.delete(socket.id);
      room.assignments.delete(socket.id);

      if (room.players.size === 0) {
        rooms.delete(code);
        continue;
      }

      if (wasHost) {
        // Host is a controller and should not be replaced during an active game.
        // If the controller leaves, the game is ended for safety.
        if (room.phase !== "lobby") {
          io.to(room.code).emit("gameEnded", "The host left the game.");
          rooms.delete(code);
          continue;
        }
        room.host = [...room.players.keys()][0];
        room.phase = "lobby";
        io.to(room.host).emit("hostChanged");
      }

      emitRoom(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Imposter game server listening on ${PORT}`));
