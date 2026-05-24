// ORBIT Charge Relayer
//
// Polls TON for subscriptions whose next_billing_time has passed and sends
// signed OP_CHARGE_EXT external messages to trigger billing cycles.
//
// Reliability features:
//   WAL (write-ahead log): intent is flushed to disk before every send.
//   The WAL entry is deleted only after on-chain confirmation.  On restart,
//   unconfirmed WAL entries are retried before normal polling resumes.
//
//   Exponential backoff: failed charges are retried with 30 s → 60 s → 120 s
//   → … → 3600 s cap.  Separate retry counters per subscription address.
//
// Discovery strategy:
//   Indexes outgoing messages from the Factory contract.  Any message that
//   deploys a new account (has StateInit) is a subscription creation.
//   The destination address of that message is stored in a local JSON
//   database (data/subscriptions.json) so restarts don't re-scan everything.
//
// Signing:
//   Each external message is signed with RELAYER_MNEMONIC → Ed25519 key.
//   The public key of this key MUST match the relayer_pubkey stored in every
//   Subscription contract.
//
// Usage:
//   ts-node scripts/relayer.ts
//
// Environment variables:
//   TONCENTER_API_KEY       — TonCenter v2 API key
//   FACTORY_ADDRESS         — factory contract address (required)
//   RELAYER_MNEMONIC        — space-separated mnemonic (required)
//   POLL_INTERVAL_MS        — default 60000
//   NETWORK                 — "mainnet" | "testnet" (default "testnet")
//   DB_PATH                 — path to subscription database (default "data/subscriptions.json")
//   WAL_PATH                — path to write-ahead log (default "data/relayer-wal.json")

import * as dotenv from "dotenv";
dotenv.config();

import * as fs     from "fs";
import * as path   from "path";
import { createHmac } from "crypto";
import { TonClient } from "@ton/ton";
import { Address, beginCell, Cell } from "@ton/core";
import { mnemonicToPrivateKey, sign }           from "@ton/crypto";
import { Subscription, Status }                  from "../wrappers/Subscription";

// ── Config ────────────────────────────────────────────────────────────────────

const FACTORY_ADDRESS  = process.env.FACTORY_ADDRESS  ?? "";
const RELAYER_MNEMONIC = process.env.RELAYER_MNEMONIC ?? "";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "60000", 10);
const CHARGE_LEAD_S    = 120;
const NETWORK          = process.env.NETWORK ?? "testnet";
const DB_PATH    = process.env.DB_PATH    ?? path.join(__dirname, "../data/subscriptions.json");
const WAL_PATH   = process.env.WAL_PATH   ?? path.join(__dirname, "../data/relayer-wal.json");
const WEBHOOK_URL    = process.env.WEBHOOK_URL    ?? "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "";

