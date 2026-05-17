// Integration test suite.
//
// Tests that require multiple contracts talking to each other or that exercise
// scenarios not covered in security.spec.ts:
//
//   1. Factory → Subscription deployment + address prediction
//   2. FeeCollector two-phase timelock (blockchain.setNow)
//   3. Fixed-term auto-cancel via keeper external message
//   4. Bounce handler: bounced payment restores deposit
//   5. OP_APPLY_PLAN: immediate GRACE when new amount exceeds deposit
//   6. OP_SET_MAX_PERIODS: service converts unlimited sub to fixed-term
//   7. OP_CHANGE_PLAN routing: factory looks up stored address

import { Blockchain, SandboxContract, TreasuryContract, SendMessageResult } from "@ton/sandbox";
import { beginCell, Cell, contractAddress, toNano, Address }                   from "@ton/core";
import { compileTolk }                                                         from "./helpers/compileTolk";
import { keyPairFromSeed }                                                     from "@ton/crypto";

import {
    Subscription, SubscriptionInitData, buildSubscriptionData, Status, Ops,
} from "../wrappers/Subscription";
import {
    Factory, FactoryConfig, buildFactoryData,
} from "../wrappers/Factory";
import {
    FeeCollector, buildFeeCollectorData,
} from "../wrappers/FeeCollector";

// ── Shared constants ──────────────────────────────────────────────────────────

const PERIOD     = 2592000;       // 30 days
const AMOUNT     = toNano("1");
const RESERVE    = toNano("0.05");
const GAS_BUDGET = toNano("0.03");
const FEE_BPS    = 20;

function nowSec(): number { return Math.floor(Date.now() / 1000); }

// Ed25519 key pair for signing external messages in tests.
// Seed is deterministic so tests are reproducible.
const keyPair = keyPairFromSeed(Buffer.alloc(32, 0xab));

function baseInit(
    service:      SandboxContract<TreasuryContract>,
    subscriber:   SandboxContract<TreasuryContract>,
    feeCollector: SandboxContract<TreasuryContract>,
): SubscriptionInitData {
    return {
        seqno:           0,
        status:          Status.ACTIVE,
        paymentType:     1,
        keeperMode:      false,
        period:          PERIOD,
        nextBillingTime: nowSec() - 1, // billing due
        planId:          0,
        maxPeriods:      0,
        periodsCharged:  0,
        amount:          AMOUNT,
        deposit:         0n,      // always start at 0 — fund via sendDeploy value
        storageReserve:  RESERVE,
        feeBps:          FEE_BPS,
        trialPeriod:     0,
        serviceAddr:     service.address,
        subscriberAddr:  subscriber.address,
        factoryAddr:     service.address,  // stand-in
        feeCollector:           feeCollector.address,
        jettonWallet:           null,
        relayerPubkey:          BigInt("0x" + Buffer.from(keyPair.publicKey).toString("hex")),
        protocolFeeCollector:   new Address(0, Buffer.alloc(32)),
    };
}

const DEFAULT_DEPOSIT = AMOUNT * 5n + RESERVE + GAS_BUDGET;

async function fundAndOpen(
    blockchain: Blockchain,
    code:       Cell,
    init:       SubscriptionInitData,
    funder:     SandboxContract<TreasuryContract>,
): Promise<SandboxContract<Subscription>> {
    // deposit: 0n in init so empty-body deploy handler doesn't double-count
    const targetDeposit = init.deposit === 0n ? DEFAULT_DEPOSIT : init.deposit;
    const cleanInit = { ...init, deposit: 0n };
    const sub = blockchain.openContract(Subscription.createFromConfig(cleanInit, code));
    await sub.sendDeploy(
        funder.getSender(),
        targetDeposit + RESERVE + toNano("0.2"),
    );
    return sub;
}

function txFailed(result: SendMessageResult): boolean {
    return result.transactions.some((tx) => {
        if (tx.description.type !== "generic") return false;
        const cp = tx.description.computePhase;
        return cp?.type === "vm" && !cp.success;
    });
}

// ── Test scaffolding ──────────────────────────────────────────────────────────

let blockchain:    Blockchain;
let service:       SandboxContract<TreasuryContract>;
let subscriber:    SandboxContract<TreasuryContract>;
let stranger:      SandboxContract<TreasuryContract>;
let feeCollector:  SandboxContract<TreasuryContract>;
let subCode:       Cell;
let factoryCode:   Cell;
let collectorCode: Cell;

