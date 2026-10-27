# IMPOSTER — Multiplayer Party Game

Real-time web game for **3–40 players**. One host creates a room, shares a code or link, deals secret words, watches who the imposters are, opens voting, and reveals results.

## How it works

1. **Host** creates a room and shares the code or join link.
2. Players join live in the lobby (host sees everyone arrive).
3. Host starts the game and enters one crew word plus separate imposter word(s).
4. Each player gets a private word notification. Imposters get the odd word(s). Host sees who the imposters are.
5. The group discusses offline, then the host opens voting.
6. Everyone connected votes. If someone leaves mid-game, voting can still finish.
7. Host reveals results, then can play another round, return to lobby, or exit.

## Run locally

1. Install Node.js 18+.
2. In this folder run `npm install`.
3. Run `npm start`.
4. Open the URL printed in the terminal (default port **3847**).

```bash
npm install
npm start