// Comma-separated list of subscription addresses to seed on first run.
// Use this when deploying against a factory that already has subscription history
// so the relayer doesn't miss contracts deployed before it started.
// Example: INITIAL_SUBSCRIPTIONS="EQDabc...,EQDdef..."
const INITIAL_SUBSCRIPTIONS: string[] = (process.env.INITIAL_SUBSCRIPTIONS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const OP_CHARGE_EXT = 0x4F520030;

// Exponential backoff config
const BACKOFF_BASE_S  = 30;
const BACKOFF_MAX_S   = 3600;
const BACKOFF_FACTOR  = 2;

// ── TON client ────────────────────────────────────────────────────────────────

const endpoint = NETWORK === "mainnet"
    ? "https://toncenter.com/api/v2/jsonRPC"
    : "https://testnet.toncenter.com/api/v2/jsonRPC";

const client = new TonClient({
    endpoint,
    apiKey: process.env.TONCENTER_API_KEY,
});

// ── Local subscription database ───────────────────────────────────────────────

interface RetryState {
    failCount:   number;
    nextRetryAt: number; // unix timestamp
}

interface SubscriptionDB {
    lastLt:          string;
    subscriptions:   string[];
    retryState:      Record<string, RetryState>;
    initialScanDone: boolean; // true after first full history scan completes
}

function loadDB(): SubscriptionDB {
    try {
        const raw = fs.readFileSync(DB_PATH, "utf8");
        const db  = JSON.parse(raw) as SubscriptionDB;
        if (!db.retryState)      db.retryState = {};
        if (!db.initialScanDone) db.initialScanDone = false;
        return db;
    } catch {
        return { lastLt: "0", subscriptions: [], retryState: {}, initialScanDone: false };
    }
}

function saveDB(db: SubscriptionDB): void {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    // Atomic write: flush to a temp file first, then rename.
    // rename() is an atomic OS-level operation on the same filesystem —
    // the reader always sees either the old or the new complete file, never
    // a half-written one (which would produce corrupt JSON on restart).
    const tmp = DB_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
    fs.renameSync(tmp, DB_PATH);
}

// ── Write-ahead log ───────────────────────────────────────────────────────────
//
// Before sending a charge message, log the intent to disk.  After on-chain
// confirmation (seqno advanced), delete the entry.  On startup, replay any
// unconfirmed entries — this covers relayer crashes mid-send.

interface WalEntry {
    address:        string;
    seqno:          number;
    attemptedAt:    number;
    attempts:       number; // incremented on every replay attempt
}

// WAL entry is abandoned after this many retries OR this many seconds since first attempt.
// Prevents stuck WAL from blocking billing indefinitely when TonCenter is flaky.
const WAL_MAX_ATTEMPTS = 10;
const WAL_MAX_AGE_S    = 1800; // 30 minutes

interface Wal {
    pending: Record<string, WalEntry>; // keyed by address
}

function loadWal(): Wal {
    try {
        return JSON.parse(fs.readFileSync(WAL_PATH, "utf8")) as Wal;
    } catch {
        return { pending: {} };
    }
}

function saveWal(wal: Wal): void {
    fs.mkdirSync(path.dirname(WAL_PATH), { recursive: true });
    // Atomic write via temp-file + rename — same rationale as saveDB().
    // Critical here: a crash during WAL save must never silently lose the
    // pending entry (which would skip the confirmatory seqno check on restart).
    const tmp = WAL_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(wal, null, 2), "utf8");
    fs.renameSync(tmp, WAL_PATH);
}

function walLogIntent(wal: Wal, address: string, seqno: number): void {
    const existing = wal.pending[address];
    wal.pending[address] = {
        address,
        seqno,
        attemptedAt: existing?.attemptedAt ?? Math.floor(Date.now() / 1000),
        attempts:    (existing?.attempts ?? 0) + 1,
    };
    saveWal(wal);
}

function walClearEntry(wal: Wal, address: string): void {
    delete wal.pending[address];
    saveWal(wal);
}

// ── Transaction indexer ───────────────────────────────────────────────────────

interface TonCenterTransaction {
    transaction_id: { lt: string; hash: string };
    out_msgs: Array<{
        destination: string;
        msg_data: { "@type": string; init?: string; init_state?: string; body?: string };
    }>;
}

const baseUrl = endpoint.replace("/jsonRPC", "");

async function fetchTxPage(lt: string, toLt: string = "0"): Promise<TonCenterTransaction[]> {
    const apiKey = process.env.TONCENTER_API_KEY ? `&api_key=${process.env.TONCENTER_API_KEY}` : "";
    const url = `${baseUrl}/getTransactions`
        + `?address=${FACTORY_ADDRESS}&limit=50&lt=${lt}&to_lt=${toLt}&archival=true${apiKey}`;
    const resp = await fetch(url);
    const json = await resp.json() as { ok: boolean; result: TonCenterTransaction[] };
    if (!json.ok) return [];
    return json.result;
}

function collectSubscriptions(
    txns:  TonCenterTransaction[],
    known: Set<string>,
    db:    SubscriptionDB,
): void {
    for (const tx of txns) {
        for (const msg of tx.out_msgs) {
            if ((msg.msg_data?.init || msg.msg_data?.init_state) && msg.destination && !known.has(msg.destination)) {
                console.log(`[relayer] Discovered subscription: ${msg.destination}`);
                db.subscriptions.push(msg.destination);
                known.add(msg.destination);
            }
        }
    }
}

