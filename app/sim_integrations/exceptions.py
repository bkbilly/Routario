"""Exceptions for SIM provider integrations."""


class SimProviderError(Exception):
    """Base exception for SIM provider errors."""


class AuthenticationError(SimProviderError):
    """Raised when authentication fails against the SIM provider portal/API."""


SimAuthenticationError = AuthenticationError
