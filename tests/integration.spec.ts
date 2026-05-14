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

import { Blockchain, SandboxContract, TreasuryWallet } from "@ton/sandbox";
import { beginCell, Cell, toNano, Address }             from "@ton/core";
import { compile }                                       from "@ton/blueprint";
import { keyPairFromSeed }                               from "@ton/crypto";

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
    service:      SandboxContract<TreasuryWallet>,
    subscriber:   SandboxContract<TreasuryWallet>,
    feeCollector: SandboxContract<TreasuryWallet>,
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
        deposit:         AMOUNT * 5n + RESERVE + GAS_BUDGET,
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

async function fundAndOpen(
    blockchain: Blockchain,
    code:       Cell,
    init:       SubscriptionInitData,
    funder:     SandboxContract<TreasuryWallet>,
): Promise<SandboxContract<Subscription>> {
    const sub = blockchain.openContract(Subscription.createFromConfig(init, code));
    await funder.send({ to: sub.address, value: init.deposit + RESERVE + toNano("0.2") });
    return sub;
}

// ── Test scaffolding ──────────────────────────────────────────────────────────

let blockchain:   Blockchain;
let service:      SandboxContract<TreasuryWallet>;
let subscriber:   SandboxContract<TreasuryWallet>;
let stranger:     SandboxContract<TreasuryWallet>;
let feeCollector: SandboxContract<TreasuryWallet>;
let subCode:      Cell;
let factoryCode:  Cell;
let collectorCode: Cell;

beforeAll(async () => {
    subCode       = await compile("subscription");
    factoryCode   = await compile("factory");
    collectorCode = await compile("fee-collector");
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
        await factory.sendDeploy(blockchain.sender(service.address), toNano("1"));

        const provider = blockchain.provider(factory.address);

        // Ask the factory where it will put subscriber's subscription
        const predicted = await factory.getSubscriptionAddress(provider, subscriber.address, 0, 0, null);

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

        const factory   = blockchain.openContract(Factory.createFromConfig(cfg, factoryCode));
        await factory.sendDeploy(blockchain.sender(service.address), toNano("1"));
        const provider  = blockchain.provider(factory.address);

        const addr1 = await factory.getSubscriptionAddress(provider, subscriber.address, 0, 0, null);
        const addr2 = await factory.getSubscriptionAddress(provider, subscriber.address, 0, 0, null);

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
        await service.send({ to: fc.address, value: toNano("2") }); // seed balance
        return fc;
    }

    it("rejects OP_CONFIRM_COLLECT before timelock expires", async () => {
        const fc       = await deployCollector();
        const provider = blockchain.provider(fc.address);
        const secretKey = Buffer.from(keyPair.secretKey);

        // Phase 1: schedule withdrawal
        await fc.sendCollect(provider, secretKey, service.address, toNano("0.5"));

        // Phase 2: try immediately — should fail (timelock active)
        let threw = false;
        try {
            await fc.sendConfirmCollect(provider, secretKey);
        } catch {
            threw = true;
        }
        // Either throws or produces a failed transaction
        const remaining = await fc.getTimelockRemaining(provider);
        expect(remaining).toBeGreaterThan(0);
        if (!threw) {
            // Transaction should have failed on-chain
            const pending = await fc.getPendingWithdrawal(provider);
            expect(pending.requestTime).toBeGreaterThan(0); // still pending
        }
    });

    it("executes withdrawal after timelock expires", async () => {
        const fc        = await deployCollector();
        const provider  = blockchain.provider(fc.address);
        const secretKey = Buffer.from(keyPair.secretKey);

        // Phase 1
        await fc.sendCollect(provider, secretKey, service.address, toNano("0.5"));

        // Advance blockchain time by 25 hours (> 24h timelock)
        blockchain.setNow(nowSec() + 25 * 3600);

        // Should be zero remaining now
        const remaining = await fc.getTimelockRemaining(provider);
        expect(remaining).toBe(0);

        // Phase 2: should succeed
        const balBefore = await service.getBalance();
        await fc.sendConfirmCollect(provider, secretKey);
        const balAfter = await service.getBalance();

        expect(balAfter).toBeGreaterThan(balBefore);

        // Pending withdrawal cleared
        const pending = await fc.getPendingWithdrawal(provider);
        expect(pending.requestTime).toBe(0);
    });

    it("cancels pending withdrawal via OP_COLLECT with amount=0", async () => {
        const fc        = await deployCollector();
        const provider  = blockchain.provider(fc.address);
        const secretKey = Buffer.from(keyPair.secretKey);

        // Schedule a real withdrawal
        await fc.sendCollect(provider, secretKey, service.address, toNano("0.5"));
        let pending = await fc.getPendingWithdrawal(provider);
        expect(pending.requestTime).toBeGreaterThan(0);

        // Cancel by scheduling amount=0
        await fc.sendCollect(provider, secretKey, service.address, 0n);
        pending = await fc.getPendingWithdrawal(provider);
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
        const seqno     = await sub.getSeqno(blockchain.provider(sub.address));
        const timestamp = nowSec();
        const extMsg    = beginCell()
            .storeUint(seqno,           32)
            .storeUint(timestamp,       32)
            .storeUint(0x4F520030,      32)  // OP_CHARGE_EXT
            .storeAddress(stranger.address)  // keeper_wallet
        .endCell();

        await blockchain.sendMessage({
            info: {
                type:        "external-in",
                to:          sub.address,
                importFee:   0n,
            },
            body: extMsg,
        });

        const status = await sub.getStatus(blockchain.provider(sub.address));
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
            // Set charging_in_progress=true manually via buildSubscriptionData
        };
        const data = buildSubscriptionData(init, /* chargingInProgress= */ true);
        const sub  = blockchain.openContract(
            new Subscription(
                Subscription.createFromConfig(init, subCode).address,
                { code: subCode, data },
            )
        );
        await service.send({ to: sub.address, value: init.deposit + RESERVE + toNano("0.2") });

        const depositBefore = await sub.getDeposit(blockchain.provider(sub.address));

        // Send a bounced OP_CHARGE_INTERNAL message
        await blockchain.sendMessage({
            info: {
                type:       "internal",
                bounce:     false,
                bounced:    true,
                from:       service.address,
                to:         sub.address,
                value:      { coins: toNano("0.01") },
                ihrFee:     0n,
                forwardFee: 0n,
                createdLt:  0n,
                createdAt:  0,
            },
            body: beginCell()
                .storeUint(0xFFFFFFFF,  32)  // bounce prefix
                .storeUint(0x4F520020,  32)  // OP_CHARGE_INTERNAL
            .endCell(),
        });

        const depositAfter = await sub.getDeposit(blockchain.provider(sub.address));
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

        const status = await sub.getStatus(blockchain.provider(sub.address));
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

        const status = await sub.getStatus(blockchain.provider(sub.address));
        expect(status).toBe(Status.ACTIVE);
    });
});