// Returns the smallest (oldest) lt seen in a batch, as a bigint.
function oldestLt(txns: TonCenterTransaction[]): bigint {
    return txns.reduce(
        (min, tx) => { const lt = BigInt(tx.transaction_id.lt); return lt < min ? lt : min; },
        BigInt(txns[0].transaction_id.lt),
    );
}

async function indexNewSubscriptions(db: SubscriptionDB): Promise<void> {
    if (!FACTORY_ADDRESS) return;

    const known = new Set(db.subscriptions);

    // Seed manually-provided addresses before any network scan.
    for (const addr of INITIAL_SUBSCRIPTIONS) {
        if (!known.has(addr)) {
            console.log(`[relayer] Seeded subscription from env: ${addr}`);
            db.subscriptions.push(addr);
            known.add(addr);
        }
    }

    if (!db.initialScanDone) {
        // First run: paginate backwards through the full factory tx history so we
        // don't miss subscriptions deployed before the relayer first started.
        // TonCenter returns transactions older than `lt` (newest-first), so we
        // walk backwards by using the oldest lt from each page as the next anchor.
        console.log("[relayer] Initial scan: paginating full factory history…");
        let pageLt = "0";
        let pages  = 0;

        while (true) {
            let txns: TonCenterTransaction[];
            try {
                txns = await fetchTxPage(pageLt);
            } catch (err) {
                console.error("[relayer] Fetch error during initial scan:", (err as Error).message);
                break; // leave initialScanDone=false so we retry next cycle
            }
            if (txns.length === 0) break;
            pages++;
            collectSubscriptions(txns, known, db);

            // Track the newest lt we've ever seen (used for incremental updates later).
            const newestOnPage = txns.reduce(
                (max, tx) => { const lt = BigInt(tx.transaction_id.lt); return lt > max ? lt : max; },
                0n,
            );
            if (newestOnPage > BigInt(db.lastLt)) db.lastLt = newestOnPage.toString();

            if (txns.length < 50) break; // last page
            pageLt = oldestLt(txns).toString();
        }

        db.initialScanDone = true;
        console.log(`[relayer] Initial scan complete (${pages} pages, ${db.subscriptions.length} subscriptions)`);
    } else {
        // Incremental: fetch only transactions newer than lastLt.
        let txns: TonCenterTransaction[];
        try {
            txns = await fetchTxPage("0", db.lastLt);
        } catch (err) {
            console.error("[relayer] Failed to fetch transactions:", (err as Error).message);
            return;
        }
        collectSubscriptions(txns, known, db);
        for (const tx of txns) {
            if (BigInt(tx.transaction_id.lt) > BigInt(db.lastLt)) {
                db.lastLt = tx.transaction_id.lt;
            }
        }
    }
}

// ── Charge message builder ────────────────────────────────────────────────────

function buildChargeMessage(seqno: number, secretKey: Buffer): Cell {
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = beginCell()
        .storeUint(seqno,        32)
        .storeUint(timestamp,    32)
        .storeUint(OP_CHARGE_EXT, 32)
    .endCell();
    const sig = sign(payload.hash(), secretKey);
    return beginCell()
        .storeBuffer(sig)
        .storeSlice(payload.beginParse())
    .endCell();
}

// ── Back-off helpers ──────────────────────────────────────────────────────────

function backoffDelay(failCount: number): number {
    const delay = BACKOFF_BASE_S * Math.pow(BACKOFF_FACTOR, failCount);
    return Math.min(delay, BACKOFF_MAX_S);
}

function markFailure(db: SubscriptionDB, addrStr: string): void {
    const prev = db.retryState[addrStr] ?? { failCount: 0, nextRetryAt: 0 };
    const nextFail = prev.failCount + 1;
    db.retryState[addrStr] = {
        failCount:   nextFail,
        nextRetryAt: Math.floor(Date.now() / 1000) + backoffDelay(nextFail),
    };
}

function markSuccess(db: SubscriptionDB, addrStr: string): void {
    delete db.retryState[addrStr];
}

function isBackedOff(db: SubscriptionDB, addrStr: string): boolean {
    const state = db.retryState[addrStr];
    if (!state) return false;
    return Math.floor(Date.now() / 1000) < state.nextRetryAt;
}

