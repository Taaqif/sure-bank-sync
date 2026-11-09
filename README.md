# sure-bank-sync

Scrapes transactions from your banks on a schedule and pushes them into a
self-hosted [Sure](https://github.com/we-promise/sure) instance. Built for a
shared household: each person has their own Sure API key and bank logins,
all managed from a small web UI.

Supported banks: **ANZ** (AU), **Amex** (AU) — in progress. `demo` is a fake
bank for testing the pipeline.

Stack: Node + TypeScript, Playwright, Hono (server-rendered JSX), SQLite via
Drizzle, croner.

## How it works

```
cron (per connection) → Playwright logs into bank → fetch transactions
  → record bank accounts seen → map to Sure accounts (set in UI)
  → skip pending / already synced
  → POST /api/v1/transactions (external_id + source = idempotent)
```

- **Config lives in the database**, edited in the UI: Sure URL and defaults,
  household members (each with their Sure API key), bank connections.
- **Secrets are encrypted** (AES-256-GCM) with `SURE_SYNC_SECRET_KEY` and are
  write-only in the UI: never displayed back.
- **Account mapping**: after a connection's first run, the bank accounts it
  found are listed with a dropdown of your Sure accounts. Unmapped accounts are
  skipped (not lost): map them and run again.
- **Dedupe**: a local record of what was sent, plus Sure's own `external_id`
  check, so re-runs and overlapping lookback windows are safe.
- **MFA**: when a bank asks for a code the run pauses and the dashboard shows
  an input box.
- **Remembered device**: each connection keeps its own browser profile in
  `/data/browser/<id>`, so banks ask for MFA less often.
- **Debugging**: failed runs save a screenshot + HTML of the page, viewable
  from the run page.

## Setup

```bash
cp .env.example .env
docker compose run --rm sure-bank-sync --generate-key   # paste into SURE_SYNC_SECRET_KEY
# set SURE_SYNC_ADMIN_PASSWORD too
chmod 600 .env
docker compose up -d --build
```

Open http://localhost:8686 (log in as `admin`) and follow the setup steps:

1. **Settings** → Sure URL (as seen from the container, e.g.
   `http://host.docker.internal:3000` if Sure runs on the host, or its
   service name if you join Sure's compose network).
2. **Household** → add each person with a Sure API key (Sure → Settings →
   API Keys, read/write).
3. **Add connection** → pick bank and enter login → **Run now** → map the
   discovered accounts → **Run now** again.

**Back up `SURE_SYNC_SECRET_KEY`.** Without it the saved logins in `/data`
can't be decrypted and must be re-entered.

## CLI

```bash
docker compose run --rm sure-bank-sync --generate-key
docker compose run --rm sure-bank-sync --run alice-anz   # one run, print log, exit
```

## Development

```bash
npm install
npx playwright install chromium
cp .env.example .env   # set SURE_SYNC_SECRET_KEY
npm run dev            # http://localhost:8686, data in ./data
npm test
npm run typecheck
```

Schema changes: edit `src/db/schema.ts`, run `npm run db:generate`, commit the
new file in `drizzle/`. Migrations apply automatically on start.

### Layout

| Path | What |
|---|---|
| `src/main.ts` | entry point, env, CLI flags |
| `src/store.ts` | config (settings, people, connections, account mappings) |
| `src/runs.ts` | run history, synced-transaction record |
| `src/runner.ts` | one sync: browser, provider, push |
| `src/push.ts` | mapping, dedupe, upload to Sure |
| `src/scheduler.ts` | cron jobs, reloaded on config change |
| `src/providers/` | bank scrapers |
| `src/web/` | Hono routes + JSX views |

### Adding a bank

Create `src/providers/<bank>.ts` exporting a `ProviderDefinition` (name,
label, credential fields, `create(ctx)` returning `login()` and
`fetchTransactions({ since, until })`), and register it in
`src/providers/index.ts`. Use `ctx.browser` (Playwright context),
`ctx.requestMfa(prompt)` and `snapshot(ctx, name)`. Amounts are integer cents,
negative = money out.

## Security notes

The container holds bank logins and logged-in browser sessions. Keep the UI on
your LAN or behind a VPN/reverse proxy, always set `SURE_SYNC_ADMIN_PASSWORD`,
and protect the `/data` volume and your `.env`. Anyone with the admin login
can change any household member's bank connection (but can't read saved
passwords back).
