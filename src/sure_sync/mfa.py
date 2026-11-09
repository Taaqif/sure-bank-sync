"""Hand-off for one-time codes: a scraper waits, a human types it into the web UI."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime


class MfaTimeout(Exception):
    pass


@dataclass
class MfaRequest:
    connection_id: str
    run_id: int
    prompt: str
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    future: asyncio.Future[str] = field(default_factory=lambda: asyncio.get_running_loop().create_future())


class MfaBroker:
    def __init__(self) -> None:
        self._pending: dict[str, MfaRequest] = {}

    def pending(self) -> list[MfaRequest]:
        return list(self._pending.values())

    def get(self, connection_id: str) -> MfaRequest | None:
        return self._pending.get(connection_id)

    async def request(self, connection_id: str, run_id: int, prompt: str, timeout: float) -> str:
        req = MfaRequest(connection_id, run_id, prompt)
        self._pending[connection_id] = req
        try:
            return await asyncio.wait_for(req.future, timeout)
        except TimeoutError as e:
            raise MfaTimeout(f"no MFA code entered within {int(timeout)}s") from e
        finally:
            self._pending.pop(connection_id, None)

    def submit(self, connection_id: str, code: str) -> bool:
        req = self._pending.get(connection_id)
        if not req or req.future.done():
            return False
        req.future.set_result(code.strip())
        return True
