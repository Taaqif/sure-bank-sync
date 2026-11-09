"""Interface every bank provider implements."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, ClassVar

from playwright.async_api import BrowserContext

from ..models import BankTransaction


class ProviderError(Exception):
    """Expected failure (bad password, site changed, locked out...)."""


class AuthError(ProviderError):
    pass


@dataclass
class ProviderContext:
    connection_id: str
    credentials: dict[str, str]
    options: dict[str, Any]
    browser: BrowserContext  # persistent per-connection context (cookies kept between runs)
    debug_dir: Path  # screenshots/HTML dumps for this run
    log: Callable[[str], None]
    request_mfa: Callable[[str], Awaitable[str]]  # prompt -> code typed in the web UI

    async def snapshot(self, name: str) -> None:
        """Save screenshot + HTML of every open page. Call liberally when debugging selectors."""
        self.debug_dir.mkdir(parents=True, exist_ok=True)
        for i, page in enumerate(self.browser.pages):
            try:
                await page.screenshot(path=self.debug_dir / f"{name}-{i}.png", full_page=True)
                (self.debug_dir / f"{name}-{i}.html").write_text(await page.content())
            except Exception as e:  # never let debugging break a run
                self.log(f"snapshot {name} failed: {e}")


class BankProvider(ABC):
    #: config value for `provider:`
    name: ClassVar[str]
    #: credential keys that must be present in config
    required_credentials: ClassVar[tuple[str, ...]] = ()

    def __init__(self, ctx: ProviderContext):
        self.ctx = ctx

    @abstractmethod
    async def login(self) -> None:
        """Get to an authenticated state. Use ctx.request_mfa() for OTPs."""

    @abstractmethod
    async def fetch_transactions(self, since: date, until: date) -> list[BankTransaction]:
        """Return all transactions across all accounts in [since, until]."""

    async def logout(self) -> None:  # noqa: B027 - optional hook
        pass