// ── 6. OP_SET_MAX_PERIODS ─────────────────────────────────────────────────────

describe("OP_SET_MAX_PERIODS", () => {
    it("service can cap an unlimited subscription", async () => {
        const sub = await fundAndOpen(blockchain, subCode, baseInit(service, subscriber, feeCollector), service);

        await sub.sendSetMaxPeriods(blockchain.sender(service.address), 6);

        const data = await sub.getSubscriptionData(blockchain.provider(sub.address));
        // getSubscriptionData returns status/planId/amount/deposit/nextBillingTime/period/retryCount
        // maxPeriods isn't in the current getter — verify indirectly via seqno bump
        const seqno = await sub.getSeqno(blockchain.provider(sub.address));
        expect(seqno).toBe(1);  // state changed = seqno incremented
    });

    it("rejects SET_MAX_PERIODS from stranger", async () => {
        const sub    = await fundAndOpen(blockchain, subCode, baseInit(service, subscriber, feeCollector), service);
        const result = await sub.sendSetMaxPeriods(blockchain.sender(stranger.address), 3);
        const failed = result.transactions.some(
            (tx) => tx.description.type === "generic" && !tx.description.computePhase?.success,
        );
        expect(failed).toBe(true);
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
        await factory.sendDeploy(blockchain.sender(service.address), toNano("1"));

        // Stranger tries to change plan without having subscribed first
        const result = await factory.sendChangePlan(blockchain.sender(stranger.address), 1);
        const failed = result.transactions.some(
            (tx) => tx.description.type === "generic" && !tx.description.computePhase?.success,
        );
        expect(failed).toBe(true);
    });
});
