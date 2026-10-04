"""
MyWhatsapp Python SDK.

Official client library for the MyWhatsapp WhatsApp API Gateway.

Example usage::

    from mywhatsapp import MyWhatsappClient

    client = MyWhatsappClient(
        base_url="http://localhost:2785",
        api_key="owa_k1_…",
    )

    client.sessions.start("my-session")
    result = client.messages.send_text("my-session", {
        "chatId": "628123456789@c.us",
        "text": "Hello from the MyWhatsapp Python SDK!",
    })
    print(result["messageId"])
"""

from __future__ import annotations

from .client import MyWhatsappClient
from .errors import (
    MyWhatsappApiError,
    MyWhatsappAuthError,
    MyWhatsappConflictError,
    MyWhatsappError,
    MyWhatsappForbiddenError,
    MyWhatsappNotFoundError,
    MyWhatsappNotImplementedError,
    MyWhatsappServiceUnavailableError,
    MyWhatsappRateLimitError,
    MyWhatsappTimeoutError,
)

__all__ = [
    "MyWhatsappClient",
    "MyWhatsappError",
    "MyWhatsappApiError",
    "MyWhatsappAuthError",
    "MyWhatsappForbiddenError",
    "MyWhatsappNotFoundError",
    "MyWhatsappConflictError",
    "MyWhatsappRateLimitError",
    "MyWhatsappNotImplementedError",
    "MyWhatsappServiceUnavailableError",
    "MyWhatsappTimeoutError",
]
