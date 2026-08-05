# Next.js admin app. Build context is the repository root, not web-app/.
#
# Uses Next's standalone output, which traces only the modules the server
# actually imports. In a pnpm workspace that trace must be rooted at the repo
# root or the symlinked @texasrenters/shared package is left out — see
# outputFileTracingRoot in web-app/next.config.ts.
FROM node:24-bookworm-slim AS build
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json ./shared/
COPY backend/package.json ./backend/
COPY web-app/package.json ./web-app/
COPY mobile/package.json ./mobile/
RUN pnpm install --frozen-lockfile

COPY shared ./shared
COPY web-app ./web-app

# NEXT_PUBLIC_* values are inlined into the client bundle at build time, so they
# must be present here rather than at runtime. All four are browser-readable by
# definition; a service-role key must never be passed as a build arg.
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:3000
ARG NEXT_PUBLIC_SUPABASE_URL=
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=
ARG NEXT_PUBLIC_ENABLE_DEMO_DATA=false
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_ENABLE_DEMO_DATA=$NEXT_PUBLIC_ENABLE_DEMO_DATA
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

RUN pnpm --filter @texasrenters/shared build \
  && pnpm --filter @texasrenters/web-app build

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
COPY --from=build /app/web-app/.next-build/standalone ./
COPY --from=build /app/web-app/.next-build/static ./web-app/.next-build/static
COPY --from=build /app/web-app/public ./web-app/public

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
CMD ["node", "web-app/server.js"]
