import asyncio
import json
from datetime import date
from decimal import Decimal
from pathlib import Path

import httpx
import pytest
import respx

from sure_sync.config import ConfigError, load_config
from sure_sync.db import Database
from sure_sync.mfa import MfaBroker, MfaTimeout
from sure_sync.models import BankAccount, BankTransaction, assign_external_ids
from sure_sync.runner import Runner

CONFIG = """
sure:
  url: http://sure.test/
timezone: Australia/Melbourne
users:
  - name: alice
    sure_api_key: ${ALICE_KEY}
    connections:
      - id: alice-demo
        provider: demo
        credentials:
          password: ${file:%s}
        accounts:
          - match: "9999"
            sure_account_id: acct-1
"""


def write_config(tmp_path: Path, monkeypatch, body: str = CONFIG) -> Path:
    secret = tmp_path / "secret"
    secret.write_text("hunter2\n")
    monkeypatch.setenv("ALICE_KEY", "key-123")
    p = tmp_path / "config.yaml"
    p.write_text(body % secret if "%s" in body else body)
    return p


def test_config_interpolation(tmp_path, monkeypatch):
    cfg = load_config(write_config(tmp_path, monkeypatch))
    user, conn = cfg.find_connection("alice-demo")
    assert cfg.sure.url == "http://sure.test"
    assert user.sure_api_key.get_secret_value() == "key-123"
    assert conn.credentials["password"].get_secret_value() == "hunter2"


def test_config_missing_env(tmp_path, monkeypatch):
    p = write_config(tmp_path, monkeypatch)
    monkeypatch.delenv("ALICE_KEY")
    with pytest.raises(ConfigError, match="ALICE_KEY"):
        load_config(p)


def test_config_bad_cron(tmp_path, monkeypatch):
    p = write_config(tmp_path, monkeypatch, CONFIG.replace("timezone:", 'schedule: "nope"\ntimezone:'))
    with pytest.raises(ValueError, match="cron"):
        load_config(p)


ACCT = BankAccount(id="012-345 6789999", name="Everyday")


def txn(desc="COFFEE", amount="-4.50", d=date(2026, 11, 1), **kw):
    return BankTransaction(ACCT, d, Decimal(amount), desc, **kw)


def test_external_ids_stable_and_distinct():
    a = [txn(), txn(), txn("OTHER")]
    b = [txn("OTHER"), txn(), txn()]
    assign_external_ids(a)
    assign_external_ids(b)
    assert len({t.external_id for t in a}) == 3
    assert {t.external_id for t in a} == {t.external_id for t in b}


def test_external_id_prefers_bank_id():
    t = txn(bank_id="ABC")
    assign_external_ids([t])
    assert t.external_id == f"{ACCT.id}:ABC"


async def test_mfa_roundtrip():
    broker = MfaBroker()
    task = asyncio.create_task(broker.request("c1", 1, "code?", timeout=5))
    await asyncio.sleep(0)
    assert broker.get("c1").prompt == "code?"
    assert broker.submit("c1", " 123456 ")
    assert await task == "123456"
    assert broker.get("c1") is None


async def test_mfa_timeout():
    with pytest.raises(MfaTimeout):
        await MfaBroker().request("c1", 1, "code?", timeout=0.01)


@respx.mock
async def test_push_maps_dedupes_and_skips(tmp_path, monkeypatch):
    cfg = load_config(write_config(tmp_path, monkeypatch))
    user, conn = cfg.find_connection("alice-demo")
    db = Database(tmp_path / "state.db")
    runner = Runner(cfg, db, MfaBroker(), tmp_path)

    route = respx.post("http://sure.test/api/v1/transactions").mock(
        side_effect=lambda req: httpx.Response(201, json={"id": "e-1"})
    )
    other = BankAccount(id="555", name="Unmapped card")
    txns = [txn(), txn(), txn("SALARY", "2500"), txn("PENDING", pending=True), BankTransaction(other, date(2026, 11, 1), Decimal("-1"), "X")]

    stats = dict(fetched=0, created=0, skipped=0, unmapped=0)
    await runner._push(user, conn, txns, stats, lambda m: None)
    assert stats == dict(fetched=0, created=3, skipped=0, unmapped=1)
    assert route.call_count == 3

    bodies = [json.loads(c.request.content)["transaction"] for c in route.calls]
    assert route.calls[0].request.headers["X-Api-Key"] == "key-123"
    salary = next(b for b in bodies if b["name"] == "SALARY")
    coffee = next(b for b in bodies if b["name"] == "COFFEE")
    assert salary["nature"] == "income" and salary["amount"] == "2500"
    assert coffee["nature"] == "expense" and coffee["amount"] == "4.50"
    assert all(b["account_id"] == "acct-1" and b["source"] == "sure-bank-sync" for b in bodies)

    # Second run: everything already synced locally, no API calls
    stats = dict(fetched=0, created=0, skipped=0, unmapped=0)
    fresh = [txn(), txn(), txn("SALARY", "2500")]
    await runner._push(user, conn, fresh, stats, lambda m: None)
    assert stats["created"] == 0 and stats["skipped"] == 3
    assert route.call_count == 3


def test_web_dashboard(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from sure_sync.scheduler import Scheduler
    from sure_sync.web.app import Services, create_app

    cfg = load_config(write_config(tmp_path, monkeypatch))
    db = Database(tmp_path / "state.db")
    mfa = MfaBroker()
    runner = Runner(cfg, db, mfa, tmp_path)
    run_id = db.start_run("alice-demo", "alice", "manual")
    db.finish_run(run_id, "failed", error="boom")

    app = create_app(Services(cfg, db, runner, Scheduler(cfg, runner), mfa, tmp_path))
    client = TestClient(app)
    r = client.get("/")
    assert r.status_code == 200 and "alice-demo" in r.text and "boom" in r.text
    assert client.get(f"/runs/{run_id}").status_code == 200
    assert client.get("/runs/999").status_code == 404
    assert client.get(f"/runs/{run_id}/debug/..%2F..%2Fstate.db").status_code == 404
    assert client.get("/api/status").json()[0]["last_status"] == "failed"
