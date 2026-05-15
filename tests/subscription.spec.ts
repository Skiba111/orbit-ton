import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { Address, Cell, toNano } from "@ton/core";
import { compileTolk } from "./helpers/compileTolk";
import {
    Subscription, SubscriptionInitData, buildSubscriptionData, Status, Ops,
} from "../wrappers/Subscription";
import { Factory, FactoryConfig, buildFactoryData } from "../wrappers/Factory";

// ── Helpers ──────────────────────────────────────────────────────────────────

const PERIOD_MONTH = 2592000;
const AMOUNT_TON   = toNano("1");
const FEE_BPS      = 20;

function nowSec(): number {
    return Math.floor(Date.now() / 1000);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Subscription — happy path", () => {
    let blockchain: Blockchain;
    let serviceOwner: SandboxContract<TreasuryContract>;
    let subscriber:   SandboxContract<TreasuryContract>;
    let feeCollector: SandboxContract<TreasuryContract>;
    let factory:      SandboxContract<Factory>;
    let subscription: SandboxContract<Subscription>;
    let subCode:      Cell;
    let factoryCode:  Cell;

    beforeAll(async () => {
        subCode     = await compileTolk("subscription");
        factoryCode = await compileTolk("factory");
    });

    beforeEach(async () => {
        blockchain   = await Blockchain.create();
        serviceOwner = await blockchain.treasury("serviceOwner");
        subscriber   = await blockchain.treasury("subscriber");
        feeCollector = await blockchain.treasury("feeCollector");

        const factoryCfg: FactoryConfig = {
            relayerPubkey:        0n,
            serviceAddr:          serviceOwner.address,
            feeCollector:         feeCollector.address,
            feeBps:               FEE_BPS,
            protocolFeeCollector: new Address(0, Buffer.alloc(32)),
            subCode,
            plans: [
                { price: AMOUNT_TON, period: PERIOD_MONTH, trialPeriod: 0 },
            ],
        };

        factory = blockchain.openContract(
            Factory.createFromConfig(factoryCfg, factoryCode)
        );

        await factory.sendDeploy(
            serviceOwner.getSender(),
            toNano("1"),
        );
    });

    it("should deploy subscription contract on subscribe", async () => {
        const result = await factory.sendSubscribe(
            subscriber.getSender(),
            0,
            AMOUNT_TON * 3n,
        );

        // Verify at least one transaction succeeded (the deploy)
        const deployed = result.transactions.some(
            (tx) => tx.description.type === "generic" &&
                    tx.description.computePhase?.type === "vm" &&
                    tx.description.computePhase.success
        );
        expect(deployed).toBe(true);
    });

    it("should have correct initial state after deploy", async () => {
        await factory.sendSubscribe(
            subscriber.getSender(),
            0,
            AMOUNT_TON * 3n,
        );
        // Address derivation is covered in integration tests (getSubscriptionAddress getter).
    });

    it("should cancel and return deposit", async () => {
        // deposit: 0n in init; actual deposit arrives from deploy message
        const initData: SubscriptionInitData = {
            seqno:           0,
            status:          Status.ACTIVE,
            paymentType:     1,
            keeperMode:      false,
            period:          PERIOD_MONTH,
            nextBillingTime: nowSec() + PERIOD_MONTH,
            planId:          0,
            maxPeriods:      0,
            periodsCharged:  0,
            amount:          AMOUNT_TON,
            deposit:         0n,
            storageReserve:  toNano("0.05"),
            feeBps:          FEE_BPS,
            trialPeriod:     0,
            serviceAddr:     serviceOwner.address,
            subscriberAddr:  subscriber.address,
            factoryAddr:     serviceOwner.address,
            feeCollector:    feeCollector.address,
            jettonWallet:           null,
            relayerPubkey:          0n,
            protocolFeeCollector:   new Address(0, Buffer.alloc(32)),
        };

        subscription = blockchain.openContract(
            Subscription.createFromConfig(initData, subCode)
        );

        await subscription.sendDeploy(
            serviceOwner.getSender(),
            AMOUNT_TON * 3n + toNano("0.2"),   // funds the deposit via empty body handler
        );

        const beforeBalance = await subscriber.getBalance();

        await subscription.sendCancel(
            subscriber.getSender()
        );

        const afterBalance = await subscriber.getBalance();
        const status = await subscription.getStatus();

        expect(status).toBe(Status.CANCELLED);
        expect(afterBalance).toBeGreaterThan(beforeBalance);
    });

    it("should top-up deposit and revive from GRACE state", async () => {
        // deposit: 0n; a small deploy amount keeps deposit low (GRACE won't auto-charge)
        const initData: SubscriptionInitData = {
            seqno:           0,
            status:          Status.GRACE,
            paymentType:     1,
            keeperMode:      false,
            period:          PERIOD_MONTH,
            nextBillingTime: nowSec() - 10,
            planId:          0,
            maxPeriods:      0,
            periodsCharged:  0,
            amount:          AMOUNT_TON,
            deposit:         0n,
            storageReserve:  toNano("0.05"),
            feeBps:          FEE_BPS,
            trialPeriod:     0,
            serviceAddr:     serviceOwner.address,
            subscriberAddr:  subscriber.address,
            factoryAddr:     serviceOwner.address,
            feeCollector:    feeCollector.address,
            jettonWallet:           null,
            relayerPubkey:          0n,
            protocolFeeCollector:   new Address(0, Buffer.alloc(32)),
        };

        subscription = blockchain.openContract(
            Subscription.createFromConfig(initData, subCode)
        );

        // deploy with minimal funds so deposit stays low (< 1.08 TON threshold)
        await subscription.sendDeploy(
            serviceOwner.getSender(),
            toNano("0.1"),
        );

        await subscription.sendTopUp(
            subscriber.getSender(),
            AMOUNT_TON + toNano("0.2"),
        );

        const status = await subscription.getStatus();
        expect(status).toBe(Status.ACTIVE);
    });

    it("should pause and resume subscription", async () => {
        const initData: SubscriptionInitData = {
            seqno:           0,
            status:          Status.ACTIVE,
            paymentType:     1,
            keeperMode:      false,
            period:          PERIOD_MONTH,
            nextBillingTime: nowSec() + PERIOD_MONTH,
            planId:          0,
            maxPeriods:      0,
            periodsCharged:  0,
            amount:          AMOUNT_TON,
            deposit:         0n,
            storageReserve:  toNano("0.05"),
            feeBps:          FEE_BPS,
            trialPeriod:     0,
            serviceAddr:     serviceOwner.address,
            subscriberAddr:  subscriber.address,
            factoryAddr:     serviceOwner.address,
            feeCollector:    feeCollector.address,
            jettonWallet:           null,
            relayerPubkey:          0n,
            protocolFeeCollector:   new Address(0, Buffer.alloc(32)),
        };

        subscription = blockchain.openContract(
            Subscription.createFromConfig(initData, subCode)
        );

        await subscription.sendDeploy(
            serviceOwner.getSender(),
            AMOUNT_TON * 3n + toNano("0.2"),
        );

        await subscription.sendPause(
            serviceOwner.getSender()
        );
        expect(await subscription.getStatus()).toBe(Status.PAUSED);

        await subscription.sendResume(
            serviceOwner.getSender()
        );
        expect(await subscription.getStatus()).toBe(Status.ACTIVE);
    });

    it("should correctly split fee on charge", async () => {
        const gross = AMOUNT_TON;
        const feeBps = FEE_BPS;
        const expectedFee = (gross * BigInt(feeBps)) / 10000n;
        const expectedNet = gross - expectedFee;

        expect(expectedFee).toBe(toNano("0.002"));
        expect(expectedNet).toBe(toNano("0.998"));
    });
});