// ── Webhook ───────────────────────────────────────────────────────────────────
//
// Fires a POST to WEBHOOK_URL after every confirmed charge.
// Failures are logged but never propagate — the charge already landed.

async function fireWebhook(payload: {
    event:       string;
    address:     string;
    seqno_from:  number;
    seqno_to:    number;
    timestamp:   number;
}): Promise<void> {
    if (!WEBHOOK_URL) return;
    try {
        const body_str = JSON.stringify(payload);
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (WEBHOOK_SECRET) {
            const sig = createHmac("sha256", WEBHOOK_SECRET).update(body_str).digest("hex");
            headers["X-Orbit-Signature"] = `sha256=${sig}`;
        }
        await fetch(WEBHOOK_URL, {
            method:  "POST",
            headers,
            body:    body_str,  // same string used for HMAC — must not re-serialize
        });
    } catch (err) {
        console.warn(`[relayer] Webhook delivery failed: ${(err as Error).message}`);
    }
}

// ── Core charge logic ─────────────────────────────────────────────────────────

async function tryCharge(
    addrStr:   string,
    secretKey: Buffer,
    wal:       Wal,
    db:        SubscriptionDB,
): Promise<void> {
    const addr = Address.parse(addrStr);
    const sub  = client.open(Subscription.createFromAddress(addr));

    const seqno = await sub.getSeqno();

    // WAL: log intent before sending — crash-safe
    walLogIntent(wal, addrStr, seqno);

    const extMsg = buildChargeMessage(seqno, secretKey);
    await client.sendExternalMessage(Subscription.createFromAddress(addr), extMsg);

    // Wait up to 30 s for seqno to advance (confirms the tx landed)
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3_000));
        try {
            const newSeqno = await sub.getSeqno();
            if (newSeqno > seqno) {
                walClearEntry(wal, addrStr);
                markSuccess(db, addrStr);
                console.log(`[relayer] Charged ${addrStr} (seqno ${seqno} → ${newSeqno})`);
                await fireWebhook({
                    event:      "charge.success",
                    address:    addrStr,
                    seqno_from: seqno,
                    seqno_to:   newSeqno,
                    timestamp:  Math.floor(Date.now() / 1000),
                });
                return;
            }
        } catch { /* chain not yet updated */ }
    }

    // Seqno didn't advance in time — treat as failure (WAL stays)
    throw new Error(`seqno did not advance within 30 s (expected > ${seqno})`);
}

// ── WAL recovery ──────────────────────────────────────────────────────────────
//
// On startup, replay any WAL entries that were not confirmed before the last crash.

async function replayWal(wal: Wal, secretKey: Buffer, db: SubscriptionDB): Promise<void> {
    const entries = Object.values(wal.pending);
    if (entries.length === 0) return;
    console.log(`[relayer] WAL recovery: ${entries.length} unconfirmed entries`);

    const now = Math.floor(Date.now() / 1000);

    for (const entry of entries) {
        const addr = Address.parse(entry.address);
        const sub  = client.open(Subscription.createFromAddress(addr));

        // ── Abandon check ─────────────────────────────────────────────────────
        // If the WAL entry has been retried too many times or is too old, it is
        // likely from a TonCenter outage that already resolved.  Check on-chain
        // seqno once more; if not confirmed, abandon and let the main scan loop
        // re-charge on the next poll cycle.
        const age      = now - (entry.attemptedAt ?? now);
        const tooOld   = age > WAL_MAX_AGE_S;
        const tooMany  = (entry.attempts ?? 0) >= WAL_MAX_ATTEMPTS;

        if (tooOld || tooMany) {
            try {
                const liveSeqno = await sub.getSeqno();
                if (liveSeqno > entry.seqno) {
                    walClearEntry(wal, entry.address);
                    console.log(`[relayer] WAL: ${entry.address} confirmed on abandon-check (seqno=${liveSeqno})`);
                } else {
                    walClearEntry(wal, entry.address);
                    console.warn(`[relayer] WAL: abandoned ${entry.address} after ${entry.attempts} attempts / ${age}s — will retry via normal scan`);
                }
            } catch {
                walClearEntry(wal, entry.address);
                console.warn(`[relayer] WAL: abandoned ${entry.address} (seqno check failed) — will retry via normal scan`);
            }
            continue;
        }

        try {
            const liveSeqno = await sub.getSeqno();
            if (liveSeqno > entry.seqno) {
                // Already confirmed on-chain — TonCenter 500 was a false negative
                walClearEntry(wal, entry.address);
                console.log(`[relayer] WAL: ${entry.address} already confirmed (seqno=${liveSeqno})`);
            } else {
                // Not yet confirmed — retry
                console.log(`[relayer] WAL: retrying ${entry.address} (attempt ${(entry.attempts ?? 0) + 1}, seqno=${entry.seqno})`);
                await tryCharge(entry.address, secretKey, wal, db);
            }
        } catch (err) {
            // After sendExternalMessage fails, check on-chain seqno once more —
            // TonCenter sometimes returns 500 even when the tx was accepted.
            try {
                const liveSeqno = await sub.getSeqno();
                if (liveSeqno > entry.seqno) {
                    walClearEntry(wal, entry.address);
                    console.log(`[relayer] WAL: ${entry.address} confirmed despite 500 (seqno=${liveSeqno})`);
                    return;
                }
            } catch { /* ignore */ }
            console.error(`[relayer] WAL replay failed for ${entry.address}:`, (err as Error).message);
            markFailure(db, entry.address);
        }
    }
}

