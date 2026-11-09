FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH"

COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /usr/local/bin/uv

WORKDIR /app

# Dependencies first for layer caching
COPY pyproject.toml uv.lock* ./
RUN uv sync --no-dev --no-install-project

# Chromium + its system libs (matches installed playwright version)
RUN playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

COPY src ./src
RUN uv sync --no-dev

RUN useradd --create-home --uid 1000 app \
    && mkdir -p /data \
    && chown -R app:app /data /ms-playwright
USER app

ENV SURE_SYNC_CONFIG=/config/config.yaml \
    SURE_SYNC_DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 8686

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8686/healthz').status==200 else 1)"

CMD ["sure-bank-sync"]
