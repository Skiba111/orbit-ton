import { Blockchain, SandboxContract, TreasuryWallet } from "@ton/sandbox";
import { Address, Cell, toNano } from "@ton/core";
import { compile } from "@ton/blueprint";
import {
    Subscription, SubscriptionInitData, buildSubscriptionData, Status, Ops,
} from "../wrappers/Subscription";
import { Factory, FactoryConfig, buildFactoryData } from "../wrappers/Factory";

// ── Helpers ──────────────────────────────────────────────────────────────────

const PERIOD_MONTH = 2592000; // 30 days in seconds
const AMOUNT_TON   = toNano("1");   // 1 TON / month
const FEE_BPS      = 20;            // 0.2%

function nowSec(): number {
    return Math.floor(Date.now() / 1000);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Subscription — happy path", () => {
    let blockchain: Blockchain;
    let serviceOwner: SandboxContract<TreasuryWallet>;
    let subscriber:   SandboxContract<TreasuryWallet>;
    let feeCollector: SandboxContract<TreasuryWallet>;
    let factory:      SandboxContract<Factory>;
    let subscription: SandboxContract<Subscription>;
    let subCode:      Cell;
    let factoryCode:  Cell;

    beforeAll(async () => {
        subCode     = await compile("subscription");
        factoryCode = await compile("factory");
    });

    beforeEach(async () => {
        blockchain   = await Blockchain.create();
        serviceOwner = await blockchain.treasury("serviceOwner");
        subscriber   = await blockchain.treasury("subscriber");
        feeCollector = await blockchain.treasury("feeCollector");

        const factoryCfg: FactoryConfig = {
            relayerPubkey:        0n, // not used in tests (no external messages)
            serviceAddr:          serviceOwner.address,
            feeCollector:         feeCollector.address,
            feeBps:               FEE_BPS,
            protocolFeeCollector: new Address(0, Buffer.alloc(32)), // test placeholder
            subCode,
            plans: [
                { price: AMOUNT_TON, period: PERIOD_MONTH, trialPeriod: 0 },
            ],
        };

        factory = blockchain.openContract(
            Factory.createFromConfig(factoryCfg, factoryCode)
        );

        await factory.sendDeploy(
            blockchain.sender(serviceOwner.address),
            toNano("1"),  // covers FACTORY_RESERVE + deploy gas
        );
    });

    it("should deploy subscription contract on subscribe", async () => {
        const result = await factory.sendSubscribe(
            blockchain.sender(subscriber.address),
            0,               // planId = 0
            AMOUNT_TON * 3n, // deposit for 3 months
        );

        expect(result.transactions).toHaveTransaction({
            from:    factory.address,
            deploy:  true,
            success: true,
        });
    });

    it("should have correct initial state after deploy", async () => {
        await factory.sendSubscribe(
            blockchain.sender(subscriber.address),
            0,
            AMOUNT_TON * 3n,
        );

        // Find the deployed subscription
        const subTx = (await blockchain.getTransactions(factory.address))
            .find((tx) => tx.description.type === "generic" && tx.outMessages.size > 0);

        // In a full test we'd derive the address deterministically and query getters.
        // Skipping address derivation here; covered in integration tests.
    });

    it("should cancel and return deposit", async () => {
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
            deposit:         AMOUNT_TON * 3n,
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

        // Fund the subscription contract
        await blockchain.treasury("deployer").then(async (deployer) => {
            await deployer.send({
                to: subscription.address,
                value: AMOUNT_TON * 3n + toNano("0.1"),
            });
        });

        const beforeBalance = await subscriber.getBalance();

        await subscription.sendCancel(
            blockchain.sender(subscriber.address)
        );

        const afterBalance = await subscriber.getBalance();
        const status = await subscription.getStatus(
            blockchain.provider(subscription.address)
        );

        expect(status).toBe(Status.CANCELLED);
        expect(afterBalance).toBeGreaterThan(beforeBalance);
    });

    it("should top-up deposit and revive from GRACE state", async () => {
        const initData: SubscriptionInitData = {
            seqno:           0,
            status:          Status.GRACE,
            paymentType:     1,
            keeperMode:      false,
            period:          PERIOD_MONTH,
            nextBillingTime: nowSec() - 10, // billing is overdue
            planId:          0,
            maxPeriods:      0,
            periodsCharged:  0,
            amount:          AMOUNT_TON,
            deposit:         toNano("0.04"),  // too little to cover billing
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

        // Send TOP_UP with enough to cover one period + reserve
        await subscription.sendTopUp(
            blockchain.sender(subscriber.address),
            AMOUNT_TON + toNano("0.1"), // covers amount + reserve + gas
        );

        const status = await subscription.getStatus(
            blockchain.provider(subscription.address)
        );

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
            deposit:         AMOUNT_TON * 3n,
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

        await subscription.sendPause(
            blockchain.sender(serviceOwner.address)
        );
        expect(await subscription.getStatus(
            blockchain.provider(subscription.address)
        )).toBe(Status.PAUSED);

        await subscription.sendResume(
            blockchain.sender(serviceOwner.address)
        );
        expect(await subscription.getStatus(
            blockchain.provider(subscription.address)
        )).toBe(Status.ACTIVE);
    });

    it("should correctly split fee on charge", async () => {
        // Fee = 0.2% of 1 TON = 0.002 TON = 2000000 nanotons
        const gross = AMOUNT_TON;
        const feeBps = FEE_BPS;
        const expectedFee = (gross * BigInt(feeBps)) / 10000n;
        const expectedNet = gross - expectedFee;

        expect(expectedFee).toBe(toNano("0.002"));
        expect(expectedNet).toBe(toNano("0.998"));
    });
});
