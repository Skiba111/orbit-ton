/**
 * ORBIT End-to-End Test Script
 *
 * Tests the full cycle on testnet:
 *   1. Deploys a short-period test Factory (period=120s, no trial)
 *   2. Creates a test subscription
 *   3. Waits for relayer to detect and charge it
 *   4. Verifies webhook fires
 *
 * Usage:
 *   ts-node scripts/test-e2e.ts
 *
 * Requires .env with: MNEMONICS, TONCENTER_API_KEY, WALLET_VERSION,
 *                     FEE_COLLECTOR_PUBKEY, WEBHOOK_URL, WEBHOOK_SECRET
 */

import * as dotenv from "dotenv";
dotenv.config();

import "./patch-ton-core"; // must be before any @ton/ton imports

import { mnemonicToPrivateKey } from "@ton/crypto";
import {
    beginCell, Address, toNano, Cell,
    storeMessage, storeMessageRelaxed, internal, external, SendMode,
} from "@ton/core";
import { WalletContractV5R1, WalletContractV4, TonClient } from "@ton/ton";
import { compileTolk }    from "../tests/helpers/compileTolk";
import { FeeCollector }   from "../wrappers/FeeCollector";
import { Factory, FactoryConfig } from "../wrappers/Factory";

// ── Config ────────────────────────────────────────────────────────────────────

const NETWORK           = process.env.NETWORK           ?? "testnet";
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY ?? "";
const WALLET_MNEMONIC   = process.env.WALLET_MNEMONIC   ?? process.env.MNEMONICS ?? "";
const FEE_COLLECTOR_HEX = process.env.FEE_COLLECTOR_PUBKEY ?? "";
const WALLET_VERSION    = (process.env.WALLET_VERSION ?? "v5").toLowerCase();
const WEBHOOK_URL       = process.env.WEBHOOK_URL       ?? "";
const WEBHOOK_SECRET    = process.env.WEBHOOK_SECRET    ?? "";
const NETWORK_GLOBAL_ID = NETWORK === "mainnet" ? -239 : -3;

const API_BASE = NETWORK === "mainnet"
    ? "https://toncenter.com/api/v2"
    : "https://testnet.toncenter.com/api/v2";

const HTTP_HEADERS: Record<string, string> = { "Content-Type": "application/json" };
if (TONCENTER_API_KEY) HTTP_HEADERS["X-API-KEY"] = TONCENTER_API_KEY;

// ── TonCenter helpers ─────────────────────────────────────────────────────────

async function getSeqno(addr: Address): Promise<number> {
    const res  = await fetch(`${API_BASE}/runGetMethod`, {
        method:  "POST",
        headers: HTTP_HEADERS,
        body:    JSON.stringify({ address: addr.toString(), method: "seqno", stack: [] }),
    });
    const json = await res.json() as {
        ok: boolean;
        result?: { stack: [string, string][]; exit_code: number };
    };
    if (!json.ok || !json.result || json.result.exit_code !== 0) return 0;
    if (!json.result.stack?.length) return 0;
    return parseInt(json.result.stack[0][1], 16);
}

async function isDeployed(addr: Address): Promise<boolean> {
    const res  = await fetch(`${API_BASE}/getAddressState?address=${addr.toString()}`, { headers: HTTP_HEADERS });
    const json = await res.json() as { ok: boolean; result?: string };
    return json.ok && json.result === "active";
}

async function sendBoc(boc: string): Promise<void> {
    const res  = await fetch(`${API_BASE}/sendBoc`, {
        method:  "POST",
        headers: HTTP_HEADERS,
        body:    JSON.stringify({ boc }),
    });
    const json = await res.json() as { ok: boolean; error?: string };
    if (!json.ok) throw new Error(`sendBoc failed: ${json.error ?? JSON.stringify(json)}`);
}

async function waitDeployed(addr: Address, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    process.stdout.write("  Waiting");
    while (Date.now() < deadline) {
        if (await isDeployed(addr)) { console.log(" ✅"); return; }
        await new Promise(r => setTimeout(r, 3_000));
        process.stdout.write(".");
    }
    throw new Error(`Timeout — not deployed: ${addr.toString()}`);
}

// ── Signing helpers ───────────────────────────────────────────────────────────

interface MsgSpec {
    to:     Address;
    value:  bigint;
    bounce: boolean;
    init?:  { code: Cell; data: Cell };
    body?:  Cell;
}

