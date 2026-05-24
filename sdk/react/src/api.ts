// ORBIT Operator REST API Client
//
// Typed HTTP client for operators integrating with the ORBIT backend.
// Authenticate with an `orbit_sk_*` API key (from the dashboard).
//
// Usage:
//   const client = new OrbitApiClient({
//     baseUrl: "https://your-backend.com/api/v1",
//     apiKey:  "orbit_sk_xxxxxxxx...",
//   });
//
//   const services = await client.services.list();

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ApiClientConfig {
    /** Base URL of the ORBIT backend, e.g. https://api.yourapp.com/api/v1 */
    baseUrl: string;
    /** API key in `orbit_sk_<32 hex>` format */
    apiKey:  string;
}

export interface ServiceRecord {
    id:               string;
    name:             string;
    description:      string | null;
    factoryAddress:   string;
    isActive:         boolean;
    registeredAt:     string;
    updatedAt:        string;
}

/** Matches the Prisma Plan model returned by GET /services/:id/plans */
export interface PlanRecord {
    id:             string;
    serviceId:      string;
    onchainPlanId:  number;   // plan_id in the smart contract (0-indexed)
    name:           string;
    description:    string | null;
    priceNano:      string;   // BigInt serialised as decimal string
    periodSeconds:  number;
    trialSeconds:   number;
    maxPeriods:     number | null;
    paymentType:    "TON" | "JETTON";
    jettonMaster:   string | null;
    isActive:       boolean;
    createdAt:      string;
}

/** Matches the Prisma Subscription model returned by the subscriptions endpoints */
export interface SubscriptionRecord {
    id:                   string;
    serviceId:            string;
    planId:               string;
    subscriberWallet:     string;   // non-bounceable TON address
    subscriptionAddress:  string;   // on-chain Subscription contract address
    status:               "TRIAL" | "ACTIVE" | "GRACE" | "PAUSED" | "CANCELLED";
    seqno:                number;   // number of successful charges
    depositNano:          string;   // BigInt as decimal string
    nextBillingTime:      string;   // ISO timestamp
    trialEndsAt:          string | null;
    graceSince:           string | null;
    cancelledAt:          string | null;
    createdAt:            string;
    updatedAt:            string;
    plan?:                Pick<PlanRecord, "id" | "onchainPlanId" | "name" | "priceNano" | "periodSeconds" | "paymentType">;
}

/** Paginated subscriptions response — cursor-based */
export interface PaginatedSubscriptions {
    data:        SubscriptionRecord[];
    nextCursor:  string | null;
    total:       number;
}

/** Single charge event (ChargeEvent Prisma model) */
export interface ChargeRecord {
    id:               string;
    serviceId:        string;
    subscriptionId:   string;
    seqnoFrom:        number;
    seqnoTo:          number;
    grossNano:        string;      // BigInt as decimal string
    netNano:          string;
    protocolFeeNano:  string;
    txHash:           string;
    timestamp:        string;      // ISO timestamp of the on-chain tx
    createdAt:        string;
    subscription?: {
        subscriberWallet:    string;
        subscriptionAddress: string;
    };
}

/** Paginated charges response from GET /services/:id/charges */
export interface PaginatedCharges {
    items: ChargeRecord[];
    meta: {
        total:      number;
        page:       number;
        limit:      number;
        totalPages: number;
    };
}

/** Real shape returned by GET /services/:id/analytics/overview */
export interface AnalyticsOverview {
    subscriptions: {
        active:    number;
        trial:     number;
        grace:     number;
        paused:    number;
        cancelled: number;
        total:     number;
    };
    charges: {
        total: number;
    };
    mrr: {
        mrrNano: string;   // BigInt as decimal string
        mrrTon:  string;   // formatted to 4 decimal places
    };
    churn: {
        churnRate:   string;   // e.g. "2.50%"
        cancelled:   number;
        totalAtStart: number;
    };
    period: number;            // echoes back the requested ?days value
}

/** Single data point from GET /services/:id/analytics/charges */
export interface AnalyticsChartPoint {
    date:     string;   // YYYY-MM-DD
    grossTon: number;   // total revenue on that day in TON (float)
    count:    number;   // number of successful charges
}

export interface WebhookEndpoint {
    id:          string;
    url:         string;
    events:      string[];
    isActive:    boolean;
    secretHint:  string;
    createdAt:   string;
    updatedAt:   string;
}

export interface ApiKeyRecord {
    id:          string;
    keyPrefix:   string;
    name:        string | null;
    scopes:      string[];
    isActive:    boolean;
    lastUsedAt:  string | null;
    expiresAt:   string | null;
    createdAt:   string;
    service:     { id: string; name: string } | null;
}

