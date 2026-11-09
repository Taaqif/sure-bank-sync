# sure-bank-sync

Scrapes transactions from your banks on a schedule and pushes them into a
self-hosted [Sure](https://github.com/we-promise/sure) instance. Built for a
shared household: each person has their own Sure API key and bank logins,
all managed from a small web UI.

Supported banks: **ANZ Internet Banking** (AU), **Amex** (AU, in progress).
`demo` is a fake bank for testing the pipeline.

Stack: Node + TypeScript, Playwright, Hono (server-rendered JSX), SQLite via
Drizzle, croner.

## How it works

```
cron (per connection) → Playwright logs into bank → fetch transactions
  → record bank accounts seen → map to Sure accounts (set in UI)
  → skip pending / already synced
  → one CSV import per Sure account: POST /api/v1/imports (publish=true)
  → poll the import until Sure reports complete, then mark rows synced
```

- **Config lives in the database**, edited in the UI: Sure URL and defaults,
  household members (each with their Sure API key), bank connections.
- **Secrets are encrypted** (AES-256-GCM) with `SURE_SYNC_SECRET_KEY` and are
  write-only in the UI: never displayed back.
- **Account mapping**: after a connection's first run, the bank accounts it
  found are listed with a dropdown of your Sure accounts. Unmapped accounts are
  skipped (not lost): map them and run again.
- **Imports, not single transactions**: rows go to Sure through its CSV import
  API, so they show up under Imports in Sure and can be reverted there as a batch.
- **Dedupe**: a local record of what Sure confirmed, plus Sure's import
  matching (date + amount + currency + name updates an existing entry instead
  of duplicating), so re-runs and overlapping lookback windows are safe.
- **Dry run / Discover accounts**: dry runs log every row they would import
  and write nothing; Discover accounts only lists accounts for mapping.
- **Schedule and sync period** are set in the UI: pick hourly / every few
  hours / daily / weekdays / weekly (or type a cron) with a preview of the
  next runs, and how many days of history each run fetches. Both have a
  default in Settings and an optional per-connection override.
- **MFA**: when a bank asks for a code the run pauses and the dashboard shows
  an input box.
- **CAPTCHAs and other "prove you're human" steps**: the run pauses and the
  dashboard shows **Open browser**: a live view of the run's (headless)
  browser where you click and type to solve it. The run carries on by itself
  once the check is gone, or when you press Done. Nothing is solved
  automatically. Try it with the demo bank and options `{"captcha": true}`.
- **Cancel**: any run in progress can be stopped from the dashboard,
  connection or run page.
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

## Development: watching the browser

Normal runs use Chrome with a real window on an invisible virtual screen
(Xvfb, included in the Docker image), because Amex blocks windowless
(headless) Chrome. If Xvfb is missing the app falls back to headless and says
so in the run log; `SURE_SYNC_HEADLESS=1` forces headless. Start the app with `SURE_SYNC_DEBUG=1` and
each connection gets a **Debug run** button: a dry run with a visible, slowed
down browser (needs a display, e.g. WSLg on Windows) that also saves the bank's
JSON responses and downloaded files to the run's debug folder.

```bash
SURE_SYNC_DEBUG=1 SURE_SYNC_PORT=8687 npm run dev
# SURE_SYNC_PAUSE_ON_ERROR=1 opens the Playwright Inspector when a debug run fails
```

Run logs include every page the browser visits (`nav: …`, query strings
stripped).

## Banks

**ANZ Internet Banking**: logs in with CRN + password, reads the account tiles
on the home page, then for each account clicks the tile → Download, picks a
duration covering the lookback (max 120 days) with "Microsoft Excel(CSV)", and
parses the file (date, signed amount, description).

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
