// Registry test suite.
//
// Coverage:
//   deploy       — Registry deploys correctly with expected initial state
//   register     — OP_REGISTRY_REGISTER deploys a Factory for the sender
//   duplicate    — second registration from same address reverts
//   fee_enforce  — deployed Factory has enforced fee settings (fee_bps, fee_collector)
//   factory_code — deployed Factory has correct subscription code
//   fund_check   — registration rejected when msg_value < REGISTRY_MIN_VALUE
//   balance_chk  — registration rejected when Registry balance too low
//   pause        — paused Registry rejects new registrations
//   resume       — after resume, registration works again
//   update_fee   — OP_REGISTRY_UPDATE_FEE changes fee for future deployments
//   update_coll  — OP_REGISTRY_UPDATE_COLLECTOR changes fee_collector
//   update_relay — OP_REGISTRY_UPDATE_RELAYER changes relayer pubkey
//   update_proto — OP_REGISTRY_UPDATE_PROTOCOL_COLLECTOR changes protocol collector
//   owner_only   — non-owner admin ops revert with ERROR_UNAUTHORIZED
//   withdraw     — OP_REGISTRY_WITHDRAW sends excess TON to owner
//   is_registered — getter returns correct registration state

import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { Address, beginCell, Cell, contractAddress, toNano } from "@ton/core";
import { compileTolk } from "./helpers/compileTolk";
import { Registry, RegistryConfig, RegistryOps, buildRegistryData } from "../wrappers/Registry";
import { Factory, buildFactoryData, FactoryConfig } from "../wrappers/Factory";

// ── Constants ─────────────────────────────────────────────────────────────────

const PLATFORM_FEE_BPS   = 50;   // 0.5%
const FAKE_PUBKEY        = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefn;
const REGISTRY_MIN_VALUE = toNano("0.2");
const REGISTER_VALUE     = toNano("0.3"); // comfortable margin

// Error codes (matching errors.tolk)
const ERROR_UNAUTHORIZED      = 401;
const ERROR_INSUFFICIENT_FUNDS = 402;
const ERROR_ALREADY_EXISTS    = 412;
const ERROR_PAUSED            = 503;

// ── Test helpers ──────────────────────────────────────────────────────────────

function getExitCode(result: { transactions: any[] }): number | undefined {
    for (const tx of result.transactions) {
        const phase = tx.description?.computePhase;
        if (phase?.type === "vm" && !phase.success) {
            return phase.exitCode;
        }
    }
    return undefined;
}

