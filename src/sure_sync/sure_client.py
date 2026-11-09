"""Minimal client for the Sure REST API (/api/v1)."""

from __future__ import annotations

from typing import Any

import httpx

from .models import BankTransaction


class SureError(Exception):
    pass


class SureClient:
    def __init__(self, base_url: str, api_key: str, source: str, timeout: float = 30.0):
        self.source = source
        self._http = httpx.AsyncClient(
            base_url=f"{base_url}/api/v1",
            headers={"X-Api-Key": api_key, "Accept": "application/json"},
            timeout=timeout,
        )

    async def __aenter__(self) -> SureClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self._http.aclose()

    async def _request(self, method: str, path: str, **kw: Any) -> Any:
        try:
            r = await self._http.request(method, path, **kw)
        except httpx.HTTPError as e:
            raise SureError(f"{method} {path}: {e}") from e
        if r.status_code >= 400:
            raise SureError(f"{method} {path}: HTTP {r.status_code} {r.text[:300]}")
        return r.json() if r.content else None

    async def list_accounts(self) -> list[dict[str, Any]]:
        data = await self._request("GET", "/accounts", params={"per_page": 100})
        return data.get("accounts", data) if isinstance(data, dict) else data

    async def create_transaction(self, sure_account_id: str, txn: BankTransaction) -> dict[str, Any]:
        """Create a transaction. Idempotent: Sure returns the existing entry
        (HTTP 200) when external_id + source already exist on the account."""
        payload = {
            "transaction": {
                "account_id": sure_account_id,
                "date": txn.date.isoformat(),
                "amount": str(abs(txn.amount)),
                "name": txn.description[:255],
                "currency": txn.account.currency,
                "nature": "income" if txn.amount > 0 else "expense",
                "external_id": txn.external_id,
                "source": self.source,
            }
        }
        return await self._request("POST", "/transactions", json=payload)
