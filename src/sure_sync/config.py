"""Config file loading and validation.

Values may reference environment variables as ${VAR} (or ${VAR:-default})
and files as ${file:/path}, so secrets can stay out of the YAML.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

import yaml
from apscheduler.triggers.cron import CronTrigger
from pydantic import BaseModel, Field, SecretStr, field_validator, model_validator

_REF = re.compile(r"\$\{([^}]+)\}")


class ConfigError(Exception):
    pass


def _resolve_ref(ref: str) -> str:
    if ref.startswith("file:"):
        path = Path(ref[5:])
        try:
            return path.read_text().strip()
        except OSError as e:
            raise ConfigError(f"cannot read secret file {path}: {e}") from e
    name, _, default = ref.partition(":-")
    value = os.environ.get(name)
    if value is None or value == "":
        if ":-" in ref:
            return default
        raise ConfigError(f"environment variable {name} is not set")
    return value


def _interpolate(node: Any) -> Any:
    if isinstance(node, str):
        return _REF.sub(lambda m: _resolve_ref(m.group(1)), node)
    if isinstance(node, list):
        return [_interpolate(v) for v in node]
    if isinstance(node, dict):
        return {k: _interpolate(v) for k, v in node.items()}
    return node


def _check_cron(expr: str | None) -> str | None:
    if expr is not None:
        try:
            CronTrigger.from_crontab(expr)
        except ValueError as e:
            raise ValueError(f"invalid cron expression {expr!r}: {e}") from e
    return expr


class SureConfig(BaseModel):
    url: str
    source: str = "sure-bank-sync"

    @field_validator("url")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.rstrip("/")


class WebConfig(BaseModel):
    host: str = "0.0.0.0"
    port: int = 8686
    username: str | None = None
    password: SecretStr | None = None

    @model_validator(mode="after")
    def _both_or_neither(self) -> WebConfig:
        if bool(self.username) != bool(self.password and self.password.get_secret_value()):
            raise ValueError("web.username and web.password must be set together")
        return self


class AccountMapping(BaseModel):
    match: str
    sure_account_id: str


class ConnectionConfig(BaseModel):
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]+$")
    provider: str
    enabled: bool = True
    schedule: str | None = None
    lookback_days: int | None = None
    credentials: dict[str, SecretStr] = Field(default_factory=dict)
    accounts: list[AccountMapping] = Field(default_factory=list)
    options: dict[str, Any] = Field(default_factory=dict)

    @field_validator("schedule")
    @classmethod
    def _check_schedule(cls, v: str | None) -> str | None:
        return _check_cron(v)


class UserConfig(BaseModel):
    name: str
    sure_api_key: SecretStr
    connections: list[ConnectionConfig] = Field(default_factory=list)


class AppConfig(BaseModel):
    sure: SureConfig
    timezone: str = "UTC"
    schedule: str = "0 6 * * *"
    lookback_days: int = 30
    skip_pending: bool = True
    mfa_timeout_seconds: int = 300
    web: WebConfig = Field(default_factory=WebConfig)
    users: list[UserConfig]

    @field_validator("schedule")
    @classmethod
    def _check_schedule(cls, v: str | None) -> str | None:
        return _check_cron(v)

    @model_validator(mode="after")
    def _unique_ids(self) -> AppConfig:
        seen: set[str] = set()
        for user in self.users:
            for conn in user.connections:
                if conn.id in seen:
                    raise ValueError(f"duplicate connection id {conn.id!r}")
                seen.add(conn.id)
        return self

    def connections(self) -> list[tuple[UserConfig, ConnectionConfig]]:
        return [(u, c) for u in self.users for c in u.connections]

    def find_connection(self, conn_id: str) -> tuple[UserConfig, ConnectionConfig] | None:
        for user, conn in self.connections():
            if conn.id == conn_id:
                return user, conn
        return None


def load_config(path: str | os.PathLike[str]) -> AppConfig:
    p = Path(path)
    if not p.exists():
        raise ConfigError(f"config file not found: {p}")
    raw = yaml.safe_load(p.read_text()) or {}
    return AppConfig.model_validate(_interpolate(raw))