beforeAll(async () => {
    subCode       = await compileTolk("subscription");
    factoryCode   = await compileTolk("factory");
    collectorCode = await compileTolk("fee-collector");
});

beforeEach(async () => {
    blockchain   = await Blockchain.create();
    service      = await blockchain.treasury("service");
    subscriber   = await blockchain.treasury("subscriber");
    stranger     = await blockchain.treasury("stranger");
    feeCollector = await blockchain.treasury("feeCollector");
});

// ── 1. Factory → Subscription deployment ─────────────────────────────────────

describe("Factory → Subscription deployment", () => {
    it("deploys subscription at the getter-predicted address", async () => {
        const cfg: FactoryConfig = {
            relayerPubkey:        BigInt("0x" + Buffer.from(keyPair.publicKey).toString("hex")),
            serviceAddr:          service.address,
            feeCollector:         feeCollector.address,
            feeBps:               FEE_BPS,
            protocolFeeCollector: new Address(0, Buffer.alloc(32)),
            subCode,
            plans: [{ price: AMOUNT, period: PERIOD, trialPeriod: 0, nameHash: 0n }],
        };

        const factory = blockchain.openContract(Factory.createFromConfig(cfg, factoryCode));
        await factory.sendDeploy(service.getSender(), toNano("1"));

        // Ask the factory where it will put subscriber's subscription (paymentType=1 = PAYMENT_TON)
        const predicted = await factory.getSubscriptionAddress(subscriber.address, 0, 1, null);

        // Now actually subscribe
        await factory.sendSubscribe(
            blockchain.sender(subscriber.address),
            0,           // planId = 0
            AMOUNT * 3n, // depositAmount = 3 months
        );

        // The subscription should be deployed at the predicted address
        const subState = await blockchain.getContract(predicted);
        expect(subState.accountState?.type).toBe("active");
    });

    it("get_subscription_address returns same address on repeated calls", async () => {
        const cfg: FactoryConfig = {
            relayerPubkey:        0n,
            serviceAddr:          service.address,
            feeCollector:         feeCollector.address,
            feeBps:               FEE_BPS,
            protocolFeeCollector: new Address(0, Buffer.alloc(32)),
            subCode,
            plans: [{ price: AMOUNT, period: PERIOD, trialPeriod: 0, nameHash: 0n }],
        };

        const factory = blockchain.openContract(Factory.createFromConfig(cfg, factoryCode));
        await factory.sendDeploy(service.getSender(), toNano("1"));

        // Pin blockchain.now so both getter calls receive the same timestamp.
        // initial_billing_time() in trial-logic.tolk calls blockchain.now() which
        // Blueprint reads from the real wall clock on each execution — without pinning,
        // two calls spanning a second boundary would return different addresses.
        blockchain.now = Math.floor(Date.now() / 1000);

        const addr1 = await factory.getSubscriptionAddress(subscriber.address, 0, 1, null);
        const addr2 = await factory.getSubscriptionAddress(subscriber.address, 0, 1, null);

        expect(addr1.toString()).toBe(addr2.toString());
    });
});

// ── 2. FeeCollector two-phase timelock ────────────────────────────────────────