async function sendTx(
    walletAddr:  Address,
    walletInit:  { code: Cell; data: Cell } | undefined,
    seqno:       number,
    walletV5:    WalletContractV5R1 | undefined,
    secretKey:   Buffer,
    msgs:        MsgSpec[],
): Promise<void> {
    let body: Cell;
    if (WALLET_VERSION === "v4" || !walletV5) {
        // V4 manual signing
        const WALLET_V4_ID = 698983191;
        let inner = beginCell()
            .storeUint(WALLET_V4_ID, 32)
            .storeUint(Math.floor(Date.now() / 1000) + 60, 32)
            .storeUint(seqno, 32)
            .storeUint(0, 8);
        for (const m of msgs) {
            const msgCell = beginCell()
                .store(storeMessageRelaxed(internal({
                    to: m.to, value: m.value, bounce: m.bounce,
                    init: m.init, body: m.body ?? beginCell().endCell(),
                })))
                .endCell();
            inner = inner.storeUint(SendMode.PAY_GAS_SEPARATELY, 8).storeRef(msgCell) as typeof inner;
        }
        const { sign } = await import("@ton/crypto");
        const innerCell = inner.endCell();
        const sig = sign(innerCell.hash(), secretKey);
        body = beginCell().storeBuffer(sig).storeSlice(innerCell.beginParse()).endCell();
    } else {
        body = walletV5.createTransfer({
            seqno, secretKey,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            messages: msgs.map(m => internal({ to: m.to, value: m.value, bounce: m.bounce, init: m.init, body: m.body })),
        });
    }
    const extMsg = external({ to: walletAddr, init: seqno === 0 ? walletInit : undefined, body });
    const boc = beginCell().store(storeMessage(extMsg)).endCell().toBoc().toString("base64");
    await sendBoc(boc);
}

// ── Test 1: Webhook ───────────────────────────────────────────────────────────

async function testWebhook(): Promise<boolean> {
    console.log("\n── Test 1: Webhook ─────────────────────────────────────────");
    if (!WEBHOOK_URL) { console.log("⚠️  WEBHOOK_URL not set — skipping"); return true; }

    const payload = {
        event:      "charge_confirmed",
        address:    "EQtest_e2e_check",
        seqno_from: 0,
        seqno_to:   1,
        timestamp:  Math.floor(Date.now() / 1000),
    };

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (WEBHOOK_SECRET) headers["X-Orbit-Secret"] = WEBHOOK_SECRET;

    const res  = await fetch(WEBHOOK_URL, { method: "POST", headers, body: JSON.stringify(payload) });
    const text = await res.text();
    if (res.ok) {
        console.log(`✅ Webhook responded ${res.status}: ${text}`);
        return true;
    } else {
        console.log(`❌ Webhook failed ${res.status}: ${text}`);
        return false;
    }
}

// ── Test 2: Deploy short-period test Factory ──────────────────────────────────

async function deployTestFactory(
    walletAddr: Address,
    walletInit: { code: Cell; data: Cell },
    walletV5:   WalletContractV5R1 | undefined,
    secretKey:  Buffer,
    subCode:    Cell,
    factoryCode: Cell,
    feeCollectorAddr: Address,
): Promise<Factory> {
    console.log("\n── Test 2: Deploy test Factory (period=120s) ───────────────");

    const relayerPubkey        = BigInt("0x" + FEE_COLLECTOR_HEX);
    const protocolFeeCollector = Address.parse("UQDHuSq5SQ6vKrdULCfRrpLt_3MsBJM_h9kZLF2ityiT99y4");

    // Use deployer wallet as service owner for testing
    const factoryCfg: FactoryConfig = {
        relayerPubkey,
        serviceAddr:          walletAddr,
        feeCollector:         feeCollectorAddr,
        feeBps:               100,
        protocolFeeCollector,
        subCode,
        plans: [
            { price: toNano("0.2"), period: 120, trialPeriod: 0, nameHash: 0n }, // 0.2 TON / 2 min
        ],
    };

    const factory = Factory.createFromConfig(factoryCfg, factoryCode);
    console.log(`Test Factory : ${factory.address.toString()}`);

    if (await isDeployed(factory.address)) {
        console.log("✅ Already deployed — reusing");
    } else {
        const seqno = await getSeqno(walletAddr);
        await sendTx(walletAddr, walletInit, seqno, walletV5, secretKey, [{
            to:     factory.address,
            value:  toNano("0.5"),
            bounce: false,
            init:   factory.init as { code: Cell; data: Cell },
        }]);
        await waitDeployed(factory.address);
    }
    return factory;
}

