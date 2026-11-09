"""ANZ Internet Banking (Australia). Scraper implemented in the next phase."""

from __future__ import annotations

from datetime import date

from ..models import BankTransaction
from .base import BankProvider, ProviderError


class AnzProvider(BankProvider):
    name = "anz"
    required_credentials = ("customer_id", "password")

    async def login(self) -> None:
        raise ProviderError("ANZ provider not implemented yet")

    async def fetch_transactions(self, since: date, until: date) -> list[BankTransaction]:
        raise ProviderError("ANZ provider not implemented yet")
