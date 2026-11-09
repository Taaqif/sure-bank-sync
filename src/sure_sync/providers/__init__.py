from .amex import AmexProvider
from .anz import AnzProvider
from .base import AuthError, BankProvider, ProviderContext, ProviderError
from .demo import DemoProvider

PROVIDERS: dict[str, type[BankProvider]] = {
    p.name: p for p in (AnzProvider, AmexProvider, DemoProvider)
}

__all__ = ["PROVIDERS", "AuthError", "BankProvider", "ProviderContext", "ProviderError"]
