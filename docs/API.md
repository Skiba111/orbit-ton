# ORBIT REST API Reference

Base URL: `https://your-backend.com/api/v1`  
Interactive docs (dev mode): `http://localhost:4000/docs`

---

## Authentication

Two methods are supported. Use one per request.

### JWT Bearer (dashboard / operator sessions)

```
Authorization: Bearer <access_token>
```

Tokens are obtained via `POST /auth/ton-proof` (TON Connect wallet signature).

### API Key (server-to-server integrations)

```
X-API-Key: orbit_sk_<32 hex chars>
```

Keys are created in the dashboard under API Keys. The raw key is shown **once** at creation — store it in your `.env` immediately.

---

## Rate Limits

| Endpoint | Limit |
|---|---|
| `POST /auth/ton-proof` | 10 req / min / IP |
| `POST /auth/refresh` | 20 req / min / IP |
| All other endpoints | 100 req / min / IP |

Exceeded limit → `429 Too Many Requests`

---

## Auth Endpoints

### `POST /auth/ton-proof`

Login with a TON Connect wallet proof. Returns JWT access + refresh tokens.

**Request:**
```json
{
  "timestamp": 1716000000,
  "domain":    { "value": "yourapp.com" },
  "signature": "base64_signature...",
  "payload":   "random_payload",
  "walletAddress": "UQD...",
  "publicKey":     "hex_pubkey"
}
```

**Response:**
```json
{
  "accessToken":  "eyJ...",
  "refreshToken": "eyJ...",
  "operator": {
    "id":            "clx123...",
    "walletAddress": "UQD...",
    "createdAt":     "2026-01-01T00:00:00Z"
  }
}
```

> The `accessToken` expires in 7 days (configurable via `JWT_EXPIRES_IN`).  
> The `refreshToken` expires in 30 days (configurable via `JWT_REFRESH_EXPIRES_IN`).

---

### `POST /auth/refresh`

Rotate refresh token. Old token is invalidated.

**Request:**
```json
{ "refreshToken": "eyJ..." }
```

**Response:**
```json
{
  "accessToken":  "eyJ...",
  "refreshToken": "eyJ..."
}
```

---

### `POST /auth/logout`

Revoke refresh token.

**Request:**
```json
{ "refreshToken": "eyJ..." }
```

---

### `GET /auth/me` 🔐

Returns current operator profile.

---

## Services

### `GET /services` 🔐

List all services registered by the current operator.

**Response:**
```json
[
  {
    "id":             "clx123...",
    "name":           "My SaaS Premium",
    "description":    "Monthly subscription",
    "factoryAddress": "EQAbc123...",
    "isActive":       true,
    "claimedAt":      "2026-01-01T00:00:00Z"
  }
]
```

---

### `POST /services/claim` 🔐

Register a Factory contract as your service.  
The backend calls `get_owner()` on-chain to verify you own this contract.

**⚠️ The wallet you authenticated with MUST match `get_owner()` on the Factory.**

**Request:**
```json
{
  "factoryAddress": "EQAbc123xyz789",
  "name":           "My SaaS Premium",
  "description":    "Monthly access to premium features"
}
```

**Errors:**
- `403` — your wallet is not the owner of this Factory
- `409` — this Factory is already claimed by another operator

---

### `GET /services/discovered` 🔐

List Factory contracts found by the Registry indexer for your wallet address. Use this to quickly claim services without manually entering addresses.

---

### `GET /services/:serviceId` 🔐

Get service details.

---

### `DELETE /services/:serviceId` 🔐

Deactivate a service (soft delete — data preserved).

---

### `GET /services/:id/public`

Public service info — no auth required. Used by subscriber-facing apps.

```json
{
  "id":   "clx123...",
  "name": "My SaaS Premium",
  "plans": [
    { "planId": 0, "price": "1000000000", "period": 2592000, "trialPeriod": 604800, "isActive": true }
  ]
}
```

---

## Plans

### `GET /services/:serviceId/plans` 🔐

List all plans for a service.

---

### `POST /services/:serviceId/plans` 🔐

Sync a plan from the on-chain Factory into the database.

**Request:**
```json
{
  "planId":      0,
  "name":        "Basic Monthly",
  "price":       "1000000000",
  "period":      2592000,
  "trialPeriod": 604800
}
```

> `planId` must match the index in the deployed Factory contract.  
> `price` is in nanoton (1 TON = 1,000,000,000 nanoton).  
> `period` is in seconds (30 days = 2,592,000).

---

### `DELETE /services/:serviceId/plans/:planId` 🔐

Deactivate a plan.

---

## Subscriptions

### `GET /services/:serviceId/subscriptions` 🔐

List subscriptions. Supports filtering:

```
GET /services/:serviceId/subscriptions?status=ACTIVE&limit=50&offset=0
```

**Status values:** `TRIAL` `ACTIVE` `PAUSED` `GRACE` `CANCELLED`

