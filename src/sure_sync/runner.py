"""Runs one sync for one connection: scrape -> map -> dedupe -> push to Sure."""

from __future__ import annotations

import asyncio
import logging
import shutil
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from playwright.async_api import Playwright, async_playwright

from .config import AppConfig, ConnectionConfig, UserConfig
from .db import Database
from .mfa import MfaBroker
from .models import BankTransaction, assign_external_ids
from .providers import PROVIDERS, ProviderContext, ProviderError
from .sure_client import SureClient, SureError

log = logging.getLogger(__name__)

DEBUG_DIRS_KEPT = 30


class AlreadyRunning(Exception):
    pass


class Runner:
    def __init__(self, config: AppConfig, db: Database, mfa: MfaBroker, data_dir: Path, max_concurrent: int = 2):
        self.config = config
        self.db = db
        self.mfa = mfa
        self.data_dir = data_dir
        self._locks: dict[str, asyncio.Lock] = {}
        self._browser_slots = asyncio.Semaphore(max_concurrent)
        self._pw_cm = None
        self._pw: Playwright | None = None

    async def start(self) -> None:
        self._pw_cm = async_playwright()
        self._pw = await self._pw_cm.start()

    async def stop(self) -> None:
        if self._pw_cm:
            await self._pw_cm.__aexit__(None, None, None)

    def is_running(self, conn_id: str) -> bool:
        lock = self._locks.get(conn_id)
        return bool(lock and lock.locked())

    async def run(self, conn_id: str, trigger: str = "schedule") -> int:
        found = self.config.find_connection(conn_id)
        if not found:
            raise KeyError(conn_id)
        user, conn = found
        lock = self._locks.setdefault(conn_id, asyncio.Lock())
        if lock.locked():
            raise AlreadyRunning(conn_id)
        async with lock:
            run_id = self.db.start_run(conn_id, user.name, trigger)
            await self._run(run_id, user, conn)
            return run_id

    def start_background(self, conn_id: str, trigger: str = "manual") -> asyncio.Task[int]:
        if self.is_running(conn_id):
            raise AlreadyRunning(conn_id)
        task = asyncio.create_task(self.run(conn_id, trigger))
        task.add_done_callback(_log_task_error)
        return task

    async def _run(self, run_id: int, user: UserConfig, conn: ConnectionConfig) -> None:
        def rlog(msg: str) -> None:
            log.info("[%s #%d] %s", conn.id, run_id, msg)
            self.db.append_log(run_id, f"{datetime.now().strftime('%H:%M:%S')} {msg}")

        stats = dict(fetched=0, created=0, skipped=0, unmapped=0)
        debug_dir = self.data_dir / "debug" / f"run-{run_id}"
        try:
            provider_cls = PROVIDERS.get(conn.provider)
            if not provider_cls:
                raise ProviderError(f"unknown provider {conn.provider!r} (known: {', '.join(PROVIDERS)})")
            creds = {k: v.get_secret_value() for k, v in conn.credentials.items()}
            missing = [k for k in provider_cls.required_credentials if not creds.get(k)]
            if missing:
                raise ProviderError(f"missing credentials: {', '.join(missing)}")

            tz = ZoneInfo(self.config.timezone)
            until = datetime.now(tz).date()
            since = until - timedelta(days=conn.lookback_days or self.config.lookback_days)

            rlog(f"waiting for browser slot ({conn.provider}, {since} → {until})")
            async with self._browser_slots:
                txns = await self._scrape(run_id, conn, creds, debug_dir, since, until, rlog)
            stats["fetched"] = len(txns)
            rlog(f"fetched {len(txns)} transactions")

            await self._push(user, conn, txns, stats, rlog)
            self.db.finish_run(run_id, "success", **stats)
            rlog(f"done: {stats['created']} new, {stats['skipped']} already synced, {stats['unmapped']} unmapped")
        except Exception as e:  # record every failure on the run
            msg = str(e) if isinstance(e, (ProviderError, SureError)) else f"{type(e).__name__}: {e}"
            rlog(f"FAILED: {msg}")
            if not isinstance(e, (ProviderError, SureError)):
                log.exception("run %d crashed", run_id)
            self.db.finish_run(run_id, "failed", error=msg, **stats)
        finally:
            self._prune_debug()

    async def _scrape(
        self,
        run_id: int,
        conn: ConnectionConfig,
        creds: dict[str, str],
        debug_dir: Path,
        since: date,
        until: date,
        rlog,
    ) -> list[BankTransaction]:
        assert self._pw, "Runner.start() not called"
        profile = self.data_dir / "browser" / conn.id
        profile.mkdir(parents=True, exist_ok=True)
        browser = await self._pw.chromium.launch_persistent_context(
            str(profile),
            headless=conn.options.get("headless", True),
            accept_downloads=True,
            locale="en-AU",
            timezone_id=self.config.timezone,
            viewport={"width": 1366, "height": 900},
            args=["--disable-blink-features=AutomationControlled"],
        )

        async def request_mfa(prompt: str) -> str:
            rlog(f"waiting for MFA code: {prompt}")
            self.db.set_status(run_id, "awaiting_mfa")
            try:
                return await self.mfa.request(conn.id, run_id, prompt, self.config.mfa_timeout_seconds)
            finally:
                self.db.set_status(run_id, "running")

        ctx = ProviderContext(
            connection_id=conn.id,
            credentials=creds,
            options=conn.options,
            browser=browser,
            debug_dir=debug_dir,
            log=rlog,
            request_mfa=request_mfa,
        )
        provider = PROVIDERS[conn.provider](ctx)
        try:
            await provider.login()
            rlog("logged in")
            txns = await provider.fetch_transactions(since, until)
            try:
                await provider.logout()
            except Exception as e:
                rlog(f"logout failed (ignored): {e}")
            return txns
        except Exception:
            await ctx.snapshot("failure")
            raise
        finally:
            await browser.close()

    async def _push(self, user: UserConfig, conn: ConnectionConfig, txns: list[BankTransaction], stats, rlog) -> None:
        if self.config.skip_pending:
            pending = [t for t in txns if t.pending]
            if pending:
                rlog(f"skipping {len(pending)} pending")
            txns = [t for t in txns if not t.pending]

        assign_external_ids(txns)

        mapped: list[tuple[str, BankTransaction]] = []
        unmapped_accounts: set[str] = set()
        for t in txns:
            target = next((m.sure_account_id for m in conn.accounts if t.account.matches(m.match)), None)
            if target:
                mapped.append((target, t))
            else:
                stats["unmapped"] += 1
                unmapped_accounts.add(f"{t.account.name} ({t.account.id})")
        for a in sorted(unmapped_accounts):
            rlog(f"no account mapping for {a}: add it under `accounts:` in config")

        done = self.db.already_synced(conn.id, [t.external_id for _, t in mapped])
        todo = [(a, t) for a, t in mapped if t.external_id not in done]
        stats["skipped"] = len(mapped) - len(todo)
        if not todo:
            return

        rlog(f"pushing {len(todo)} transactions to Sure")
        async with SureClient(
            self.config.sure.url, user.sure_api_key.get_secret_value(), self.config.sure.source
        ) as sure:
            for account_id, t in todo:
                entry = await sure.create_transaction(account_id, t)
                self.db.mark_synced(conn.id, t.external_id, account_id, str(entry.get("id")) if entry else None)
                stats["created"] += 1

    def _prune_debug(self) -> None:
        root = self.data_dir / "debug"
        if not root.exists():
            return
        dirs = sorted(root.glob("run-*"), key=lambda p: int(p.name.split("-")[1]), reverse=True)
        for d in dirs[DEBUG_DIRS_KEPT:]:
            shutil.rmtree(d, ignore_errors=True)


def _log_task_error(task: asyncio.Task) -> None:
    if not task.cancelled() and (exc := task.exception()) and not isinstance(exc, AlreadyRunning):
        log.error("background run failed", exc_info=exc)
