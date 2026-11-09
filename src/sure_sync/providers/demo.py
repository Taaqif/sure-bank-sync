"""Fake bank for testing the pipeline end-to-end without a real login.

Set `options.mfa: true` to exercise the web UI OTP prompt.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from ..models import BankAccount, BankTransaction
from .base import AuthError, BankProvider


class DemoProvider(BankProvider):
    name = "demo"

    async def login(self) -> None:
        self.ctx.log("demo: logging in")
        if self.ctx.options.get("mfa"):
            code = await self.ctx.request_mfa("Demo bank: enter any 6 digit code")
            if not (code.isdigit() and len(code) == 6):
                raise AuthError("demo: code must be 6 digits")

    async def fetch_transactions(self, since: date, until: date) -> list[BankTransaction]:
        acct = BankAccount(id="000-111 9999", name="Demo Everyday")
        out = []
        d = since
        while d <= until:
            out.append(BankTransaction(acct, d, Decimal("-4.50"), "DEMO COFFEE CO"))
            if d.day == 1:
                out.append(BankTransaction(acct, d, Decimal("2500.00"), "DEMO SALARY"))
            d += timedelta(days=1)
        return out
