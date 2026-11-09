import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// --- configuration (edited in the web UI) ------------------------------

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
});

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  /** encrypted */
  sureApiKey: text("sure_api_key").notNull(),
});

export const connections = sqliteTable("connections", {
  id: text("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** null = use default */
  schedule: text("schedule"),
  /** null = use default */
  lookbackDays: integer("lookback_days"),
  /** encrypted JSON object */
  credentials: text("credentials").notNull(),
  options: text("options", { mode: "json" }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
});

/** Bank accounts discovered during runs, and which Sure account each goes to. */
export const bankAccounts = sqliteTable(
  "bank_accounts",
  {
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    bankAccountId: text("bank_account_id").notNull(),
    name: text("name").notNull(),
    currency: text("currency").notNull(),
    /** null = not mapped yet */
    sureAccountId: text("sure_account_id"),
    ignored: integer("ignored", { mode: "boolean" }).notNull().default(false),
    firstSeen: text("first_seen").notNull(),
    lastSeen: text("last_seen").notNull(),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.bankAccountId] })],
);

// --- run history / sync state ------------------------------------------

/** queued: waiting for its bank or a browser slot */
export type RunStatus = "queued" | "running" | "awaiting_mfa" | "success" | "failed" | "cancelled";

export const runs = sqliteTable(
  "runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    connectionId: text("connection_id").notNull(),
    userName: text("user_name").notNull(),
    trigger: text("trigger").$type<"schedule" | "manual" | "discover" | "train">().notNull(),
    /** nothing was written to Sure; `created` counts would-be writes */
    dryRun: integer("dry_run", { mode: "boolean" }).notNull().default(false),
    status: text("status").$type<RunStatus>().notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    fetched: integer("fetched").notNull().default(0),
    created: integer("created").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    unmapped: integer("unmapped").notNull().default(0),
    error: text("error"),
    log: text("log").notNull().default(""),
  },
  (t) => [index("runs_conn").on(t.connectionId, t.id)],
);

/** Transactions already pushed to Sure (no FK: history outlives deleted connections). */
export const synced = sqliteTable(
  "synced",
  {
    connectionId: text("connection_id").notNull(),
    externalId: text("external_id").notNull(),
    sureAccountId: text("sure_account_id").notNull(),
    sureEntryId: text("sure_entry_id"),
    syncedAt: text("synced_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.externalId] })],
);

export type Run = typeof runs.$inferSelect;
export type BankAccountRow = typeof bankAccounts.$inferSelect;
