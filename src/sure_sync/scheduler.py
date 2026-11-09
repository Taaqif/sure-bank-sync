from __future__ import annotations

import logging
from datetime import datetime

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from .config import AppConfig
from .runner import AlreadyRunning, Runner

log = logging.getLogger(__name__)


class Scheduler:
    def __init__(self, config: AppConfig, runner: Runner):
        self.config = config
        self.runner = runner
        self._sched = AsyncIOScheduler(timezone=config.timezone)

    def start(self) -> None:
        for _user, conn in self.config.connections():
            if not conn.enabled:
                continue
            expr = conn.schedule or self.config.schedule
            self._sched.add_job(
                self._fire,
                CronTrigger.from_crontab(expr, timezone=self.config.timezone),
                args=[conn.id],
                id=conn.id,
                coalesce=True,
                max_instances=1,
                misfire_grace_time=3600,
                # spread logins so the same bank isn't hit by several users at once
                jitter=120,
            )
            log.info("scheduled %s: %s", conn.id, expr)
        self._sched.start()

    def stop(self) -> None:
        self._sched.shutdown(wait=False)

    def next_run(self, conn_id: str) -> datetime | None:
        job = self._sched.get_job(conn_id)
        return job.next_run_time if job else None

    async def _fire(self, conn_id: str) -> None:
        try:
            await self.runner.run(conn_id, "schedule")
        except AlreadyRunning:
            log.info("%s still running, skipping scheduled run", conn_id)
