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
    claimedAt:        string;
}

export interface PlanRecord {
    id:           string;
    planId:       number;
    name:         string | null;
    price:        string;   // nanoton as string
    period:       number;   // seconds
    trialPeriod:  number;
    isActive:     boolean;
}

export interface SubscriptionRecord {
    id:                   string;
    subscriberAddress:    string;
    subscriptionAddress:  string;
    status:               string;
    planId:               number;
    deposit:              string;
    nextBillingTime:      string | null;
    periodsCharged:       number;
    createdAt:            string;
}

export interface ChargeRecord {
    id:          string;
    txHash:      string | null;
    amount:      string;
    success:     boolean;
    chargedAt:   string;
}

export interface AnalyticsOverview {
    activeSubscriptions:   number;
    totalRevenue:          string;
    mrr:                   string;
    churnRate:             number;
    chargesToday:          number;
    successRate:           number;
}

export interface AnalyticsChartPoint {
    date:     string;
    revenue:  string;
    charges:  number;
}

export interface WebhookEndpoint {
    id:          string;
    url:         string;
    events:      string[];
    isActive:    boolean;
    secretHint:  string;
    createdAt:   string;
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

    publicInfo(serviceId: string): Promise<{ name: string; plans: PlanRecord[] }> {
        return this.req("GET", `/services/${serviceId}/public`);
    }
}

class PlansApi {
    constructor(private readonly req: <T>(m: string, p: string, b?: unknown) => Promise<T>) {}

    list(serviceId: string): Promise<PlanRecord[]> {
        return this.req("GET", `/services/${serviceId}/plans`);
    }

    create(serviceId: string, plan: {
        name?:         string;
        price:         string;
        period:        number;
        trialPeriod?:  number;
    }): Promise<PlanRecord> {
        return this.req("POST", `/services/${serviceId}/plans`, plan);
    }

    deactivate(serviceId: string, planId: string): Promise<PlanRecord> {
        return this.req("DELETE", `/services/${serviceId}/plans/${planId}`);
    }
}

class SubscriptionsApi {
    constructor(private readonly req: <T>(m: string, p: string, b?: unknown) => Promise<T>) {}

    list(serviceId: string, params?: { status?: string; limit?: number; offset?: number }): Promise<SubscriptionRecord[]> {
        const qs = params ? "?" + new URLSearchParams(params as Record<string, string>).toString() : "";
        return this.req("GET", `/services/${serviceId}/subscriptions${qs}`);
    }

    get(serviceId: string, subscriptionId: string): Promise<SubscriptionRecord> {
        return this.req("GET", `/services/${serviceId}/subscriptions/${subscriptionId}`);
    }
}

class ChargesApi {
    constructor(private readonly req: <T>(m: string, p: string, b?: unknown) => Promise<T>) {}

    list(serviceId: string, params?: { limit?: number; offset?: number }): Promise<ChargeRecord[]> {
        const qs = params ? "?" + new URLSearchParams(params as Record<string, string>).toString() : "";
        return this.req("GET", `/services/${serviceId}/charges${qs}`);
    }

    exportCsv(serviceId: string): Promise<Blob> {
        // Raw fetch — returns CSV blob
        return fetch(`${(this as any)._baseUrl}/services/${serviceId}/charges/export`, {
            headers: { "X-API-Key": (this as any)._apiKey },
        }).then(r => r.blob());
    }
}

class AnalyticsApi {
    constructor(private readonly req: <T>(m: string, p: string, b?: unknown) => Promise<T>) {}

    overview(serviceId: string, params?: { period?: 7 | 30 | 90 }): Promise<AnalyticsOverview> {
        const qs = params?.period ? `?period=${params.period}` : "";
        return this.req("GET", `/services/${serviceId}/analytics/overview${qs}`);
    }

    chart(serviceId: string, params?: { period?: 7 | 30 | 90 }): Promise<AnalyticsChartPoint[]> {
        const qs = params?.period ? `?period=${params.period}` : "";
        return this.req("GET", `/services/${serviceId}/analytics/charges${qs}`);
    }
}

class WebhooksApi {
    constructor(private readonly req: <T>(m: string, p: string, b?: unknown) => Promise<T>) {}

    list(serviceId: string): Promise<WebhookEndpoint[]> {
        return this.req("GET", `/services/${serviceId}/webhooks`);
    }

    /** Returns the signing secret ONCE — store it immediately. */
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
 * Call this in your webhook handler before trusting the payload.
 *
 * @param body     Raw request body as a string (before JSON.parse)
 * @param signature Value of the X-Orbit-Signature header
 * @param secret   Your endpoint's signing secret
 */
export async function verifyWebhookSignature(
    body:      string,
    signature: string,
    secret:    string,
): Promise<boolean> {
    // Works in browsers (Web Crypto) and Node.js 18+ (globalThis.crypto)
    const enc     = new TextEncoder();
    const key     = await crypto.subtle.importKey(
        "raw",
        enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const sigBuf  = await crypto.subtle.sign("HMAC", key, enc.encode(body));
    const computed = Array.from(new Uint8Array(sigBuf))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
    return computed === signature;
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
        this.charges       = new ChargesApi(req);
        this.analytics     = new AnalyticsApi(req);
        this.webhooks      = new WebhooksApi(req);
        this.apiKeys       = new ApiKeysApi(req);
    }
}

export { OrbitApiError };
