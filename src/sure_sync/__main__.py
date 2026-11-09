from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn

from .config import ConfigError, load_config
from .db import Database
from .mfa import MfaBroker
from .runner import Runner
from .scheduler import Scheduler
from .web.app import Services, create_app

log = logging.getLogger("sure_sync")


def main() -> None:
    ap = argparse.ArgumentParser(prog="sure-bank-sync")
    ap.add_argument("--config", default=os.environ.get("SURE_SYNC_CONFIG", "config/config.yaml"))
    ap.add_argument("--data-dir", default=os.environ.get("SURE_SYNC_DATA_DIR", "data"))
    ap.add_argument("--check", action="store_true", help="validate config and exit")
    ap.add_argument("--run", metavar="CONNECTION_ID", help="run one connection once and exit")
    args = ap.parse_args()

    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    try:
        config = load_config(args.config)
    except (ConfigError, ValueError) as e:
        sys.exit(f"config error: {e}")

    if args.check:
        n = len(config.connections())
        print(f"config OK: {len(config.users)} users, {n} connections")
        return

    data_dir = Path(args.data_dir)
    db = Database(data_dir / "state.db")
    mfa = MfaBroker()
    runner = Runner(config, db, mfa, data_dir)

    if args.run:
        asyncio.run(_run_once(runner, db, args.run))
        return

    scheduler = Scheduler(config, runner)

    @asynccontextmanager
    async def lifespan(_app):
        await runner.start()
        scheduler.start()
        log.info("started: %d connections", len(config.connections()))
        yield
        scheduler.stop()
        await runner.stop()

    app = create_app(Services(config, db, runner, scheduler, mfa, data_dir), lifespan=lifespan)
    uvicorn.run(app, host=config.web.host, port=config.web.port, log_level="warning")


async def _run_once(runner: Runner, db: Database, conn_id: str) -> None:
    await runner.start()
    try:
        run_id = await runner.run(conn_id, "manual")
    finally:
        await runner.stop()
    run = db.get_run(run_id)
    print(run.log)
    sys.exit(0 if run.status == "success" else 1)


if __name__ == "__main__":
    main()
