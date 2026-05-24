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
  "operator": {
    "id":            "clx123...",
    "walletAddress": "UQD...",
    "createdAt":     "2026-01-01T00:00:00Z"
  }
}
```

> **Tokens are set as `httpOnly` cookies, not returned in the response body.** This prevents XSS exfiltration. The browser (or HTTP client) stores `orbit_access` (15 min) and `orbit_refresh` (30 days) cookies automatically. All subsequent requests carry them automatically — no manual `Authorization` header needed for browser clients.  
>
> For server-to-server integrations, use an **API key** (`X-API-Key`) instead of JWT.

---

### `POST /auth/refresh`

Rotate refresh token. Old token is invalidated; new tokens are set as `httpOnly` cookies.

**Request (browser clients):** no body required — the `orbit_refresh` cookie is sent automatically.

**Request (server-to-server fallback):**
```json
{ "refreshToken": "eyJ..." }
```

**Response:**
```json
{ "ok": true }
```

> New `orbit_access` and `orbit_refresh` cookies are set. Rate limit: **20 req / min / IP**.

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
    "registeredAt":   "2026-01-01T00:00:00Z"
  }
]
```

---

### `POST /services/claim` 🔐

Register a Factory contract as your service.  
The backend calls `get_service_addr()` on-chain to verify you own this contract.

