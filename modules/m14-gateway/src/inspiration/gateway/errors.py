from __future__ import annotations

from inspiration.contracts.models import GatewayError, GatewayErrorCode

RETRYABLE = {GatewayErrorCode.provider_error, GatewayErrorCode.timeout}


class GatewayException(Exception):
    """Raised by every gateway call that fails. Carries the contract GatewayError."""

    def __init__(self, code: GatewayErrorCode, message: str, *, request_id: str | None = None) -> None:
        super().__init__(f"{code.value}: {message}")
        self.error = GatewayError(code=code, message=message, retryable=code in RETRYABLE, request_id=request_id)

    @property
    def code(self) -> GatewayErrorCode:
        return self.error.code


class ProviderError(Exception):
    """Raised by provider plugins. retryable=True lets the gateway retry or fall back."""

    def __init__(self, message: str, *, retryable: bool, status: int | None = None) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.status = status
