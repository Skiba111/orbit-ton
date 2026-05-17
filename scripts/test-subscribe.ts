/**
 * ORBIT — Test subscription script.
 *
 * Sends OP_SUBSCRIBE to a Factory to create a test subscription.
 * Use this to verify the full charge → webhook flow end-to-end.
 *
 * Usage:
 *   ts-node scripts/test-subscribe.ts
 *
 * Required env vars (.env):
 *   WALLET_MNEMONIC   — subscriber wallet (pays the subscription)
 *   FACTORY_ADDRESS   — Factory contract address
 *   TONCENTER_API_KEY — TonCenter API key
 *   NETWORK           — testnet | mainnet
 *   WALLET_VERSION    — v4 | v5 (default: v5)
 *
 * Optional:
 *   PLAN_ID           — plan index to subscribe to (default: 0)
 *   DEPOSIT_TON       — TON to deposit (default: price + 0.5 TON buffer)
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
    beginCell, Address, toNano, fromNano, Cell,
    storeMessage, storeMessageRelaxed, internal, external, SendMode,
} from "@ton/core";
import { WalletContractV4, WalletContractV5R1 } from "@ton/ton";

// ── Config ────────────────────────────────────────────────────────────────────

const NETWORK           = process.env.NETWORK          ?? "testnet";
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY ?? "";
const WALLET_MNEMONIC   = process.env.WALLET_MNEMONIC   ?? process.env.MNEMONICS ?? "";
const FACTORY_ADDRESS   = process.env.FACTORY_ADDRESS   ?? "";
const WALLET_VERSION    = (process.env.WALLET_VERSION   ?? "v5").toLowerCase();
const PLAN_ID           = parseInt(process.env.PLAN_ID  ?? "0");

const NETWORK_GLOBAL_ID = NETWORK === "mainnet" ? -239 : -3;
const PAYMENT_TON       = 1;

const API_BASE = NETWORK === "mainnet"
    ? "https://toncenter.com/api/v2"
    : "https://testnet.toncenter.com/api/v2";

const HTTP_HEADERS: Record<string, string> = { "Content-Type": "application/json" };
if (TONCENTER_API_KEY) HTTP_HEADERS["X-API-KEY"] = TONCENTER_API_KEY;

const OP_SUBSCRIBE = 0x4F520001;

// Constants from contracts (must match storage-layout.tolk / factory.tolk)
const STORAGE_RESERVE    = toNano("0.05");
const FACTORY_DEPLOY_GAS = toNano("0.05");

// ── TonCenter helpers ─────────────────────────────────────────────────────────

async function getSeqno(addr: Address): Promise<number> {
    const res  = await fetch(`${API_BASE}/runGetMethod`, {
        method: "POST", headers: HTTP_HEADERS,
        body: JSON.stringify({ address: addr.toString(), method: "seqno", stack: [] }),
    });
    const json = await res.json() as { ok: boolean; result?: { stack: [string,string][]; exit_code: number } };
    if (!json.ok || !json.result || json.result.exit_code !== 0) return 0;
    return parseInt(json.result.stack?.[0]?.[1] ?? "0", 16);
}

async function sendBoc(boc: string): Promise<void> {
    const res  = await fetch(`${API_BASE}/sendBoc`, {
        method: "POST", headers: HTTP_HEADERS,
        body: JSON.stringify({ boc }),
    });
    const json = await res.json() as { ok: boolean; error?: string };
    if (!json.ok) throw new Error(`sendBoc failed: ${json.error ?? JSON.stringify(json)}`);
}

async function getPlanData(factoryAddr: Address, planId: number): Promise<{ price: bigint; period: number; trial: number }> {
    const res  = await fetch(`${API_BASE}/runGetMethod`, {
        method: "POST", headers: HTTP_HEADERS,
        body: JSON.stringify({
            address: factoryAddr.toString(),
            method: "get_plan_data",
            stack: [["num", planId.toString()]],
        }),
    });
    const json = await res.json() as { ok: boolean; result?: { stack: [string,string][]; exit_code: number } };
    if (!json.ok || !json.result || json.result.exit_code !== 0) throw new Error(`Plan ${planId} not found`);
    const stack = json.result.stack;
    return {
        price:  BigInt(stack[0][1]),
        period: parseInt(stack[1][1], 16),
        trial:  parseInt(stack[2][1], 16),
    };
}

async function waitTx(expectedSeqno: number, walletAddr: Address, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    process.stdout.write("  Waiting for tx");
    while (Date.now() < deadline) {
        if (await getSeqno(walletAddr) >= expectedSeqno) { console.log(" ✅"); return; }
        await new Promise(r => setTimeout(r, 3_000));
        process.stdout.write(".");
    }
    throw new Error("\nTimeout");
}

// Find the subscription address by scanning the Factory's latest outgoing transactions.
// The Factory always sends the full deposit to the newly deployed subscription contract —
// the most recent large outgoing tx (value >= depositTon * 0.9) is the new subscription.
async function waitSubscription(factoryAddr: Address, _subscriberAddr: Address, depositTon: bigint, timeoutMs = 60_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    const minValue = depositTon * 9n / 10n; // 90% of deposit (Factory keeps ~0.05 TON for gas)

    process.stdout.write("  Waiting for subscription contract");
    while (Date.now() < deadline) {
        try {
            const res  = await fetch(`${API_BASE}/getTransactions?address=${factoryAddr.toString()}&limit=5`, { headers: HTTP_HEADERS });
            const json = await res.json() as { ok: boolean; result?: { out_msgs?: { destination: string; value: string }[] }[] };
            if (json.ok && json.result?.length) {
                for (const tx of json.result) {
                    for (const msg of (tx.out_msgs ?? [])) {
                        if (msg.destination && BigInt(msg.value ?? "0") >= minValue) {
                            console.log(" ✅");
                            return msg.destination;
                        }
                    }
                }
            }
        } catch { /* keep waiting */ }
        await new Promise(r => setTimeout(r, 3_000));
        process.stdout.write(".");
    }
    throw new Error("\nTimeout — subscription not found");
}