// ── Core fetch helper ─────────────────────────────────────────────────────────

class OrbitApiError extends Error {
    constructor(
        public readonly status:  number,
        public readonly message: string,
    ) {
        super(`[ORBIT API ${status}] ${message}`);
        this.name = "OrbitApiError";
    }
}

async function apiFetch<T>(
    baseUrl: string,
    apiKey:  string,
    method:  string,
    path:    string,
    body?:   unknown,
): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
            "Content-Type": "application/json",
            "X-API-Key":    apiKey,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
        let msg = res.statusText;
        try { msg = (await res.json()).message ?? msg; } catch { /* ignore */ }
        throw new OrbitApiError(res.status, msg);
    }

    return res.json() as Promise<T>;
}

// ── Resource namespaces ───────────────────────────────────────────────────────

class ServicesApi {
    constructor(private readonly req: <T>(m: string, p: string, b?: unknown) => Promise<T>) {}

    list(): Promise<ServiceRecord[]> {
        return this.req("GET", "/services");
    }

    get(serviceId: string): Promise<ServiceRecord> {
        return this.req("GET", `/services/${serviceId}`);
    }

    /** Public endpoint — no auth required. Returns service name + active plans. */
    publicInfo(serviceId: string): Promise<{ id: string; name: string; plans: PlanRecord[] }> {
        return this.req("GET", `/services/${serviceId}/public`);
    }
}

class PlansApi {
    constructor(private readonly req: <T>(m: string, p: string, b?: unknown) => Promise<T>) {}

    list(serviceId: string): Promise<PlanRecord[]> {
        return this.req("GET", `/services/${serviceId}/plans`);
    }

    /**
     * Sync a plan from the on-chain Factory into the database.
     * `onchainPlanId` must match the index in the deployed Factory contract.
     */
    create(serviceId: string, plan: {
        onchainPlanId: number;
        name:          string;
        description?:  string;
    }): Promise<PlanRecord> {
        return this.req("POST", `/services/${serviceId}/plans`, plan);
    }

    deactivate(serviceId: string, planId: string): Promise<{ id: string }> {
        return this.req("DELETE", `/services/${serviceId}/plans/${planId}`);
    }
}

class SubscriptionsApi {
    constructor(private readonly req: <T>(m: string, p: string, b?: unknown) => Promise<T>) {}

    /**
     * List subscriptions for a service with cursor-based pagination.
     * @param params.cursor  - last subscription `id` from the previous page's `nextCursor`
     * @param params.status  - optional filter: "TRIAL" | "ACTIVE" | "GRACE" | "PAUSED" | "CANCELLED"
     */
    list(serviceId: string, params?: {
        limit?:  number;
        cursor?: string;
        status?: "TRIAL" | "ACTIVE" | "GRACE" | "PAUSED" | "CANCELLED";
    }): Promise<PaginatedSubscriptions> {
        const qs = params ? "?" + new URLSearchParams(params as Record<string, string>).toString() : "";
        return this.req("GET", `/services/${serviceId}/subscriptions${qs}`);
    }

    get(serviceId: string, subscriptionId: string): Promise<SubscriptionRecord> {
        return this.req("GET", `/services/${serviceId}/subscriptions/${subscriptionId}`);
    }
}

class ChargesApi {
    // SDK-C2 fix: baseUrl and apiKey are passed explicitly because exportCsv
    // must use raw fetch (returns Blob, not JSON) and cannot go through apiFetch.
    constructor(
        private readonly req:     <T>(m: string, p: string, b?: unknown) => Promise<T>,
        private readonly baseUrl: string,
        private readonly apiKey:  string,
    ) {}

    list(serviceId: string, params?: { page?: number; limit?: number }): Promise<PaginatedCharges> {
        const qs = params ? "?" + new URLSearchParams(params as Record<string, string>).toString() : "";
        return this.req("GET", `/services/${serviceId}/charges${qs}`);
    }

    /** Download charge history as a CSV blob. */
    exportCsv(serviceId: string): Promise<Blob> {
        return fetch(`${this.baseUrl}/services/${serviceId}/charges/export`, {
            headers: { "X-API-Key": this.apiKey },
        }).then(r => {
            if (!r.ok) throw new OrbitApiError(r.status, r.statusText);
            return r.blob();
        });
    }
}

class AnalyticsApi {
    constructor(private readonly req: <T>(m: string, p: string, b?: unknown) => Promise<T>) {}