**⚠️ The wallet you authenticated with MUST match `get_service_addr()` on the Factory.**

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
    {
      "onchainPlanId": 0,
      "priceNano":     "1000000000",
      "periodSeconds": 2592000,
      "trialSeconds":  604800,
      "maxPeriods":    null,
      "paymentType":   "TON",
      "jettonMaster":  null,
      "isActive":      true
    }
  ]
}
```

---

## Plans

### `GET /services/:serviceId/plans` 🔐

List all plans for a service.

---

### `POST /services/:serviceId/plans` 🔐

Sync a plan from the on-chain Factory into the database. The backend reads `price`, `period`, and `trialPeriod` directly from the contract via `get_plan_data()` — you only need to supply the on-chain plan index and a display name.

**Request:**
```json
{
  "onchainPlanId": 0,
  "name":          "Basic Monthly",
  "description":   "Access to all premium features"
}
```

| Field | Required | Description |
|---|---|---|
| `onchainPlanId` | ✅ | Zero-based plan index in the deployed Factory contract |
| `name` | ✅ | Display name shown in the dashboard |
| `description` | — | Optional human-readable description |

> `price`, `periodSeconds`, and `trialSeconds` are read from the contract automatically and cannot be overridden here.

**Errors:**
- `400` — plan index not found on-chain, or plan is already deactivated
- `409` — plan already synced (duplicate `onchainPlanId` for this service)

---

### `DELETE /services/:serviceId/plans/:planId` 🔐

Deactivate a plan.

---

## Subscriptions

### `GET /services/:serviceId/subscriptions` 🔐

List subscriptions. Supports cursor-based pagination:

```
GET /services/:serviceId/subscriptions?limit=50&cursor=<last_subscription_id>
```

**Query parameters:**

| Parameter | Default | Max | Description |
|---|---|---|---|
| `limit` | `50` | `200` | Number of results per page |
| `cursor` | — | — | Last subscription `id` from the previous page's `nextCursor` |

**Response:**
```json
{
  "data": [ /* subscription objects */ ],
  "nextCursor": "clx789...",
  "total": 342
}
```

> `nextCursor` is `null` when you have reached the last page.

**Status values:** `TRIAL` `ACTIVE` `PAUSED` `GRACE` `CANCELLED`

---

### `GET /services/:serviceId/subscriptions/:id` 🔐

Get a single subscription record (includes last 20 charge events).

```json
{
  "id":                   "clx456...",
  "serviceId":            "clx123...",
  "planId":               "clxplan...",
  "subscriberWallet":     "UQDsub...",
  "subscriptionAddress":  "EQAsubcontract...",
  "status":               "ACTIVE",
  "seqno":                3,
  "depositNano":          "3000000000",
  "nextBillingTime":      "2026-06-01T00:00:00Z",
  "trialEndsAt":          null,
  "graceSince":           null,
  "cancelledAt":          null,
  "createdAt":            "2026-01-01T00:00:00Z",
  "updatedAt":            "2026-05-01T00:00:00Z",
  "plan": { ... },
  "chargeEvents": [ ... ]
}
```

| Field | Description |
|---|---|
| `subscriberWallet` | Subscriber's wallet address (non-bounceable form) |
| `subscriptionAddress` | On-chain Subscription contract address |
| `seqno` | Number of successful charges so far |
| `depositNano` | Current deposit balance in nanoton (decimal string) |
| `nextBillingTime` | ISO timestamp of next scheduled charge |

---

## Charges

### `GET /services/:serviceId/charges` 🔐

List charge history. Supports page-based pagination.

```
GET /services/:serviceId/charges?page=1&limit=50
```

**Response:**
```json
{
  "items": [
    {
      "id":              "clx789...",
      "serviceId":       "clx123...",
      "subscriptionId":  "clx456...",
      "seqnoFrom":       2,
      "seqnoTo":         3,
      "grossNano":       "1000000000",
      "netNano":         "985000000",
      "protocolFeeNano": "15000000",
      "txHash":          "abc123def456...",
      "timestamp":       "2026-02-01T00:00:00Z",
      "createdAt":       "2026-02-01T00:00:01Z",
      "subscription": {
        "subscriberWallet":    "UQDsub...",
        "subscriptionAddress": "EQAsub..."
      }
    }
  ],
  "meta": {
    "total":      1840,
    "page":       1,
    "limit":      50,
    "totalPages": 37
  }
}
```

| Field | Description |
|---|---|
| `grossNano` | Full plan price charged (decimal string, nanoton) |
| `netNano` | `gross − protocol fee (1.5%)`. Note: service fee (`fee_bps`) is also deducted on-chain and not reflected here |
| `protocolFeeNano` | 1.5% ORBIT protocol fee deducted from gross |
| `seqnoFrom` / `seqnoTo` | Subscription seqno before and after this charge |
| `txHash` | On-chain transaction hash for independent verification |

---

### `GET /services/:serviceId/charges/export` 🔐

Download charges as CSV.

---

## Analytics

### `GET /services/:serviceId/analytics/overview` 🔐

```
GET /services/:serviceId/analytics/overview?days=30
```

`days`: `7` | `30` | `90` (default 30)

**Response:**
```json
{
  "subscriptions": {
    "active":    142,
    "trial":     23,
    "grace":     5,
    "paused":    3,
    "cancelled": 11,
    "total":     173
  },
  "charges": { "total": 1840 },
  "mrr": {
    "mrrNano": "386500000000",
    "mrrTon":  "386.5000"
  },
  "churn": {
    "churnRate":   "2.50%",
    "cancelled":   3,
    "totalAtStart": 120
  },
  "period": 30
}
```

> `churn` is present on all responses. `churnRate` is a string like `"2.50%"`.  
> `period` echoes back the requested `days` value.  
> `subscriptions.total` = active + trial + grace + paused (excludes cancelled).  
> Note: `chargesToday` and `successRate` are not returned by this endpoint.

---

### `GET /services/:serviceId/analytics/charges` 🔐

Daily chart data (one entry per day, sorted ascending).

```
GET /services/:serviceId/analytics/charges?days=30
```

`days`: 1–365 (default 30)

```json
[
  { "date": "2026-05-01", "grossTon": 5.0,  "count": 5 },
  { "date": "2026-05-02", "grossTon": 3.12, "count": 3 }
]
```

| Field | Description |
|---|---|
| `date` | ISO date string `YYYY-MM-DD` |
| `grossTon` | Total revenue on that day in TON (float) |
| `count` | Number of successful charges |

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
| `subscription.recovered` | Grace period ended, subscription recovered after top-up |

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
