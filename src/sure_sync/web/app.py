from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Form, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.templating import Jinja2Templates

from ..config import AppConfig
from ..db import Database
from ..mfa import MfaBroker
from ..runner import AlreadyRunning, Runner
from ..scheduler import Scheduler

TEMPLATES = Jinja2Templates(directory=Path(__file__).parent / "templates")


def _ago(iso: str | None) -> str:
    if not iso:
        return "never"
    dt = datetime.fromisoformat(iso)
    secs = int((datetime.now(dt.tzinfo) - dt).total_seconds())
    for unit, n in (("d", 86400), ("h", 3600), ("m", 60)):
        if secs >= n:
            return f"{secs // n}{unit} ago"
    return f"{secs}s ago"


TEMPLATES.env.filters["ago"] = _ago


@dataclass
class Services:
    config: AppConfig
    db: Database
    runner: Runner
    scheduler: Scheduler
    mfa: MfaBroker
    data_dir: Path


def create_app(svc: Services, lifespan=None) -> FastAPI:
    app = FastAPI(title="sure-bank-sync", lifespan=lifespan, docs_url=None, redoc_url=None)
    basic = HTTPBasic(auto_error=False)
    web = svc.config.web

    def auth(creds: HTTPBasicCredentials | None = Depends(basic)) -> None:
        if not web.username:
            return
        ok = (
            creds is not None
            and secrets.compare_digest(creds.username, web.username)
            and secrets.compare_digest(creds.password, web.password.get_secret_value())
        )
        if not ok:
            raise HTTPException(401, headers={"WWW-Authenticate": "Basic"})

    def connection_rows() -> list[dict[str, Any]]:
        rows = []
        for user, conn in svc.config.connections():
            rows.append(
                dict(
                    id=conn.id,
                    user=user.name,
                    provider=conn.provider,
                    enabled=conn.enabled,
                    schedule=conn.schedule or svc.config.schedule,
                    running=svc.runner.is_running(conn.id),
                    last=svc.db.last_run(conn.id),
                    last_ok=svc.db.last_success(conn.id),
                    next_run=svc.scheduler.next_run(conn.id),
                    mfa=svc.mfa.get(conn.id),
                )
            )
        return rows

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/", response_class=HTMLResponse, dependencies=[Depends(auth)])
    def index(request: Request):
        return TEMPLATES.TemplateResponse(
            request, "index.html", {"rows": connection_rows(), "runs": svc.db.recent_runs(limit=15)}
        )

    @app.get("/partials/status", response_class=HTMLResponse, dependencies=[Depends(auth)])
    def status_partial(request: Request):
        return TEMPLATES.TemplateResponse(
            request, "_status.html", {"rows": connection_rows(), "runs": svc.db.recent_runs(limit=15)}
        )

    @app.get("/api/status", dependencies=[Depends(auth)])
    def api_status() -> list[dict[str, Any]]:
        out = []
        for r in connection_rows():
            last = r["last"]
            out.append(
                {
                    "id": r["id"],
                    "user": r["user"],
                    "provider": r["provider"],
                    "enabled": r["enabled"],
                    "running": r["running"],
                    "awaiting_mfa": r["mfa"] is not None,
                    "last_status": last.status if last else None,
                    "last_run_at": last.started_at if last else None,
                    "last_success_at": r["last_ok"].finished_at if r["last_ok"] else None,
                    "next_run_at": r["next_run"].isoformat() if r["next_run"] else None,
                }
            )
        return out

    @app.post("/connections/{conn_id}/run", dependencies=[Depends(auth)])
    async def run_now(conn_id: str):
        if not svc.config.find_connection(conn_id):
            raise HTTPException(404)
        try:
            svc.runner.start_background(conn_id, "manual")
        except AlreadyRunning:
            pass
        return RedirectResponse("/", status_code=303)

    @app.post("/connections/{conn_id}/mfa", dependencies=[Depends(auth)])
    async def submit_mfa(conn_id: str, code: str = Form(...)):
        svc.mfa.submit(conn_id, code)
        return RedirectResponse("/", status_code=303)

    @app.get("/connections/{conn_id}", response_class=HTMLResponse, dependencies=[Depends(auth)])
    def connection_detail(request: Request, conn_id: str):
        found = svc.config.find_connection(conn_id)
        if not found:
            raise HTTPException(404)
        user, conn = found
        return TEMPLATES.TemplateResponse(
            request,
            "connection.html",
            {"user": user, "conn": conn, "runs": svc.db.recent_runs(conn_id, limit=100)},
        )

    @app.get("/runs/{run_id}", response_class=HTMLResponse, dependencies=[Depends(auth)])
    def run_detail(request: Request, run_id: int):
        run = svc.db.get_run(run_id)
        if not run:
            raise HTTPException(404)
        ddir = svc.data_dir / "debug" / f"run-{run_id}"
        shots = sorted(p.name for p in ddir.glob("*.png")) if ddir.exists() else []
        return TEMPLATES.TemplateResponse(request, "run.html", {"run": run, "shots": shots})

    @app.get("/runs/{run_id}/debug/{name}", dependencies=[Depends(auth)])
    def run_debug_file(run_id: int, name: str):
        ddir = (svc.data_dir / "debug" / f"run-{run_id}").resolve()
        path = (ddir / name).resolve()
        if path.parent != ddir or not path.is_file():
            raise HTTPException(404)
        return FileResponse(path)

    return app
