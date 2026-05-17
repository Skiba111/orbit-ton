/**
 * ORBIT — Add a subscription plan to a Factory.
 *
 * Sends OP_ADD_PLAN from the service wallet (owner of the Factory).
 * Can only be called by the wallet that registered the service.
 *
 * Usage:
 *   ts-node scripts/add-plan.ts
 *
 * Required env vars (.env):
 *   WALLET_MNEMONIC   — service operator wallet (Factory owner)
 *   FACTORY_ADDRESS   — address of your Factory contract
 *   TONCENTER_API_KEY — TonCenter API key
 *   NETWORK           — testnet | mainnet
 *   WALLET_VERSION    — v4 | v5 (default: v5)
 *
 * Plan params (edit below or pass as env vars):
 *   PLAN_PRICE_TON    — price in TON (e.g. "1.5")
 *   PLAN_PERIOD_DAYS  — billing period in days (e.g. "30")
 *   PLAN_TRIAL_DAYS   — trial period in days, 0 = no trial (e.g. "7")
 *   PLAN_NAME         — plan name string (e.g. "Basic")
 */

import * as dotenv from "dotenv";
dotenv.config();

import "./patch-ton-core";

import { mnemonicToPrivateKey, sign } from "@ton/crypto";

(require("@ton/core") as any).domainSign ??= (args: {
    data: Buffer | Uint8Array;
    secretKey: Buffer;
    domain?: string;
}) => {
    if (args.domain) {
        const d   = Buffer.from(args.domain, "utf8");
        const len = Buffer.allocUnsafe(4);
        len.writeUInt32BE(d.length, 0);
        return sign(Buffer.concat([Buffer.from([0xff, 0xff]), len, d, Buffer.from(args.data)]), args.secretKey);
    }
    return sign(Buffer.from(args.data), args.secretKey);
};

import {
    beginCell, Address, toNano, Cell,
    storeMessage, storeMessageRelaxed, internal, external, SendMode,
} from "@ton/core";
import { WalletContractV4, WalletContractV5R1 } from "@ton/ton";

// ── Config ──────────────────────────────────────────────────────────────────

const NETWORK           = process.env.NETWORK          ?? "testnet";
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY ?? "";
const WALLET_MNEMONIC   = process.env.WALLET_MNEMONIC   ?? process.env.MNEMONICS ?? "";
const FACTORY_ADDRESS   = process.env.FACTORY_ADDRESS   ?? "";
const WALLET_VERSION    = (process.env.WALLET_VERSION   ?? "v5").toLowerCase();

// ── Plan parameters (override via env or edit here) ─────────────────────────

const PLAN_PRICE_TON   = process.env.PLAN_PRICE_TON  ?? "1";       // TON per cycle
const PLAN_PERIOD_DAYS = process.env.PLAN_PERIOD_DAYS ?? "30";      // billing period
const PLAN_TRIAL_DAYS  = process.env.PLAN_TRIAL_DAYS  ?? "0";       // 0 = no trial
const PLAN_NAME        = process.env.PLAN_NAME        ?? "Basic";   // plan name

// ── Derived ──────────────────────────────────────────────────────────────────

const PLAN_PRICE_NANO  = toNano(PLAN_PRICE_TON);
const PLAN_PERIOD_SEC  = parseInt(PLAN_PERIOD_DAYS) * 86400;
const PLAN_TRIAL_SEC   = parseInt(PLAN_TRIAL_DAYS)  * 86400;
const PLAN_NAME_HASH   = BigInt("0x" + Buffer.from(PLAN_NAME).toString("hex").padEnd(64, "0").slice(0, 64));

const NETWORK_GLOBAL_ID = NETWORK === "mainnet" ? -239 : -3;

const API_BASE = NETWORK === "mainnet"
    ? "https://toncenter.com/api/v2"
    : "https://testnet.toncenter.com/api/v2";

const HTTP_HEADERS: Record<string, string> = { "Content-Type": "application/json" };
if (TONCENTER_API_KEY) HTTP_HEADERS["X-API-KEY"] = TONCENTER_API_KEY;

const OP_ADD_PLAN = 0x4F520002;

// ── TonCenter helpers ────────────────────────────────────────────────────────

async function getSeqno(addr: Address): Promise<number> {
    const res  = await fetch(`${API_BASE}/runGetMethod`, {
        method: "POST", headers: HTTP_HEADERS,
        body: JSON.stringify({ address: addr.toString(), method: "seqno", stack: [] }),
    });
    const json = await res.json() as { ok: boolean; result?: { stack: [string,string][]; exit_code: number } };
    if (!json.ok || !json.result || json.result.exit_code !== 0) return 0;
    if (!json.result.stack?.length) return 0;
    return parseInt(json.result.stack[0][1], 16);
}

async function getPlanCount(addr: Address): Promise<number> {
    const res  = await fetch(`${API_BASE}/runGetMethod`, {
        method: "POST", headers: HTTP_HEADERS,
        body: JSON.stringify({ address: addr.toString(), method: "get_plan_count", stack: [] }),
    });
    const json = await res.json() as { ok: boolean; result?: { stack: [string,string][]; exit_code: number } };
    if (!json.ok || !json.result || json.result.exit_code !== 0) return 0;
    if (!json.result.stack?.length) return 0;
    return parseInt(json.result.stack[0][1], 16);
}

async function sendBoc(boc: string): Promise<void> {
    const res  = await fetch(`${API_BASE}/sendBoc`, {
        method: "POST", headers: HTTP_HEADERS,
        body: JSON.stringify({ boc }),
    });
    const json = await res.json() as { ok: boolean; error?: string };
    if (!json.ok) throw new Error(`sendBoc failed: ${json.error ?? JSON.stringify(json)}`);
}

