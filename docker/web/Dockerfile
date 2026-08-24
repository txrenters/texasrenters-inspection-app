# Next.js admin console. Build context is the repository root, not web/.
#
# This replaces docker/web/Dockerfile, which builds the older web-app. The two
# are kept side by side rather than one being edited in place: the compose `web`
# service selects between them with a single `dockerfile:` line, so reverting to
# the previous console is a one-line change and a rebuild.
#
# Uses Next's standalone output, which traces only the modules the server
# actually imports. In a workspace that trace must be rooted at the repo root or
# the linked @texasrenters/shared package is left out — see
# outputFileTracingRoot in web/next.config.ts.
FROM node:24-bookworm-slim AS build
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Every package named in the root `workspaces` array is copied, otherwise
# `npm ci` resolves the lockfile against a workspace that does not match it.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY backend/package.json ./backend/
COPY web/package.json ./web/
COPY mobile/package.json ./mobile/
RUN npm ci

COPY shared ./shared
COPY web ./web

# NEXT_PUBLIC_* values are inlined into the client bundle at build time, so they
# must be present here rather than at runtime. Both are browser-readable by
# definition; a secret must never be passed as a build arg.
#
# Compose fills these by interpolation from its --env-file, which the docker:*
# scripts point at web/.env.local and the prod:* scripts at .env.production.
# Changing that file needs a rebuild, not a restart — the value is compiled
# into the bundle.
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:3000
# The release this image is, shown in the console sidebar. Build-time by
# necessity: Next inlines NEXT_PUBLIC_* and a version that a restart could
# change would not be describing the build.
ARG NEXT_PUBLIC_APP_VERSION
ENV NEXT_PUBLIC_APP_VERSION=$NEXT_PUBLIC_APP_VERSION
ARG NEXT_PUBLIC_ENABLE_DEMO_DATA=false
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_ENABLE_DEMO_DATA=$NEXT_PUBLIC_ENABLE_DEMO_DATA
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

RUN npm run build --workspace @texasrenters/shared \
  && npm run build --workspace @texasrenters/web

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=5454
# Next's standalone server binds to this; loopback would be unreachable from
# outside the container.
ENV HOSTNAME=0.0.0.0
WORKDIR /app

# next.config.ts sets distDir to .next-build for production builds, so the
# standalone bundle and the static assets live under that directory rather than
# the conventional .next.
COPY --from=build /app/web/.next-build/standalone ./
COPY --from=build /app/web/.next-build/static ./web/.next-build/static
COPY --from=build /app/web/public ./web/public

# Next bundles @texasrenters/shared into the server chunks, so the traced output
# contains shared/package.json but no shared/dist. That package.json declares
# "main": "dist/index.js", so any module Next cannot statically analyse — a
# dynamic import, or a require() added later — would resolve to a missing file
# at request time rather than at build time. A few kilobytes closes that gap.
COPY --from=build /app/shared/dist ./shared/dist

USER node
EXPOSE 5454
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=10 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5454)).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "web/server.js"]