---

### `GET /services/:serviceId/subscriptions/:id` 🔐

Get a single subscription record.

```json
{
  "id":                   "clx456...",
  "subscriberAddress":    "UQDsub...",
  "subscriptionAddress":  "EQAsubcontract...",
  "status":               "ACTIVE",
  "planId":               0,
  "deposit":              "3000000000",
  "nextBillingTime":      "2026-06-01T00:00:00Z",
  "periodsCharged":       1,
  "createdAt":            "2026-01-01T00:00:00Z"
}
```

---

## Charges

### `GET /services/:serviceId/charges` 🔐

List charge history.

```json
[
  {
    "id":        "clx789...",
    "txHash":    "abc123...",
    "amount":    "1000000000",
    "success":   true,
    "chargedAt": "2026-02-01T00:00:00Z"
  }
]
```

---

### `GET /services/:serviceId/charges/export` 🔐

Download charges as CSV.

---

## Analytics

### `GET /services/:serviceId/analytics/overview` 🔐

```
GET /services/:serviceId/analytics/overview?period=30
```

`period`: `7` | `30` | `90` (days, default 30)

**Response:**
```json
{
  "activeSubscriptions": 142,
  "totalRevenue":        "142000000000",
  "mrr":                 "47300000000",
  "churnRate":           2.8,
  "chargesToday":        12,
  "successRate":         97.5
}
```

---

### `GET /services/:serviceId/analytics/charges` 🔐

Daily chart data.

```json
[
  { "date": "2026-05-01", "revenue": "5000000000", "charges": 5 },
  { "date": "2026-05-02", "revenue": "3000000000", "charges": 3 }
]
```

---

## Webhooks

### `GET /services/:serviceId/webhooks` 🔐

List registered endpoints (secrets are never returned after creation).

---

### `POST /services/:serviceId/webhooks` 🔐

Register a webhook endpoint.

**Request:**
```json
{
  "url":    "https://yourapp.com/webhooks/orbit",
  "events": ["charge.success", "subscription.activated"]
}
```

**⚠️ The `secret` field is returned ONCE. Store it immediately.**

**Response:**
```json
{
  "id":         "clx999...",
  "url":        "https://yourapp.com/webhooks/orbit",
  "events":     ["charge.success", "subscription.activated"],
  "secretHint": "a1b2c3d4...",
  "secret":     "a1b2c3d4e5f6...(full 64 char hex)",
  "createdAt":  "2026-05-22T..."
}
```

**Supported events:**

| Event | When |
|---|---|
| `charge.success` | Charge collected successfully |
| `charge.failed` | Charge attempt failed |
| `subscription.activated` | New subscriber |
| `subscription.cancelled` | Subscriber cancelled |
| `subscription.grace` | Grace period started (deposit too low) |
| `subscription.expired` | Grace period ended, subscription cancelled |

**Webhook payload verification:**

Every delivery includes `X-Orbit-Signature: sha256=<hex>`. Verify it:

```typescript
import { verifyWebhookSignature } from "@orbit-ton/react";

const isValid = await verifyWebhookSignature(
  rawBody,                              // string — body before JSON.parse
  req.headers["x-orbit-signature"],     // string
  process.env.ORBIT_WEBHOOK_SECRET,     // your endpoint secret
);
if (!isValid) return res.status(401).end();
```

**Retry policy:** failed deliveries are retried up to 5 times with exponential backoff (30s → 2m → 8m → 32m → 2h).

---

### `DELETE /services/:serviceId/webhooks/:endpointId` 🔐

Deactivate a webhook endpoint.

---

## API Keys

### `GET /api-keys` 🔐 JWT only

List your API keys (no secrets returned).

---

### `POST /api-keys` 🔐 JWT only

Create a new API key.

**Request:**
```json
{
  "name":      "Production Server",
  "serviceId": "clx123...",
  "scopes":    ["read", "write"]
}
```

`serviceId` is optional — if set, the key only works for that specific service.  
**The `key` field is returned ONCE.**

**Response:**
```json
{
  "id":        "clx111...",
  "key":       "orbit_sk_a1b2c3d4e5f6...",
  "prefix":    "orbit_sk_a1b2c3d4",
  "scopes":    ["read", "write"],
  "createdAt": "2026-05-22T..."
}
```

---

### `DELETE /api-keys/:id` 🔐

Revoke an API key (sets `isActive = false`).

---

## Error Responses

All errors follow this format:

```json
{
  "statusCode": 403,
  "message":    "You do not own this service",
  "error":      "Forbidden"
}
```

| Code | Meaning |
|---|---|
| `400` | Validation error (check `message` array for field details) |
| `401` | Missing or invalid auth token / API key |
| `403` | Authenticated but not authorized (wrong owner) |
| `404` | Resource not found |
| `409` | Conflict (e.g. Factory already claimed) |
| `429` | Rate limit exceeded |
| `500` | Internal server error |