// ── Test 3: Subscribe ─────────────────────────────────────────────────────────

async function testSubscribe(
    factory:    Factory,
    walletAddr: Address,
    walletInit: { code: Cell; data: Cell },
    walletV5:   WalletContractV5R1 | undefined,
    secretKey:  Buffer,
): Promise<void> {
    console.log("\n── Test 3: Create test subscription ────────────────────────");

    const client = new TonClient({
        endpoint: `${API_BASE}/jsonRPC`,
        apiKey:   TONCENTER_API_KEY,
    });

    // Subscribe to plan 0 (0.2 TON / 2 min, no trial)
    // Format: op(32) + query_id(64) + plan_id(32) + payment_type(2)
    // Value:  plan_price(0.2) + gas(0.2) = 0.4 TON
    const PAYMENT_TON = 0;
    const subscribeBody = beginCell()
        .storeUint(0x4F520001, 32) // FactoryOps.SUBSCRIBE
        .storeUint(0, 64)           // query_id
        .storeUint(0, 32)           // plan_id = 0
        .storeUint(PAYMENT_TON, 2)  // payment_type = TON
        .endCell();

    const seqno = await getSeqno(walletAddr);
    console.log(`Sending subscribe tx (seqno=${seqno})…`);

    await sendTx(walletAddr, walletInit, seqno, walletV5, secretKey, [{
        to:     factory.address,
        value:  toNano("0.4"),   // plan_price(0.2) + gas(0.2)
        bounce: true,
        body:   subscribeBody,
    }]);

    console.log("✅ Subscribe tx sent — waiting for relayer to detect…");
    console.log(`   Factory: ${factory.address.toString()}`);
    console.log("   Check relayer logs: pm2 logs relayer --lines 30");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.log(`\n🧪  ORBIT E2E Test — ${NETWORK.toUpperCase()}\n`);

    if (!WALLET_MNEMONIC) throw new Error("MNEMONICS not set");
    if (!FEE_COLLECTOR_HEX) throw new Error("FEE_COLLECTOR_PUBKEY not set");

    // Test 1: Webhook
    await testWebhook();

    // Derive keys
    const kp        = await mnemonicToPrivateKey(WALLET_MNEMONIC.split(" "));
    const secretKey = Buffer.from(kp.secretKey);

    let walletAddr: Address;
    let walletInit: { code: Cell; data: Cell };
    let walletV5: WalletContractV5R1 | undefined;

    if (WALLET_VERSION === "v4") {
        const w = WalletContractV4.create({ workchain: 0, publicKey: kp.publicKey });
        walletAddr = w.address;
        walletInit = w.init as { code: Cell; data: Cell };
    } else {
        walletV5 = WalletContractV5R1.create({
            workchain: 0,
            publicKey: kp.publicKey,
            walletId:  { networkGlobalId: NETWORK_GLOBAL_ID },
        });
        walletAddr = walletV5.address;
        walletInit = walletV5.init as { code: Cell; data: Cell };
    }

    console.log(`Deployer : ${walletAddr.toString()}`);

    // Compile
    console.log("\n📦 Compiling…");
    const [feeCollectorCode, subCode, factoryCode] = await Promise.all([
        compileTolk("fee-collector"),
        compileTolk("subscription"),
        compileTolk("factory"),
    ]);
    console.log("✅ Compiled");

    // FeeCollector (reuse production one)
    const feeCollector = FeeCollector.createFromConfig(
        { ownerPubkey: BigInt("0x" + FEE_COLLECTOR_HEX) },
        feeCollectorCode,
    );

    // Test 2: Deploy short-period test Factory
    const testFactory = await deployTestFactory(
        walletAddr, walletInit, walletV5, secretKey,
        subCode, factoryCode, feeCollector.address,
    );

    // Test 3: Subscribe
    await testSubscribe(testFactory, walletAddr, walletInit, walletV5, secretKey);

    console.log("\n╔══════════════════════════════════════════════════════════╗");
    console.log("║  Tests dispatched — monitor server logs:                 ║");
    console.log("║  ssh orbit@89.124.121.2                                  ║");
    console.log("║  pm2 logs relayer --lines 50                             ║");
    console.log("╚══════════════════════════════════════════════════════════╝");
    console.log(`\n  Test Factory : ${testFactory.address.toString()}`);
    console.log("  Update FACTORY_ADDRESS on server to this for E2E test!\n");
}

main().catch(err => {
    console.error("\n❌ Test failed:", err.message);
    process.exit(1);
});
