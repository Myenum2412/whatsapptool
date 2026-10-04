# Webhook Signature Verification

MyWhatsapp signs webhook deliveries when a webhook is configured with a secret. Receivers should verify the signature before processing the event.

## Headers

MyWhatsapp sends these system headers with webhook deliveries:

| Header                         | Description                                                        |
| ------------------------------ | ------------------------------------------------------------------ |
| `X-MyWhatsapp-Signature`       | HMAC-SHA256 signature, present only when the webhook has a secret  |
| `X-MyWhatsapp-Event`           | Event name, for example `message.received`                         |
| `X-MyWhatsapp-Idempotency-Key` | Stable key for duplicate detection                                 |
| `X-MyWhatsapp-Delivery-Id`     | Unique identifier for this delivery (stable across retry attempts) |
| `X-MyWhatsapp-Retry-Count`     | Retry count for the current delivery                               |

The signature format is:

```text
sha256=<hex digest>
```

The digest is computed over the exact raw request body bytes using the webhook secret.

## Node.js / Express

Use `express.raw()` for the webhook route so the signature is checked against the raw body. Parse JSON only after verification succeeds.

```javascript
const crypto = require('crypto');
const express = require('express');

const app = express();
const WEBHOOK_SECRET = process.env.MYWHATSAPP_WEBHOOK_SECRET;

function verifyMyWhatsappSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;

  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (signatureBuffer.length !== expectedBuffer.length) return false;

  return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
}

app.post('/mywhatsapp/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.header('X-MyWhatsapp-Signature');

  if (!verifyMyWhatsappSignature(req.body, signature, WEBHOOK_SECRET)) {
    return res.status(401).send('Invalid signature');
  }

  const event = JSON.parse(req.body.toString('utf8'));

  // Process event here.
  // Return a 2xx response only after the event is safely accepted.
  return res.status(200).send('OK');
});
```

## Python / FastAPI

Read the raw request body before parsing JSON.

```python
import hmac
import hashlib
import os
from fastapi import FastAPI, Request, HTTPException

app = FastAPI()
WEBHOOK_SECRET = os.environ["MYWHATSAPP_WEBHOOK_SECRET"]


def verify_mywhatsapp_signature(raw_body: bytes, signature: str | None, secret: str) -> bool:
    if not signature:
        return False

    expected = "sha256=" + hmac.new(
        secret.encode("utf-8"), raw_body, hashlib.sha256
    ).hexdigest()

    return hmac.compare_digest(signature, expected)


@app.post("/mywhatsapp/webhook")
async def mywhatsapp_webhook(request: Request):
    raw_body = await request.body()
    signature = request.headers.get("x-mywhatsapp-signature")

    if not verify_mywhatsapp_signature(raw_body, signature, WEBHOOK_SECRET):
        raise HTTPException(status_code=401, detail="Invalid signature")

    event = await request.json()

    # Process event here.
    return {"status": "ok"}
```

## Processing Checklist

- Verify `X-MyWhatsapp-Signature` before trusting or parsing the event.
- Use the exact raw request body received by your HTTP server.
- Use a constant-time comparison function.
- Return `401` for invalid signatures.
- Use `X-MyWhatsapp-Idempotency-Key` to avoid duplicate processing on retries.
- Return a `2xx` response only after the event is accepted for processing.