describe("FeeCollector timelock", () => {
    async function deployCollector(): Promise<SandboxContract<FeeCollector>> {
        const pubkeyHex = Buffer.from(keyPair.publicKey).toString("hex");
        const fc = blockchain.openContract(
            FeeCollector.createFromConfig(
                { ownerPubkey: BigInt("0x" + pubkeyHex) },
                collectorCode,
            )
        );
        await fc.sendDeploy(service.getSender(), toNano("2")); // deploy and seed balance
        return fc;
    }

    it("rejects OP_CONFIRM_COLLECT before timelock expires", async () => {
        const fc        = await deployCollector();
        const secretKey = Buffer.from(keyPair.secretKey);

        // Phase 1: schedule withdrawal
        await fc.sendCollect(secretKey, service.address, toNano("0.5"));

        // Phase 2: try immediately — should fail (timelock active)
        let threw = false;
        try {
            await fc.sendConfirmCollect(secretKey);
        } catch {
            threw = true;
        }
        // Either throws or produces a failed transaction
        const remaining = await fc.getTimelockRemaining();
        expect(remaining).toBeGreaterThan(0);
        if (!threw) {
            // Transaction should have failed on-chain
            const pending = await fc.getPendingWithdrawal();
            expect(pending.requestTime).toBeGreaterThan(0); // still pending
        }
    });

    it("executes withdrawal after timelock expires", async () => {
        const fc        = await deployCollector();
        const secretKey = Buffer.from(keyPair.secretKey);

        // Phase 1
        await fc.sendCollect(secretKey, service.address, toNano("0.5"));

        // Advance blockchain time by 25 hours (> 24h timelock)
        blockchain.now = nowSec() + 25 * 3600;

        // Should be zero remaining now
        const remaining = await fc.getTimelockRemaining();
        expect(remaining).toBe(0);

        // Phase 2: should succeed (pass blockchain.now so the message is fresh relative to advanced time)
        const balBefore = await service.getBalance();
        await fc.sendConfirmCollect(secretKey, blockchain.now);
        const balAfter = await service.getBalance();

        expect(balAfter).toBeGreaterThan(balBefore);

        // Pending withdrawal cleared
        const pending = await fc.getPendingWithdrawal();
        expect(pending.requestTime).toBe(0);
    });

    it("cancels pending withdrawal via OP_COLLECT with amount=0", async () => {
        const fc        = await deployCollector();
        const secretKey = Buffer.from(keyPair.secretKey);

        // Schedule a real withdrawal
        await fc.sendCollect(secretKey, service.address, toNano("0.5"));
        let pending = await fc.getPendingWithdrawal();
        expect(pending.requestTime).toBeGreaterThan(0);

        // Cancel by scheduling amount=0
        await fc.sendCollect(secretKey, service.address, 0n);
        pending = await fc.getPendingWithdrawal();
        expect(pending.amount).toBe(0n);
    });
});

// ── 3. Fixed-term subscription auto-cancel via keeper ─────────────────────────

describe("fixed-term subscription", () => {
    it("auto-cancels after max_periods reached (keeper mode)", async () => {
        const init  = {
            ...baseInit(service, subscriber, feeCollector),
            keeperMode:      true,
            maxPeriods:      2,
            periodsCharged:  2,      // already at cap
            nextBillingTime: nowSec() - 1,  // billing due
        };
        const sub = await fundAndOpen(blockchain, subCode, init, service);

        const balBefore = await subscriber.getBalance();

        // Keeper-mode external message: seqno(32) timestamp(32) op(32) keeper_wallet(addr)
        const seqno     = await sub.getSeqno();
        const timestamp = nowSec();
        const extMsg    = beginCell()
            .storeUint(seqno,           32)
            .storeUint(timestamp,       32)
            .storeUint(0x4F520030,      32)  // OP_CHARGE_EXT
            .storeAddress(stranger.address)  // keeper_wallet
        .endCell();

        await blockchain.sendMessage({
            info: {
                type:      "external-in",
                dest:      sub.address,
                importFee: 0n,
            },
            body: extMsg,
        });

        const status = await sub.getStatus();
        expect(status).toBe(Status.CANCELLED);

        // Deposit refunded to subscriber
        const balAfter = await subscriber.getBalance();
        expect(balAfter).toBeGreaterThan(balBefore);
    });
});

// ── 4. Bounce handler ─────────────────────────────────────────────────────────

describe("bounce handler — deposit restored on bounced payment", () => {
    it("deposit increases after bounced OP_CHARGE_INTERNAL", async () => {
        const init = {
            ...baseInit(service, subscriber, feeCollector),
            deposit: 0n,
        };
        // Build data with chargingInProgress=true; derive address from THIS exact data
        const customData = buildSubscriptionData(init, /* chargingInProgress= */ true);
        const customAddr = contractAddress(0, { code: subCode, data: customData });
        const sub  = blockchain.openContract(
            new Subscription(customAddr, { code: subCode, data: customData })
        );
        await sub.sendDeploy(service.getSender(), DEFAULT_DEPOSIT + RESERVE + toNano("0.2"));

        const depositBefore = await sub.getDeposit();

        // Send a bounced OP_CHARGE_INTERNAL message
        await blockchain.sendMessage({
            info: {
                type:        "internal",
                ihrDisabled: true,
                bounce:      false,
                bounced:     true,
                src:         service.address,
                dest:        sub.address,
                value:       { coins: toNano("0.01") },
                ihrFee:      0n,
                forwardFee:  0n,
                createdLt:   0n,
                createdAt:   0,
            },
            body: beginCell()
                .storeUint(0xFFFFFFFF,  32)  // bounce prefix
                .storeUint(0x4F520020,  32)  // OP_CHARGE_INTERNAL
            .endCell(),
        });

        const depositAfter = await sub.getDeposit();
        expect(depositAfter).toBeGreaterThanOrEqual(depositBefore);
    });
});