    // SDK-C3 fix: parameter renamed from `period` to `days` to match backend query param
    overview(serviceId: string, params?: { days?: 7 | 30 | 90 }): Promise<AnalyticsOverview> {
        const qs = params?.days ? `?days=${params.days}` : "";
        return this.req("GET", `/services/${serviceId}/analytics/overview${qs}`);
    }

    chart(serviceId: string, params?: { days?: number }): Promise<AnalyticsChartPoint[]> {
        const qs = params?.days ? `?days=${params.days}` : "";
        return this.req("GET", `/services/${serviceId}/analytics/charges${qs}`);
    }
}

class WebhooksApi {
    constructor(private readonly req: <T>(m: string, p: string, b?: unknown) => Promise<T>) {}

    list(serviceId: string): Promise<WebhookEndpoint[]> {
        return this.req("GET", `/services/${serviceId}/webhooks`);
    }

    /**
     * Register a webhook endpoint.
     * Returns the signing secret ONCE — store it immediately.
     *
     * Supported events:
     *   charge.success | charge.failed | subscription.activated |
     *   subscription.cancelled | subscription.grace | subscription.recovered
     */
    create(serviceId: string, endpoint: {
        url:    string;
        events: string[];
    }): Promise<WebhookEndpoint & { secret: string }> {
        return this.req("POST", `/services/${serviceId}/webhooks`, endpoint);
    }

    delete(serviceId: string, endpointId: string): Promise<{ id: string; isActive: false }> {
        return this.req("DELETE", `/services/${serviceId}/webhooks/${endpointId}`);
    }
}

class ApiKeysApi {
    constructor(private readonly req: <T>(m: string, p: string, b?: unknown) => Promise<T>) {}

    list(): Promise<ApiKeyRecord[]> {
        return this.req("GET", "/api-keys");
    }

    /** Returns the raw API key ONCE — store it securely. */
    create(params?: { name?: string; serviceId?: string; scopes?: string[] }): Promise<ApiKeyRecord & { key: string }> {
        return this.req("POST", "/api-keys", params ?? {});
    }

    revoke(keyId: string): Promise<ApiKeyRecord> {
        return this.req("DELETE", `/api-keys/${keyId}`);
    }
}

// ── Webhook signature verification ───────────────────────────────────────────

/**
 * Verify an incoming webhook signature from ORBIT.
 * Call this in your webhook handler BEFORE trusting the payload.
 *
 * @param body      Raw request body as a string (before JSON.parse)
 * @param signature Value of the `X-Orbit-Signature` header (format: "sha256=<hex>")
 * @param secret    Your endpoint's signing secret
 *
 * @example
 * const isValid = await verifyWebhookSignature(
 *   rawBody,
 *   req.headers["x-orbit-signature"],
 *   process.env.ORBIT_WEBHOOK_SECRET,
 * );
 * if (!isValid) return res.status(401).end();
 */
export async function verifyWebhookSignature(
    body:      string,
    signature: string,
    secret:    string,
): Promise<boolean> {
    // Works in browsers (Web Crypto) and Node.js 18+ (globalThis.crypto)
    const enc    = new TextEncoder();
    const key    = await crypto.subtle.importKey(
        "raw",
        enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const sigBuf  = await crypto.subtle.sign("HMAC", key, enc.encode(body));
    const hexHash = Array.from(new Uint8Array(sigBuf))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");

    // SDK-C1 fix: header is "sha256=<hex>", not bare hex
    const expected = `sha256=${hexHash}`;
    return expected === signature;
}

// ── Main client ───────────────────────────────────────────────────────────────

export class OrbitApiClient {
    readonly services:      ServicesApi;
    readonly plans:         PlansApi;
    readonly subscriptions: SubscriptionsApi;
    readonly charges:       ChargesApi;
    readonly analytics:     AnalyticsApi;
    readonly webhooks:      WebhooksApi;
    readonly apiKeys:       ApiKeysApi;

    constructor(private readonly config: ApiClientConfig) {
        const req = <T>(method: string, path: string, body?: unknown) =>
            apiFetch<T>(config.baseUrl, config.apiKey, method, path, body);

        this.services      = new ServicesApi(req);
        this.plans         = new PlansApi(req);
        this.subscriptions = new SubscriptionsApi(req);
        // SDK-C2: pass baseUrl + apiKey so exportCsv() has access for raw fetch
        this.charges       = new ChargesApi(req, config.baseUrl, config.apiKey);
        this.analytics     = new AnalyticsApi(req);
        this.webhooks      = new WebhooksApi(req);
        this.apiKeys       = new ApiKeysApi(req);
    }
}

export { OrbitApiError };
