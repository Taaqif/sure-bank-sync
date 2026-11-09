# sure-bank-sync

Scrapes transactions from your banks on a schedule and pushes them into a
self-hosted [Sure](https://github.com/we-promise/sure) instance. Built for a
shared household: each person has their own Sure API key and bank logins.

Supported banks: **ANZ** (AU), **Amex** (AU) — in progress. `demo` is a fake
bank for testing the pipeline.

## How it works

```
cron (per connection) → Playwright logs into bank → fetch transactions
  → map bank account → Sure account → skip pending / already synced
  → POST /api/v1/transactions (external_id + source = idempotent)
```

- **Dedupe** twice: a local SQLite record of what was sent, and Sure's own
  `external_id` check, so re-runs and overlapping lookback windows are safe.
- **MFA**: when a bank asks for a code, the run pauses and the web UI shows an
  input box. Type the code there within `mfa_timeout_seconds`.
- **Remembered device**: each connection keeps its own browser profile in
  `/data/browser/<id>`, so banks see a returning device and ask for MFA less.
- **Debugging**: failed runs save a screenshot + HTML of the page, viewable
  from the run page in the UI.

## Setup

```bash
cp config/config.example.yaml config/config.yaml   # edit users/connections/account mappings
cp .env.example .env                               # fill in secrets
docker compose run --rm sure-bank-sync sure-bank-sync --check
docker compose up -d --build
```

Open http://localhost:8686 (change the host side with `HOST_PORT` in `.env`).

Sure API key: Sure → Settings → API Keys, with read/write scope.
Sure account ids: `curl -H "X-Api-Key: $KEY" $SURE_URL/api/v1/accounts`.

If Sure runs in another compose project, uncomment the `networks` block in
`docker-compose.yml` and point `sure.url` at its service name.

## Config

See `config/config.example.yaml`. Secrets can be `${ENV_VAR}`,
`${ENV_VAR:-default}` or `${file:/run/secrets/name}`.

## CLI

```bash
sure-bank-sync --check                 # validate config
sure-bank-sync --run alice-anz         # one run, print log, exit
```

## Development

```bash
uv sync
uv run playwright install chromium
uv run pytest
```

### Adding a bank

Subclass `BankProvider` in `src/sure_sync/providers/`, implement `login()` and
`fetch_transactions()`, register it in `providers/__init__.py`. Use
`self.ctx.browser` (Playwright context), `self.ctx.request_mfa(prompt)` and
`self.ctx.snapshot(name)`. Return amounts with negative = money out.

## Security notes

The container holds bank passwords and a persistent logged-in browser profile.
Keep the UI on your LAN or behind a VPN/reverse proxy, set `web.username` /
`web.password`, and protect the `/data` volume.
