"""American Express (Australia). Scraper implemented in the next phase."""

from __future__ import annotations

from datetime import date

from ..models import BankTransaction
from .base import BankProvider, ProviderError


class AmexProvider(BankProvider):
    name = "amex"
    required_credentials = ("username", "password")

    async def login(self) -> None:
        raise ProviderError("Amex provider not implemented yet")

    async def fetch_transactions(self, since: date, until: date) -> list[BankTransaction]:
        raise ProviderError("Amex provider not implemented yet")
