# $STEVE Craft survival game server. Build context: this folder (server/). The bundle in dist/ has no npm dependencies.
# Runs as root on purpose: Railway mounts volumes root-owned, and a non-root user cannot write the world there.
# The survival world lives in /data/survival: the volume's old builder world (/data/shard-1, /data/salt.txt, ...) is
# left exactly as it is, so the builder can come back (sites/steve-game) with its world.
# The charity defaults to Gamers Outreach; Railway variables override any of these. COIN_CA (or STEVE_CA) unset = the
# meter says "starts at launch".
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    WORLD_DIR=/data \
    SURVIVAL_WORLD_DIR=/data/survival \
    CHARITY_NAME="Gamers Outreach" \
    CHARITY_X=GamersOutreach \
    PORT=8080
COPY dist/server.mjs ./server.mjs
RUN mkdir -p /data/survival
EXPOSE 8080
CMD ["node", "server.mjs"]
