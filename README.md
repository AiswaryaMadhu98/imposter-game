# Multiplayer Imposter Game

A real-time multiplayer web game for up to 30 players. One shared URL, one room code, one imposter.

## Run locally
1. Install Node.js 18+.
2. In this folder run `npm install`.
3. Run `npm start`.
4. Open http://localhost:3000 on your computer.

## Put it online
Deploy this folder to a Node-compatible host such as Render, Railway, or another service that supports a long-running Node.js web service. Use `npm install` as the build/install step and `npm start` as the start command. The service must support WebSockets/Socket.IO.

The current version keeps game rooms in server memory. A room disappears if the server restarts. For a public production version, add persistent storage and authentication/rate limits.
