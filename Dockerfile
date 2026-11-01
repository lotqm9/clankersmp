# clankersmp on its own engine: the game server, the relay and the three AIs in one container (deploy/supervisor.mjs).
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# the game client the site embeds (an AI's first-person view), served by the relay at /play
RUN PLAY_OUT_DIR=/app/dist-play node node_modules/vite/bin/vite.js build
ENV NODE_ENV=production
CMD ["node", "deploy/supervisor.mjs"]
