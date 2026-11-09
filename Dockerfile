# Slim Node + only what the app uses: Chromium (with its system libraries)
# and Xvfb for the virtual screen. The Playwright base image also ships
# Firefox, WebKit and a separate headless Chromium (~1.5 GB more).

FROM node:22-bookworm-slim AS build
WORKDIR /app
# compiler for better-sqlite3 when no prebuilt binary matches this Node version
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=build /app/node_modules ./node_modules
# Chromium matching the installed Playwright version, its system libraries and
# fonts (--with-deps), without the headless shell; plus Xvfb.
RUN apt-get update \
    && npx playwright install --with-deps --no-shell chromium \
    && apt-get install -y --no-install-recommends xvfb \
    && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
COPY package.json ./

# Same uid/gid as the old Playwright-based image (pwuser) so existing data volumes keep working.
RUN groupadd --gid 1001 app && useradd --uid 1001 --gid 1001 --create-home app \
    && mkdir -p /data && chown app:app /data
USER app

ENV SURE_SYNC_DATA_DIR=/data \
    SURE_SYNC_PORT=8686
VOLUME ["/data"]
EXPOSE 8686

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SURE_SYNC_PORT||8686)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/main.js"]
