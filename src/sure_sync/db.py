"""SQLite store for run history and per-transaction sync state."""

from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id TEXT NOT NULL,
    user_name     TEXT NOT NULL,
    trigger       TEXT NOT NULL,           -- schedule | manual
    status        TEXT NOT NULL,           -- running | awaiting_mfa | success | failed
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    fetched       INTEGER NOT NULL DEFAULT 0,
    created       INTEGER NOT NULL DEFAULT 0,
    skipped       INTEGER NOT NULL DEFAULT 0,
    unmapped      INTEGER NOT NULL DEFAULT 0,
    error         TEXT,
    log           TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS runs_conn ON runs(connection_id, started_at DESC);

CREATE TABLE IF NOT EXISTS synced (
    connection_id   TEXT NOT NULL,
    external_id     TEXT NOT NULL,
    sure_account_id TEXT NOT NULL,
    sure_entry_id   TEXT,
    synced_at       TEXT NOT NULL,
    PRIMARY KEY (connection_id, external_id)
);
"""


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


@dataclass
class Run:
    id: int
    connection_id: str
    user_name: str
    trigger: str
    status: str
    started_at: str
    finished_at: str | None
    fetched: int
    created: int
    skipped: int
    unmapped: int
    error: str | None
    log: str


class Database:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._lock = threading.Lock()
        with self._tx() as c:
            c.executescript(SCHEMA)
            # Runs left 'running' by a crash/restart can never finish.
            c.execute(
                "UPDATE runs SET status='failed', error='interrupted (process restarted)', finished_at=? "
                "WHERE status IN ('running','awaiting_mfa')",
                (now(),),
            )

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            yield self._conn

    # --- runs -----------------------------------------------------------
    def start_run(self, connection_id: str, user_name: str, trigger: str) -> int:
        with self._tx() as c:
            cur = c.execute(
                "INSERT INTO runs (connection_id, user_name, trigger, status, started_at) VALUES (?,?,?,?,?)",
                (connection_id, user_name, trigger, "running", now()),
            )
            return int(cur.lastrowid)

    def set_status(self, run_id: int, status: str) -> None:
        with self._tx() as c:
            c.execute("UPDATE runs SET status=? WHERE id=?", (status, run_id))

    def append_log(self, run_id: int, line: str) -> None:
        with self._tx() as c:
            c.execute("UPDATE runs SET log = log || ? WHERE id=?", (line + "\n", run_id))

    def finish_run(
        self,
        run_id: int,
        status: str,
        *,
        fetched: int = 0,
        created: int = 0,
        skipped: int = 0,
        unmapped: int = 0,
        error: str | None = None,
    ) -> None:
        with self._tx() as c:
            c.execute(
                "UPDATE runs SET status=?, finished_at=?, fetched=?, created=?, skipped=?, unmapped=?, error=? "
                "WHERE id=?",
                (status, now(), fetched, created, skipped, unmapped, error, run_id),
            )

    def get_run(self, run_id: int) -> Run | None:
        with self._tx() as c:
            row = c.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        return Run(**dict(row)) if row else None

    def recent_runs(self, connection_id: str | None = None, limit: int = 50) -> list[Run]:
        q, args = "SELECT * FROM runs", []
        if connection_id:
            q += " WHERE connection_id=?"
            args.append(connection_id)
        q += " ORDER BY id DESC LIMIT ?"
        args.append(limit)
        with self._tx() as c:
            return [Run(**dict(r)) for r in c.execute(q, args).fetchall()]

    def last_run(self, connection_id: str) -> Run | None:
        runs = self.recent_runs(connection_id, limit=1)
        return runs[0] if runs else None

    def last_success(self, connection_id: str) -> Run | None:
        with self._tx() as c:
            row = c.execute(
                "SELECT * FROM runs WHERE connection_id=? AND status='success' ORDER BY id DESC LIMIT 1",
                (connection_id,),
            ).fetchone()
        return Run(**dict(row)) if row else None

    # --- synced transactions -------------------------------------------
    def already_synced(self, connection_id: str, external_ids: list[str]) -> set[str]:
        if not external_ids:
            return set()
        out: set[str] = set()
        with self._tx() as c:
            for i in range(0, len(external_ids), 500):
                chunk = external_ids[i : i + 500]
                q = f"SELECT external_id FROM synced WHERE connection_id=? AND external_id IN ({','.join('?' * len(chunk))})"
                out.update(r[0] for r in c.execute(q, [connection_id, *chunk]))
        return out

    def mark_synced(self, connection_id: str, external_id: str, sure_account_id: str, sure_entry_id: str | None) -> None:
        with self._tx() as c:
            c.execute(
                "INSERT OR REPLACE INTO synced VALUES (?,?,?,?,?)",
                (connection_id, external_id, sure_account_id, sure_entry_id, now()),
            )