// ── Message helpers ───────────────────────────────────────────────────────────

const WALLET_V4_ID = 698983191;

function buildV4Body(seqno: number, secretKey: Buffer, to: Address, value: bigint, body: Cell): Cell {
    const msgCell = beginCell().store(storeMessageRelaxed(internal({ to, value, bounce: true, body }))).endCell();
    const inner   = beginCell()
        .storeUint(WALLET_V4_ID, 32)
        .storeUint(Math.floor(Date.now() / 1000) + 60, 32)
        .storeUint(seqno, 32)
        .storeUint(0, 8)
        .storeUint(SendMode.PAY_GAS_SEPARATELY, 8)
        .storeRef(msgCell)
    .endCell();
    return beginCell().storeBuffer(sign(inner.hash(), secretKey)).storeSlice(inner.beginParse()).endCell();
}

function buildV5Body(wallet: WalletContractV5R1, seqno: number, secretKey: Buffer, to: Address, value: bigint, body: Cell): Cell {
    return wallet.createTransfer({
        seqno, secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        messages: [internal({ to, value, bounce: true, body })],
    });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    if (!WALLET_MNEMONIC) throw new Error("Set WALLET_MNEMONIC in .env");
    if (!FACTORY_ADDRESS) throw new Error("Set FACTORY_ADDRESS in .env");

    const factoryAddr = Address.parse(FACTORY_ADDRESS);
    const kp          = await mnemonicToPrivateKey(WALLET_MNEMONIC.split(" "));
    const secretKey   = Buffer.from(kp.secretKey);

    let walletAddr: Address;
    let walletInit: { code: Cell; data: Cell };
    let walletV5:   WalletContractV5R1 | undefined;

    if (WALLET_VERSION === "v4") {
        const w  = WalletContractV4.create({ workchain: 0, publicKey: kp.publicKey });
        walletAddr = w.address;
        walletInit = w.init as { code: Cell; data: Cell };
    } else {
        walletV5   = WalletContractV5R1.create({ workchain: 0, publicKey: kp.publicKey, walletId: { networkGlobalId: NETWORK_GLOBAL_ID } });
        walletAddr = walletV5.address;
        walletInit = walletV5.init as { code: Cell; data: Cell };
    }

    console.log(`\n🧪  ORBIT Test Subscribe — ${NETWORK.toUpperCase()}\n`);
    console.log(`Factory    : ${factoryAddr.toString()}`);
    console.log(`Subscriber : ${walletAddr.toString()}`);
    console.log(`Plan ID    : ${PLAN_ID}\n`);

    // Fetch plan data
    const plan = await getPlanData(factoryAddr, PLAN_ID);
    const depositTon = process.env.DEPOSIT_TON
        ? toNano(process.env.DEPOSIT_TON)
        : plan.price + STORAGE_RESERVE + FACTORY_DEPLOY_GAS + toNano("0.5"); // price + buffer

    console.log(`Plan price  : ${fromNano(plan.price)} TON`);
    console.log(`Plan period : ${plan.period / 86400} days`);
    console.log(`Trial       : ${plan.trial / 86400} days`);
    console.log(`Deposit     : ${fromNano(depositTon)} TON\n`);

    // Build OP_SUBSCRIBE
    const body = beginCell()
        .storeUint(OP_SUBSCRIBE, 32)
        .storeUint(0, 64)           // query_id
        .storeUint(PLAN_ID, 32)     // plan_id
        .storeUint(PAYMENT_TON, 2)  // payment_type = TON
    .endCell();

    const seqno  = await getSeqno(walletAddr);
    const txBody = WALLET_VERSION === "v4"
        ? buildV4Body(seqno, secretKey, factoryAddr, depositTon, body)
        : buildV5Body(walletV5!, seqno, secretKey, factoryAddr, depositTon, body);

    const extMsg = external({ to: walletAddr, init: seqno === 0 ? walletInit : undefined, body: txBody });
    const boc    = beginCell().store(storeMessage(extMsg)).endCell().toBoc().toString("base64");

    console.log("Sending OP_SUBSCRIBE…");
    await sendBoc(boc);
    await waitTx(seqno + 1, walletAddr);

    console.log("Fetching subscription address…");
    const subAddr = await waitSubscription(factoryAddr, walletAddr, depositTon);

    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║              Subscription Created ✅                          ║");
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log(`║  Subscriber : ${walletAddr.toString()}`);
    console.log(`║  Sub addr   : ${subAddr}`);
    console.log(`║  Plan       : #${PLAN_ID} — ${fromNano(plan.price)} TON / ${plan.period / 86400}d`);
    console.log(`║  Deposit    : ${fromNano(depositTon)} TON`);
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log("║  Relayer will pick up this subscription on next scan         ║");
    console.log("║  Check server logs: pm2 logs relayer                         ║");
    console.log("╚══════════════════════════════════════════════════════════════╝\n");
}

main().catch(err => {
    console.error("\n❌ Failed:", err.message);
    process.exit(1);
});
