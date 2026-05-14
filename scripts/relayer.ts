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

import * as fs   from "fs";
import * as path from "path";
import { TonClient, Address, beginCell, Cell } from "@ton/core";
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
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? "";

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
    lastLt:        string;
    subscriptions: string[];
    retryState:    Record<string, RetryState>;
}

function loadDB(): SubscriptionDB {
    try {
        const raw = fs.readFileSync(DB_PATH, "utf8");
        const db  = JSON.parse(raw) as SubscriptionDB;
        if (!db.retryState) db.retryState = {};
        return db;
    } catch {
        return { lastLt: "0", subscriptions: [], retryState: {} };
    }
}

function saveDB(db: SubscriptionDB): void {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
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
}

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
    fs.writeFileSync(WAL_PATH, JSON.stringify(wal, null, 2), "utf8");
}

function walLogIntent(wal: Wal, address: string, seqno: number): void {
    wal.pending[address] = { address, seqno, attemptedAt: Math.floor(Date.now() / 1000) };
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
        msg_data: { "@type": string; init?: string; body?: string };
    }>;
}

async function indexNewSubscriptions(db: SubscriptionDB): Promise<void> {
    if (!FACTORY_ADDRESS) return;

    const baseUrl = endpoint.replace("/jsonRPC", "");
    const url = `${baseUrl}/getTransactions`
        + `?address=${FACTORY_ADDRESS}&limit=50&lt=${db.lastLt}&to_lt=0&archival=true`
        + (process.env.TONCENTER_API_KEY ? `&api_key=${process.env.TONCENTER_API_KEY}` : "");

    let txns: TonCen