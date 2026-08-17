# NestJS API. Build context is the repository root, not backend/.
FROM node:24-bookworm-slim AS build
# node:*-slim ships without OpenSSL. Prisma's query engine needs it and otherwise
# warns "failed to detect the libssl/openssl version" and falls back to a guess.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Manifests first so the install layer is cached until a dependency changes.
# Every package named in the root `workspaces` array is copied, otherwise
# `npm ci` compares the lockfile against an incomplete workspace and refuses.
# package.json carries `allowScripts`, without which Prisma, sharp and
# ffmpeg-static install with their scripts unrun and the image builds a backend
# with no query engine.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY backend/package.json ./backend/
COPY web/package.json ./web/
COPY mobile/package.json ./mobile/
RUN npm ci

COPY shared ./shared
COPY backend ./backend
RUN npm run db:generate --workspace @texasrenters/backend \
  && npm run build --workspace @texasrenters/shared \
  && npm run build --workspace @texasrenters/backend

FROM node:24-bookworm-slim AS runtime
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV PORT=3000
# Containers must listen on every interface, not loopback, or the Docker network
# (and therefore ngrok) cannot reach the service.
ENV HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/backend/node_modules ./backend/node_modules
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/package.json ./backend/package.json
COPY --from=build /app/backend/prisma ./backend/prisma
# Operational scripts, not application code: the first-administrator bootstrap
# runs from here, and so does anything a deployed database needs doing to it
# later. Without them a VPS has no way to run maintenance that is not a
# hand-written one-off against a live database.
COPY --from=build /app/backend/scripts ./backend/scripts
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/shared/package.json ./shared/package.json
USER node
EXPOSE 3000
# Liveness only — deliberately not the readiness route, so the container health
# state never depends on Supabase or Cloudflare being reachable.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=10 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "backend/dist/main.js"]