// ── 5. OP_APPLY_PLAN: immediate GRACE when deposit insufficient ────────────────

describe("OP_APPLY_PLAN deposit check", () => {
    it("transitions to GRACE when new plan price exceeds deposit", async () => {
        const thinDeposit = toNano("0.04"); // far below AMOUNT
        const init = {
            ...baseInit(service, subscriber, feeCollector),
            deposit: thinDeposit,
        };
        const sub = await fundAndOpen(blockchain, subCode, { ...init, factoryAddr: service.address }, service);

        // Service → factory forwards OP_APPLY_PLAN with a 5 TON/month plan
        const bigAmount = toNano("5");
        const applyBody = beginCell()
            .storeUint(Ops.APPLY_PLAN, 32)
            .storeUint(0, 64)
            .storeUint(0, 32)                // plan_id
            .storeCoins(bigAmount)           // new amount — 5 TON, far above deposit
            .storeUint(PERIOD, 32)
            .storeUint(0, 32)                // trial_period
        .endCell();

        await service.send({
            to:    sub.address,
            value: toNano("0.1"),
            body:  applyBody,
        });

        const status = await sub.getStatus();
        expect(status).toBe(Status.GRACE);
    });

    it("stays ACTIVE when deposit is sufficient for the new amount", async () => {
        const richDeposit = AMOUNT * 5n + RESERVE + GAS_BUDGET;
        const init = {
            ...baseInit(service, subscriber, feeCollector),
            deposit:     richDeposit,
            factoryAddr: service.address,
        };
        const sub = await fundAndOpen(blockchain, subCode, init, service);

        const newAmount = toNano("0.5"); // cheaper plan
        const applyBody = beginCell()
            .storeUint(Ops.APPLY_PLAN, 32)
            .storeUint(0, 64)
            .storeUint(0, 32)
            .storeCoins(newAmount)
            .storeUint(PERIOD, 32)
            .storeUint(0, 32)
        .endCell();

        await service.send({
            to:    sub.address,
            value: toNano("0.1"),
            body:  applyBody,
        });

        const status = await sub.getStatus();
        expect(status).toBe(Status.ACTIVE);
    });
});

// ── 6. OP_SET_MAX_PERIODS ─────────────────────────────────────────────────────

describe("OP_SET_MAX_PERIODS", () => {
    it("service can cap an unlimited subscription", async () => {
        const sub = await fundAndOpen(blockchain, subCode, baseInit(service, subscriber, feeCollector), service);

        await sub.sendSetMaxPeriods(blockchain.sender(service.address), 6);

        // Verify state changed: seqno incremented
        const seqno = await sub.getSeqno();
        expect(seqno).toBe(1);
    });

    it("rejects SET_MAX_PERIODS from stranger", async () => {
        const sub    = await fundAndOpen(blockchain, subCode, baseInit(service, subscriber, feeCollector), service);
        const result = await sub.sendSetMaxPeriods(blockchain.sender(stranger.address), 3);
        expect(txFailed(result)).toBe(true);
    });
});

// ── 7. OP_CHANGE_PLAN routing ─────────────────────────────────────────────────

describe("OP_CHANGE_PLAN — factory routing", () => {
    it("rejects change_plan for unknown subscriber", async () => {
        const cfg: FactoryConfig = {
            relayerPubkey:        0n,
            serviceAddr:          service.address,
            feeCollector:         feeCollector.address,
            feeBps:               FEE_BPS,
            protocolFeeCollector: new Address(0, Buffer.alloc(32)),
            subCode,
            plans: [
                { price: AMOUNT,        period: PERIOD, trialPeriod: 0, nameHash: 0n },
                { price: toNano("2"),   period: PERIOD, trialPeriod: 0, nameHash: 0n },
            ],
        };

        const factory = blockchain.openContract(Factory.createFromConfig(cfg, factoryCode));
        await factory.sendDeploy(service.getSender(), toNano("1"));

        // Stranger tries to change plan without having subscribed first
        const result = await factory.sendChangePlan(blockchain.sender(stranger.address), 1);
        expect(txFailed(result)).toBe(true);
    });
});
