/**
 * App configuration kept in SQLite and edited through the web UI.
 *
 * Secrets (Sure API keys, bank credentials) are encrypted with Crypto and only
 * decrypted when a run needs them. They are never sent back to the UI.
 */
import { Cron } from "croner";
import { and, asc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import type { Crypto } from "./crypto.js";
import { nowIso, type Db } from "./db/client.js";
import { bankAccounts, connections, settings, users, type BankAccountRow } from "./db/schema.js";

export class ValidationError extends Error {}

export function validateCron(expr: string): string {
  const clean = expr.trim().split(/\s+/).join(" ");
  if (clean.split(" ").length !== 5) throw new ValidationError(`cron needs 5 fields (min hour day month weekday): ${JSON.stringify(expr)}`);
  try {
    new Cron(clean, { paused: true }).stop();
  } catch (e) {
    throw new ValidationError(`invalid cron expression ${JSON.stringify(clean)}: ${(e as Error).message}`);
  }
  return clean;
}

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const SettingsSchema = z.object({
  sureUrl: z
    .string()
    .trim()
    .transform((s) => s.replace(/\/+$/, ""))
    .refine((s) => s === "" || /^https?:\/\/\S+$/.test(s), "Sure URL must start with http:// or https://"),
  sureSource: z
    .string()
    .trim()
    .transform((s) => s || "sure-bank-sync"),
  timezone: z.string().trim().refine(validTimezone, "unknown timezone"),
  schedule: z.string(),
  /** default schedule for statement imports (connections that turn them on) */
  statementSchedule: z.string(),
  skipPending: z.boolean(),
  mfaTimeoutSeconds: z.coerce.number().int().min(30, "MFA timeout must be 30-3600s").max(3600, "MFA timeout must be 30-3600s"),
  /** runs with a browser working at the same time (runs waiting for a person don't count, up to the same number again) */
  maxBrowsers: z.coerce.number().int().min(1, "Browsers at once must be 1-4").max(4, "Browsers at once must be 1-4"),
  /** never write to Sure; log what would have been sent */
  dryRun: z.boolean(),
  /** save the browser's network log with failed runs' debug files (debug runs always do) */
  saveNetworkLog: z.boolean(),
  /** logs may include transaction details and full account numbers */
  verboseLogs: z.boolean(),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  sureUrl: "",
  sureSource: "sure-bank-sync",
  timezone: "Australia/Melbourne",
  schedule: "0 6 * * *",
  // Every 6 months, a week after banks issue half-yearly statements (early Jan / Jul).
  statementSchedule: "0 7 15 1,7 *",
  skipPending: true,
  mfaTimeoutSeconds: 300,
  maxBrowsers: 2,
  dryRun: false,
  saveNetworkLog: false,
  verboseLogs: false,
};

export interface User {
  id: number;
  name: string;
}

export interface Connection {
  id: string;
  userId: number;
  userName: string;
  provider: string;
  enabled: boolean;
  schedule: string | null;
  lookbackDays: number | null;
  statementsEnabled: boolean;
  /** null = default statement schedule */
  statementSchedule: string | null;
  options: Record<string, unknown>;
  /** which secrets are set (never the values) */
  credentialKeys: string[];
}

export interface ConnectionInput {
  userId: number;
  provider: string;
  enabled: boolean;
  schedule: string | null;
  lookbackDays: number | null;
  /** default: off */
  statementsEnabled?: boolean;
  statementSchedule?: string | null;
  /** blank values keep what's stored */
  credentials: Record<string, string>;
  options: Record<string, unknown>;
}

function zodMessage(e: z.ZodError): string {
  return e.issues.map((i) => i.message).join("; ");
}

export class ConfigStore {
  constructor(
    readonly db: Db,
    private readonly crypto: Crypto,
  ) {}

  // --- settings -------------------------------------------------------
  settings(): Settings {
    const rows = this.db.select().from(settings).all();
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const r of rows) if (r.key in DEFAULT_SETTINGS) out[r.key] = r.value;
    return out as Settings;
  }

  isConfigured(): boolean {
    return this.settings().sureUrl !== "";
  }

  saveSettings(input: unknown): Settings {
    const parsed = SettingsSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError(zodMessage(parsed.error));
    const s = {
      ...parsed.data,
      schedule: validateCron(parsed.data.schedule),
      statementSchedule: validateCron(parsed.data.statementSchedule),
    };
    this.db.transaction((tx) => {
      for (const [key, value] of Object.entries(s)) {
        tx.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
      }
    });
    return s;
  }

  // --- users ----------------------------------------------------------
  users(): User[] {
    return this.db.select({ id: users.id, name: users.name }).from(users).orderBy(asc(users.name)).all();
  }

  user(id: number): User | undefined {
    return this.db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, id)).get();
  }

  sureApiKey(userId: number): string {
    const r = this.db.select({ k: users.sureApiKey }).from(users).where(eq(users.id, userId)).get();
    if (!r) throw new Error(`no user ${userId}`);
    return this.crypto.decrypt(r.k);
  }

  /** Create (id = null) or update. A blank API key on update keeps the old one. */
  saveUser(id: number | null, name: string, sureApiKey: string): number {
    name = name.trim();
    sureApiKey = sureApiKey.trim();
    if (!name) throw new ValidationError("name is required");
    const clash = this.db
      .select({ id: users.id })
      .from(users)
      .where(id === null ? eq(users.name, name) : and(eq(users.name, name), ne(users.id, id)))
      .get();
    if (clash) throw new ValidationError(`a person named ${JSON.stringify(name)} already exists`);

    if (id === null) {
      if (!sureApiKey) throw new ValidationError("Sure API key is required");
      const r = this.db
        .insert(users)
        .values({ name, sureApiKey: this.crypto.encrypt(sureApiKey) })
        .returning({ id: users.id })
        .get();
      return r.id;
    }
    this.db
      .update(users)
      .set({ name, ...(sureApiKey ? { sureApiKey: this.crypto.encrypt(sureApiKey) } : {}) })
      .where(eq(users.id, id))
      .run();
    return id;
  }

  deleteUser(id: number): void {
    this.db.delete(users).where(eq(users.id, id)).run();
  }

  // --- connections ----------------------------------------------------
  #toConnection(r: typeof connections.$inferSelect & { userName: string }): Connection {
    const creds = JSON.parse(this.crypto.decrypt(r.credentials)) as Record<string, string>;
    return {
      id: r.id,
      userId: r.userId,
      userName: r.userName,
      provider: r.provider,
      enabled: r.enabled,
      schedule: r.schedule,
      lookbackDays: r.lookbackDays,
      statementsEnabled: r.statementsEnabled,
      statementSchedule: r.statementSchedule,
      options: r.options,
      credentialKeys: Object.keys(creds)
        .filter((k) => creds[k])
        .sort(),
    };
  }

  #connectionQuery() {
    return this.db
      .select({
        id: connections.id,
        userId: connections.userId,
        provider: connections.provider,
        enabled: connections.enabled,
        schedule: connections.schedule,
        lookbackDays: connections.lookbackDays,
        statementsEnabled: connections.statementsEnabled,
        statementSchedule: connections.statementSchedule,
        credentials: connections.credentials,
        options: connections.options,
        userName: users.name,
      })
      .from(connections)
      .innerJoin(users, eq(users.id, connections.userId));
  }

  connections(): Connection[] {
    return this.#connectionQuery()
      .orderBy(asc(users.name), asc(connections.id))
      .all()
      .map((r) => this.#toConnection(r));
  }

  connection(id: string): Connection | undefined {
    const r = this.#connectionQuery().where(eq(connections.id, id)).get();
    return r ? this.#toConnection(r) : undefined;
  }

  credentials(id: string): Record<string, string> {
    const r = this.db.select({ c: connections.credentials }).from(connections).where(eq(connections.id, id)).get();
    if (!r) throw new Error(`no connection ${id}`);
    return JSON.parse(this.crypto.decrypt(r.c)) as Record<string, string>;
  }

  newConnectionId(userName: string, provider: string): string {
    const base = `${userName}-${provider}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "conn";
    const existing = new Set(this.db.select({ id: connections.id }).from(connections).all().map((r) => r.id));
    let id = base;
    for (let n = 2; existing.has(id); n++) id = `${base}-${n}`;
    return id;
  }

  /** Create (id = null) or update. Blank credential values keep what's stored. */
  saveConnection(id: string | null, input: ConnectionInput): string {
    const user = this.user(input.userId);
    if (!user) throw new ValidationError("unknown person");
    const schedule = input.schedule?.trim() ? validateCron(input.schedule) : null;
    const statementSchedule = input.statementSchedule?.trim() ? validateCron(input.statementSchedule) : null;
    // 0 = all time (only offered for banks that support it).
    if (input.lookbackDays !== null && !(Number.isInteger(input.lookbackDays) && input.lookbackDays >= 0 && input.lookbackDays <= 3650)) {
      throw new ValidationError("sync period must be 1-3650 days, or all time");
    }
    const merged = id ? this.credentials(id) : {};
    for (const [k, v] of Object.entries(input.credentials)) if (v) merged[k] = v;
    const values = {
      userId: input.userId,
      enabled: input.enabled,
      schedule,
      lookbackDays: input.lookbackDays,
      statementsEnabled: input.statementsEnabled ?? false,
      statementSchedule,
      credentials: this.crypto.encrypt(JSON.stringify(merged)),
      options: input.options,
    };
    if (id === null) {
      id = this.newConnectionId(user.name, input.provider);
      this.db.insert(connections).values({ id, provider: input.provider, ...values }).run();
    } else {
      this.db.update(connections).set(values).where(eq(connections.id, id)).run();
    }
    return id;
  }

  deleteConnection(id: string): void {
    this.db.delete(connections).where(eq(connections.id, id)).run();
  }

  // --- bank accounts / mappings ---------------------------------------
  bankAccounts(connectionId: string): BankAccountRow[] {
    return this.db
      .select()
      .from(bankAccounts)
      .where(eq(bankAccounts.connectionId, connectionId))
      .orderBy(asc(bankAccounts.name))
      .all();
  }

  /** Upsert accounts seen during a run so they show up for mapping. */
  recordBankAccounts(connectionId: string, accounts: { id: string; name: string; currency: string }[]): void {
    const ts = nowIso();
    this.db.transaction((tx) => {
      for (const a of accounts) {
        tx.insert(bankAccounts)
          .values({ connectionId, bankAccountId: a.id, name: a.name, currency: a.currency, firstSeen: ts, lastSeen: ts })
          .onConflictDoUpdate({
            target: [bankAccounts.connectionId, bankAccounts.bankAccountId],
            set: { name: a.name, currency: a.currency, lastSeen: ts },
          })
          .run();
      }
    });
  }

  setMapping(connectionId: string, bankAccountId: string, sureAccountId: string | null, ignored: boolean): void {
    this.db
      .update(bankAccounts)
      .set({ sureAccountId: sureAccountId || null, ignored })
      .where(and(eq(bankAccounts.connectionId, connectionId), eq(bankAccounts.bankAccountId, bankAccountId)))
      .run();
  }

  /** Fail fast at startup if the secret key can't read existing data. */
  verifyKey(): void {
    const r = this.db.select({ k: users.sureApiKey }).from(users).limit(1).get();
    if (r) this.crypto.decrypt(r.k);
  }
}
