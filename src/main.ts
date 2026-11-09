import { join } from "node:path";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { Crypto, CryptoError, generateKey } from "./crypto.js";
import { openDb } from "./db/client.js";
import { logger } from "./log.js";
import { MfaBroker } from "./mfa.js";
import { Runner, UnknownConnection } from "./runner.js";
import { RunStore } from "./runs.js";
import { Scheduler } from "./scheduler.js";
import { ConfigStore } from "./store.js";
import { createApp } from "./web/app.js";

const log = logger("main");

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      "data-dir": { type: "string", default: process.env.SURE_SYNC_DATA_DIR ?? "data" },
      host: { type: "string", default: process.env.SURE_SYNC_HOST ?? "0.0.0.0" },
      port: { type: "string", default: process.env.SURE_SYNC_PORT ?? "8686" },
      run: { type: "string" },
      "generate-key": { type: "boolean" },
    },
  });

  if (args["generate-key"]) {
    console.log(generateKey());
    return;
  }

  const key = process.env.SURE_SYNC_SECRET_KEY?.trim();
  if (!key) {
    fail(
      "SURE_SYNC_SECRET_KEY is not set. It encrypts the bank logins stored in the database.\n" +
        "Add this to your .env and keep a copy somewhere safe (losing it means re-entering every login):\n\n" +
        `SURE_SYNC_SECRET_KEY=${generateKey()}\n`,
    );
  }

  const dataDir = args["data-dir"]!;
  let store: ConfigStore;
  try {
    const db = openDb(join(dataDir, "state.db"));
    store = new ConfigStore(db, new Crypto(key));
    store.verifyKey();
  } catch (e) {
    if (e instanceof CryptoError) fail(e.message);
    throw e;
  }
  const runs = new RunStore(store.db);
  const mfa = new MfaBroker();
  const runner = new Runner(store, runs, mfa, dataDir);

  if (args.run) {
    try {
      const id = await runner.run(args.run, "manual");
      const run = runs.get(id)!;
      console.log(run.log);
      process.exit(run.status === "success" ? 0 : 1);
    } catch (e) {
      if (e instanceof UnknownConnection) fail(`no connection ${JSON.stringify(args.run)}`);
      throw e;
    }
  }

  const password = process.env.SURE_SYNC_ADMIN_PASSWORD;
  if (!password) {
    log.warn("SURE_SYNC_ADMIN_PASSWORD not set: web UI has NO login. Anyone who can reach it can change bank logins.");
  }

  const scheduler = new Scheduler(store, runner);
  scheduler.reload();

  const app = createApp({
    store,
    runs,
    runner,
    scheduler,
    mfa,
    dataDir,
    admin: password ? { user: process.env.SURE_SYNC_ADMIN_USER ?? "admin", password } : undefined,
  });
  const port = Number(args.port);
  const server = serve({ fetch: app.fetch, hostname: args.host, port }, () => {
    log.info(`listening on http://${args.host}:${port}`);
  });

  const shutdown = () => {
    log.info("shutting down");
    scheduler.stop();
    server.close();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
