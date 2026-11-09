from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal


@dataclass(frozen=True)
class BankAccount:
    """An account as the bank presents it."""

    id: str  # bank's own identifier (account number, card suffix, ...)
    name: str
    currency: str = "AUD"

    def matches(self, needle: str) -> bool:
        n = needle.lower().replace(" ", "")
        return n in self.id.lower().replace(" ", "") or n in self.name.lower().replace(" ", "")


@dataclass
class BankTransaction:
    """A transaction scraped from a bank.

    `amount` uses the bank convention: negative = money out, positive = money in.
    """

    account: BankAccount
    date: date
    amount: Decimal
    description: str
    bank_id: str | None = None  # stable id from the bank, if it provides one
    pending: bool = False
    raw: dict[str, str] = field(default_factory=dict)
    external_id: str = ""  # filled by assign_external_ids()


def assign_external_ids(txns: list[BankTransaction]) -> None:
    """Give every transaction a stable id for idempotent upload.

    Uses the bank's id when present. Otherwise hashes the content, plus an
    occurrence counter so two identical same-day purchases stay distinct.
    Identical transactions are interchangeable, so input order doesn't matter.
    """
    seen: dict[str, int] = {}
    for t in txns:
        if t.bank_id:
            t.external_id = f"{t.account.id}:{t.bank_id}"
            continue
        base = "|".join(
            [t.account.id, t.date.isoformat(), f"{t.amount:.2f}", " ".join(t.description.split()).lower()]
        )
        n = seen.get(base, 0)
        seen[base] = n + 1
        digest = hashlib.sha256(f"{base}|{n}".encode()).hexdigest()[:24]
        t.external_id = f"{t.account.id}:h{digest}"
