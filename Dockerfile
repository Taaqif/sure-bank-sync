# Playwright image ships Node + Chromium + system libs. Tag must match the
# "playwright" version in package.json exactly.
FROM mcr.microsoft.com/playwright:v1.65.0-noble AS base
WORKDIR /app
ENV NODE_ENV=production

FROM base AS build
# compiler for better-sqlite3 when no prebuilt binary matches this Node version
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM base
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
COPY package.json ./

RUN mkdir -p /data && chown pwuser:pwuser /data
USER pwuser

ENV SURE_SYNC_DATA_DIR=/data \
    SURE_SYNC_PORT=8686 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
VOLUME ["/data"]
EXPOSE 8686

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8686/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/main.js"]