async function waitTx(expectedSeqno: number, walletAddr: Address, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    process.stdout.write("  Waiting");
    while (Date.now() < deadline) {
        if (await getSeqno(walletAddr) >= expectedSeqno) { console.log(" ✅"); return; }
        await new Promise(r => setTimeout(r, 3_000));
        process.stdout.write(".");
    }
    throw new Error("\nTimeout — tx not confirmed");
}

// ── Message helpers ──────────────────────────────────────────────────────────

const WALLET_V4_ID = 698983191;

function buildV4Body(seqno: number, secretKey: Buffer, msgs: { to: Address; value: bigint; body: Cell }[]): Cell {
    let inner = beginCell()
        .storeUint(WALLET_V4_ID, 32)
        .storeUint(Math.floor(Date.now() / 1000) + 60, 32)
        .storeUint(seqno, 32)
        .storeUint(0, 8);
    for (const m of msgs) {
        const msgCell = beginCell().store(storeMessageRelaxed(internal({ to: m.to, value: m.value, bounce: true, body: m.body }))).endCell();
        inner = inner.storeUint(SendMode.PAY_GAS_SEPARATELY, 8).storeRef(msgCell) as typeof inner;
    }
    const innerCell = inner.endCell();
    return beginCell().storeBuffer(sign(innerCell.hash(), secretKey)).storeSlice(innerCell.beginParse()).endCell();
}

function buildV5Body(wallet: WalletContractV5R1, seqno: number, secretKey: Buffer, msgs: { to: Address; value: bigint; body: Cell }[]): Cell {
    return wallet.createTransfer({
        seqno, secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        messages: msgs.map(m => internal({ to: m.to, value: m.value, bounce: true, body: m.body })),
    });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    if (!WALLET_MNEMONIC)  throw new Error("Set WALLET_MNEMONIC in .env");
    if (!FACTORY_ADDRESS)  throw new Error("Set FACTORY_ADDRESS in .env");

    const factoryAddr = Address.parse(FACTORY_ADDRESS);
    const kp          = await mnemonicToPrivateKey(WALLET_MNEMONIC.split(" "));
    const secretKey   = Buffer.from(kp.secretKey);

    let walletAddr: Address;
    let walletInit: { code: Cell; data: Cell };
    let walletV5:   WalletContractV5R1 | undefined;

    if (WALLET_VERSION === "v4") {
        const w    = WalletContractV4.create({ workchain: 0, publicKey: kp.publicKey });
        walletAddr = w.address;
        walletInit = w.init as { code: Cell; data: Cell };
    } else {
        walletV5   = WalletContractV5R1.create({ workchain: 0, publicKey: kp.publicKey, walletId: { networkGlobalId: NETWORK_GLOBAL_ID } });
        walletAddr = walletV5.address;
        walletInit = walletV5.init as { code: Cell; data: Cell };
    }

    console.log(`\n📋  ORBIT Add Plan — ${NETWORK.toUpperCase()}\n`);
    console.log(`Factory      : ${factoryAddr.toString()}`);
    console.log(`Service wallet: ${walletAddr.toString()}`);
    console.log(`\nPlan parameters:`);
    console.log(`  Name    : ${PLAN_NAME}`);
    console.log(`  Price   : ${PLAN_PRICE_TON} TON`);
    console.log(`  Period  : ${PLAN_PERIOD_DAYS} days (${PLAN_PERIOD_SEC}s)`);
    console.log(`  Trial   : ${PLAN_TRIAL_DAYS} days (${PLAN_TRIAL_SEC}s)\n`);

    // Current plan count
    const plansBefore = await getPlanCount(factoryAddr);
    console.log(`Current plans: ${plansBefore}`);

    // Build OP_ADD_PLAN body
    const body = beginCell()
        .storeUint(OP_ADD_PLAN, 32)
        .storeUint(0, 64)                // query_id
        .storeCoins(PLAN_PRICE_NANO)     // price
        .storeUint(PLAN_PERIOD_SEC, 32)  // period
        .storeUint(PLAN_TRIAL_SEC, 32)   // trial_period
        .storeUint(PLAN_NAME_HASH, 256)  // name_hash
    .endCell();

    const seqno = await getSeqno(walletAddr);
    const txBody = WALLET_VERSION === "v4"
        ? buildV4Body(seqno, secretKey, [{ to: factoryAddr, value: toNano("0.05"), body }])
        : buildV5Body(walletV5!, seqno, secretKey, [{ to: factoryAddr, value: toNano("0.05"), body }]);

    const extMsg = external({ to: walletAddr, init: seqno === 0 ? walletInit : undefined, body: txBody });
    const boc    = beginCell().store(storeMessage(extMsg)).endCell().toBoc().toString("base64");

    console.log("Sending OP_ADD_PLAN…");
    await sendBoc(boc);
    await waitTx(seqno + 1, walletAddr);

    const plansAfter = await getPlanCount(factoryAddr);
    const newPlanId  = plansAfter - 1;

    console.log("\n╔══════════════════════════════════════════════════════╗");
    console.log("║              Plan Added Successfully ✅               ║");
    console.log("╠══════════════════════════════════════════════════════╣");
    console.log(`║  Plan ID   : ${newPlanId}`);
    console.log(`║  Name      : ${PLAN_NAME}`);
    console.log(`║  Price     : ${PLAN_PRICE_TON} TON / ${PLAN_PERIOD_DAYS} days`);
    console.log(`║  Trial     : ${PLAN_TRIAL_DAYS} days`);
    console.log(`║  Factory   : ${factoryAddr.toString()}`);
    console.log("╚══════════════════════════════════════════════════════╝\n");
}

main().catch(err => {
    console.error("\n❌ Failed:", err.message);
    process.exit(1);
});