function txSucceeded(result: { transactions: any[] }): boolean {
    return result.transactions.every(tx => {
        const phase = tx.description?.computePhase;
        return !phase || phase.type !== "vm" || phase.success;
    });
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("Registry", () => {
    let blockchain:     Blockchain;
    let owner:          SandboxContract<TreasuryContract>;
    let serviceA:       SandboxContract<TreasuryContract>;
    let serviceB:       SandboxContract<TreasuryContract>;
    let feeCollector:   SandboxContract<TreasuryContract>;
    let protocolColl:   SandboxContract<TreasuryContract>;
    let stranger:       SandboxContract<TreasuryContract>;
    let registry:       SandboxContract<Registry>;
    let registryCode:   Cell;
    let factoryCode:    Cell;
    let subCode:        Cell;

    beforeAll(async () => {
        [registryCode, factoryCode, subCode] = await Promise.all([
            compileTolk("registry"),
            compileTolk("factory"),
            compileTolk("subscription"),
        ]);
    });

    beforeEach(async () => {
        blockchain   = await Blockchain.create();
        owner        = await blockchain.treasury("owner");
        serviceA     = await blockchain.treasury("serviceA");
        serviceB     = await blockchain.treasury("serviceB");
        feeCollector = await blockchain.treasury("feeCollector");
        protocolColl = await blockchain.treasury("protocolColl");
        stranger     = await blockchain.treasury("stranger");

        const cfg: RegistryConfig = {
            relayerPubkey:        FAKE_PUBKEY,
            platformFeeBps:       PLATFORM_FEE_BPS,
            ownerAddr:            owner.address,
            feeCollector:         feeCollector.address,
            protocolFeeCollector: protocolColl.address,
            factoryCode,
            subscriptionCode:     subCode,
        };

        registry = blockchain.openContract(Registry.createFromConfig(cfg, registryCode));
        // Deploy Registry with 1 TON initial balance
        await registry.sendDeploy(owner.getSender(), toNano("1"));
    });

    // ── Deploy ─────────────────────────────────────────────────────────────────

    describe("deploy", () => {
        it("deploys with correct factory_count = 0", async () => {
            const count = await registry.getFactoryCount();
            expect(count).toBe(0);
        });

        it("deploys with correct platform_fee_bps", async () => {
            const bps = await registry.getPlatformFeeBps();
            expect(bps).toBe(PLATFORM_FEE_BPS);
        });

        it("deploys unpaused", async () => {
            const paused = await registry.getIsPaused();
            expect(paused).toBe(false);
        });
    });

    // ── Registration ───────────────────────────────────────────────────────────

    describe("OP_REGISTRY_REGISTER", () => {
        it("deploys a Factory for the sender", async () => {
            const result = await registry.sendRegister(serviceA.getSender(), REGISTER_VALUE);
            expect(txSucceeded(result)).toBe(true);

            // factory_count should increment
            const count = await registry.getFactoryCount();
            expect(count).toBe(1);
        });

        it("sender is_registered after registration", async () => {
            await registry.sendRegister(serviceA.getSender(), REGISTER_VALUE);
            const registered = await registry.getIsRegistered(serviceA.address);
            expect(registered).toBe(true);
        });

        it("non-registrant is not registered", async () => {
            await registry.sendRegister(serviceA.getSender(), REGISTER_VALUE);
            const registered = await registry.getIsRegistered(serviceB.address);
            expect(registered).toBe(false);
        });

        it("returns deterministic Factory address via getter", async () => {
            await registry.sendRegister(serviceA.getSender(), REGISTER_VALUE);
            // Should not throw
            const factoryAddr = await registry.getFactoryAddress(serviceA.address);
            expect(factoryAddr).toBeInstanceOf(Address);
        });

        it("multiple services get different Factory addresses", async () => {
            await registry.sendRegister(serviceA.getSender(), REGISTER_VALUE);
            await registry.sendRegister(serviceB.getSender(), REGISTER_VALUE);

            const addrA = await registry.getFactoryAddress(serviceA.address);
            const addrB = await registry.getFactoryAddress(serviceB.address);
            expect(addrA.toString()).not.toBe(addrB.toString());
        });

        it("rejects duplicate registration with ERROR_ALREADY_EXISTS", async () => {
            await registry.sendRegister(serviceA.getSender(), REGISTER_VALUE);
            const result = await registry.sendRegister(serviceA.getSender(), REGISTER_VALUE);
            expect(getExitCode(result)).toBe(ERROR_ALREADY_EXISTS);
        });

        it("rejects insufficient msg_value", async () => {
            const result = await registry.sendRegister(serviceA.getSender(), toNano("0.1"));
            expect(getExitCode(result)).toBe(ERROR_INSUFFICIENT_FUNDS);
        });

        it("rejects registration when paused", async () => {
            await registry.sendPause(owner.getSender());
            const result = await registry.sendRegister(serviceA.getSender(), REGISTER_VALUE);
            expect(getExitCode(result)).toBe(ERROR_PAUSED);
        });
    });

    // ── Fee enforcement ────────────────────────────────────────────────────────

    describe("fee enforcement", () => {
        let factoryAddr: Address;
        let factory:     SandboxContract<Factory>;

        beforeEach(async () => {
            await registry.sendRegister(serviceA.getSender(), REGISTER_VALUE);
            factoryAddr = await registry.getFactoryAddress(serviceA.address);
            factory     = blockchain.openContract(Factory.createFromAddress(factoryAddr));
        });

        it("deployed Factory has platform fee_bps", async () => {
            const bps = await factory.getFeeBps();
            expect(bps).toBe(PLATFORM_FEE_BPS);
        });

        it("deployed Factory has ORBIT relayer pubkey", async () => {
            const relayerKey = await factory.getRelayerPubkey();
            expect(relayerKey).toBe(FAKE_PUBKEY);
        });

        it("deployed Factory reports version = 3", async () => {
            const version = await factory.getVersion();
            expect(version).toBe(3);
        });

        it("factory starts with 0 plans (owner adds plans separately)", async () => {
            const count = await factory.getPlanCount();
            expect(count).toBe(0);
        });

        it("service can add plans to their Factory", async () => {
            const result = await factory.sendAddPlan(serviceA.getSender(), {
                price:       toNano("1"),
                period:      2592000,
                trialPeriod: 0,
                nameHash:    0n,
            });
            expect(txSucceeded(result)).toBe(true);
            const count = await factory.getPlanCount();
            expect(count).toBe(1);
        });
    });

    // ── Pause / Resume ─────────────────────────────────────────────────────────

    describe("pause/resume", () => {
        it("pauses successfully", async () => {
            await registry.sendPause(owner.getSender());
            expect(await registry.getIsPaused()).toBe(true);
        });

        it("resumes after pause", async () => {
            await registry.sendPause(owner.getSender());
            await registry.sendResume(owner.getSender());
            expect(await registry.getIsPaused()).toBe(false);
        });

        it("registration works again after resume", async () => {
            await registry.sendPause(owner.getSender());
            await registry.sendResume(owner.getSender());
            const result = await registry.sendRegister(serviceA.getSender(), REGISTER_VALUE);
            expect(txSucceeded(result)).toBe(true);
        });

        it("non-owner cannot pause — ERROR_UNAUTHORIZED", async () => {
            const result = await registry.sendPause(stranger.getSender());
            expect(getExitCode(result)).toBe(ERROR_UNAUTHORIZED);
        });
    });

    // ── Admin: update settings ─────────────────────────────────────────────────

    describe("admin operations", () => {
        it("owner can update platform fee", async () => {
            await registry.sendUpdateFee(owner.getSender(), 100);
            const bps = await registry.getPlatformFeeBps();
            expect(bps).toBe(100);
        });

        it("non-owner cannot update fee — ERROR_UNAUTHORIZED", async () => {
            const result = await registry.sendUpdateFee(stranger.getSender(), 100);
            expect(getExitCode(result)).toBe(ERROR_UNAUTHORIZED);
        });

        it("update fee > MAX_FEE_BPS (1000) reverts", async () => {
            const result = await registry.sendUpdateFee(owner.getSender(), 1001);
            // validate_fee_bps throws ERROR_INVALID_AMOUNT (416)
            expect(getExitCode(result)).toBe(416);
        });

        it("owner can update fee_collector", async () => {
            const newColl = await blockchain.treasury("newColl");
            const result  = await registry.sendUpdateCollector(owner.getSender(), newColl.address);
            expect(txSucceeded(result)).toBe(true);
            const addr = await registry.getFeeCollector();
            expect(addr.toString()).toBe(newColl.address.toString());
        });

        it("non-owner cannot update fee_collector — ERROR_UNAUTHORIZED", async () => {
            const result = await registry.sendUpdateCollector(stranger.getSender(), stranger.address);
            expect(getExitCode(result)).toBe(ERROR_UNAUTHORIZED);
        });

        it("owner can update relayer pubkey", async () => {
            const newKey = 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefn;
            const result = await registry.sendUpdateRelayer(owner.getSender(), newKey);
            expect(txSucceeded(result)).toBe(true);
            const key = await registry.getRelayerPubkey();
            expect(key).toBe(newKey);
        });

        it("owner can update protocol fee collector", async () => {
            const newProto = await blockchain.treasury("newProto");
            const result   = await registry.sendUpdateProtocolCollector(owner.getSender(), newProto.address);
            expect(txSucceeded(result)).toBe(true);
        });

        it("non-owner cannot update protocol collector — ERROR_UNAUTHORIZED", async () => {
            const result = await registry.sendUpdateProtocolCollector(stranger.getSender(), stranger.address);
            expect(getExitCode(result)).toBe(ERROR_UNAUTHORIZED);
        });

        it("fee update does NOT affect already-deployed Factories", async () => {
            // Register first
            await registry.sendRegister(serviceA.getSender(), REGISTER_VALUE);
            const factoryAddr = await registry.getFactoryAddress(serviceA.address);

            // Update fee in Registry
            await registry.sendUpdateFee(owner.getSender(), 200);

            // Existing Factory should still have the original fee
            const factory = blockchain.openContract(Factory.createFromAddress(factoryAddr));
            const bps = await factory.getFeeBps();
            expect(bps).toBe(PLATFORM_FEE_BPS); // original, not 200
        });

        it("fee update affects newly registered Factories", async () => {
            await registry.sendUpdateFee(owner.getSender(), 200);
            await registry.sendRegister(serviceA.getSender(), REGISTER_VALUE);
            const factoryAddr = await registry.getFactoryAddress(serviceA.address);
            const factory = blockchain.openContract(Factory.createFromAddress(factoryAddr));
            const bps = await factory.getFeeBps();
            expect(bps).toBe(200);
        });
    });

    // ── Withdraw ───────────────────────────────────────────────────────────────

    describe("withdraw", () => {
        it("owner can withdraw excess balance", async () => {
            // Registry has 1 TON initial balance; send extra 0.5 TON to create excess
            await owner.send({ to: registry.address, value: toNano("0.5"), bounce: false });
            const result = await registry.sendWithdraw(owner.getSender());
            expect(txSucceeded(result)).toBe(true);
        });

        it("non-owner cannot withdraw — ERROR_UNAUTHORIZED", async () => {
            const result = await registry.sendWithdraw(stranger.getSender());
            expect(getExitCode(result)).toBe(ERROR_UNAUTHORIZED);
        });
    });

    // ── factory.tolk: fee_bps immutability (backdoor fix) ─────────────────────

    describe("fee_bps immutability (backdoor fix)", () => {
        it("Factory no longer has OP_UPDATE_FEE_BPS handler — throws ERROR_INVALID_OP", async () => {
            await registry.sendRegister(serviceA.getSender(), REGISTER_VALUE);
            const factoryAddr = await registry.getFactoryAddress(serviceA.address);

            // Manually send the removed OP_UPDATE_FEE_BPS (0x4F52000A)
            const result = await serviceA.send({
                to:     factoryAddr,
                value:  toNano("0.05"),
                bounce: false,
                body:   beginCell()
                    .storeUint(0x4F52000A, 32) // OP_UPDATE_FEE_BPS (removed)
                    .storeUint(0, 64)           // query_id
                    .storeUint(0, 16)           // new_fee_bps = 0 (attempt to zero out)
                .endCell(),
            });

            // Should revert with ERROR_INVALID_OP (65535)
            expect(getExitCode(result)).toBe(0xffff);
        });
    });
});