// ── Main poll cycle ───────────────────────────────────────────────────────────

async function pollCycle(secretKey: Buffer): Promise<void> {
    const db  = loadDB();
    const wal = loadWal();
    const now = Math.floor(Date.now() / 1000);

    // 1. Replay any crashed WAL entries first
    await replayWal(wal, secretKey, db);

    // 2. Discover new subscriptions
    await indexNewSubscriptions(db);
    saveDB(db);

    console.log(`[relayer] Scanning ${db.subscriptions.length} subscriptions…`);

    // 3. Check each subscription
    for (const addrStr of db.subscriptions) {
        let addr: Address;
        try { addr = Address.parse(addrStr); } catch { continue; }

        // Skip if in exponential back-off window
        if (isBackedOff(db, addrStr)) continue;

        try {
            const sub = client.open(Subscription.createFromAddress(addr));
            // Fetch status and billing time in parallel to halve RPC latency
            const [status, nextBt] = await Promise.all([
                sub.getStatus(),
                sub.getNextBillingTime(),
            ]);

            if (status === Status.CANCELLED || status === Status.PAUSED) continue;
            if (nextBt - CHARGE_LEAD_S > now) continue;

            await tryCharge(addrStr, secretKey, wal, db);
            await new Promise((r) => setTimeout(r, 500));
        } catch (err) {
            console.error(`[relayer] Error on ${addrStr}:`, (err as Error).message);
            markFailure(db, addrStr);
        }
    }

    // Persist retry state updates
    saveDB(db);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
    if (!FACTORY_ADDRESS) {
        console.error("[relayer] FACTORY_ADDRESS is not set"); process.exit(1);
    }
    if (!RELAYER_MNEMONIC) {
        console.error("[relayer] RELAYER_MNEMONIC is not set"); process.exit(1);
    }

    const keyPair   = await mnemonicToPrivateKey(RELAYER_MNEMONIC.split(" "));
    const secretKey = Buffer.from(keyPair.secretKey);

    console.log(`[relayer] ORBIT Charge Relayer (${NETWORK})`);
    console.log(`[relayer] Factory  : ${FACTORY_ADDRESS}`);
    console.log(`[relayer] Pubkey   : ${Buffer.from(keyPair.publicKey).toString("hex")}`);
    console.log(`[relayer] Interval : ${POLL_INTERVAL_MS} ms`);
    console.log(`[relayer] DB       : ${DB_PATH}`);
    console.log(`[relayer] WAL      : ${WAL_PATH}`);
    if (WEBHOOK_URL) console.log(`[relayer] Webhook  : ${WEBHOOK_URL}`);

    await pollCycle(secretKey);
    setInterval(() => pollCycle(secretKey), POLL_INTERVAL_MS);
}

main().catch((err) => { console.error(err); process.exit(1); });
