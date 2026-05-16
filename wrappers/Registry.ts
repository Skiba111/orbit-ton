import {
    Address,
    beginCell,
    Cell,
    Contract,
    ContractProvider,
    contractAddress,
    Dictionary,
    Sender,
    SendMode,
    toNano,
} from "@ton/core";

// ── Opcodes ───────────────────────────────────────────────────────────────────

export const RegistryOps = {
    REGISTER:                    0x4F520060,
    UPDATE_FEE:                  0x4F520061,
    UPDATE_COLLECTOR:            0x4F520062,
    UPDATE_RELAYER:              0x4F520063,
    PAUSE:                       0x4F520064,
    RESUME:                      0x4F520065,
    WITHDRAW:                    0x4F520066,
    UPDATE_PROTOCOL_COLLECTOR:   0x4F520067,
    DEREGISTER:                  0x4F520068,
} as const;

// ── Config ────────────────────────────────────────────────────────────────────

export interface RegistryConfig {
    relayerPubkey:          bigint;   // ORBIT relayer Ed25519 public key
    platformFeeBps:         number;   // e.g. 50 = 0.5%; enforced on all Factories
    ownerAddr:              Address;  // ORBIT operator wallet
    feeCollector:           Address;  // receives platformFeeBps on every charge
    protocolFeeCollector:   Address;  // receives PROTOCOL_FEE_BPS (1.5%) on every charge
    factoryCode:            Cell;     // compiled Factory bytecode
    subscriptionCode:       Cell;     // compiled Subscription bytecode
}

// ── Initial data builder ──────────────────────────────────────────────────────
//
// Storage layout (matches registry.tolk load_registry_storage):
//   Root: relayer_pubkey(256) paused(1) platform_fee_bps(16) factory_count(32)
//   Ref0: owner_addr + fee_collector + protocol_fee_collector
//   Ref1: factory_code_ref + sub_code_ref
//   services dict (initially empty — storeBit(false))

export function buildRegistryData(cfg: RegistryConfig): Cell {
    return beginCell()
        .storeUint(cfg.relayerPubkey,    256)
        .storeUint(0,                      1)   // paused = false
        .storeUint(cfg.platformFeeBps,    16)
        .storeUint(0,                     32)   // factory_count = 0
        .storeRef(
            beginCell()
                .storeAddress(cfg.ownerAddr)
                .storeAddress(cfg.feeCollector)
                .storeAddress(cfg.protocolFeeCollector)
            .endCell()
        )
        .storeRef(
            beginCell()
                .storeRef(cfg.factoryCode)
                .storeRef(cfg.subscriptionCode)
            .endCell()
        )
        .storeBit(false)   // services dict — empty (hme_empty$0)
    .endCell();
}

// ── Contract class ────────────────────────────────────────────────────────────

export class Registry implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    // Create an instance with computed address (for deployment)
    static createFromConfig(cfg: RegistryConfig, code: Cell, workchain = 0): Registry {
        const data      = buildRegistryData(cfg);
        const initState = { code, data };
        return new Registry(contractAddress(workchain, initState), initState);
    }

    // Create from an already-known address (for read-only calls)
    static createFromAddress(address: Address): Registry {
        return new Registry(address);
    }

    // ── Deploy ────────────────────────────────────────────────────────────────

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body:     beginCell().endCell(),
        });
    }

    // ── OP_REGISTRY_REGISTER ─────────────────────────────────────────────────
    //
    // Deploys a Factory for the calling wallet.
    // Minimum value: 0.2 TON; recommend sending 0.3 TON for margin.
    //
    // After confirmation, call getFactoryAddress(senderAddr) to get the Factory.

    async sendRegister(
        provider: ContractProvider,
        via:      Sender,
        value:    bigint = toNano("0.3"),
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(RegistryOps.REGISTER, 32)
                .storeUint(0, 64)   // query_id
            .endCell(),
        });
    }

    // ── Admin operations (owner only) ─────────────────────────────────────────

    /** Update platform fee for future Factory deployments (0-1000 bps).
     *  Existing Factories are not affected. */
    async sendUpdateFee(
        provider:   ContractProvider,
        via:        Sender,
        newFeeBps:  number,
        value:      bigint = toNano("0.05"),
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(RegistryOps.UPDATE_FEE, 32)
                .storeUint(0, 64)
                .storeUint(newFeeBps, 16)
            .endCell(),
        });
    }

    /** Update fee collector address for future Factory deployments. */
    async sendUpdateCollector(
        provider:     ContractProvider,
        via:          Sender,
        newCollector: Address,
        value:        bigint = toNano("0.05"),
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(RegistryOps.UPDATE_COLLECTOR, 32)
                .storeUint(0, 64)
                .storeAddress(newCollector)
            .endCell(),
        });
    }

    /** Update relayer pubkey for future Factory deployments. */
    async sendUpdateRelayer(
        provider:        ContractProvider,
        via:             Sender,
        newRelayerPubkey: bigint,
        value:           bigint = toNano("0.05"),
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(RegistryOps.UPDATE_RELAYER, 32)
                .storeUint(0, 64)
                .storeUint(newRelayerPubkey, 256)
            .endCell(),
        });
    }

    /** Pause new registrations (owner only). */
    async sendPause(
        provider: ContractProvider,
        via:      Sender,
        value:    bigint = toNano("0.05"),
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(RegistryOps.PAUSE, 32)
                .storeUint(0, 64)
            .endCell(),
        });
    }

    /** Resume new registrations (owner only). */
    async sendResume(
        provider: ContractProvider,
        via:      Sender,
        value:    bigint = toNano("0.05"),
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(RegistryOps.RESUME, 32)
                .storeUint(0, 64)
            .endCell(),
        });
    }

    /** Rotate protocol_fee_collector for future Factory deployments (owner only). */
    async sendUpdateProtocolCollector(
        provider:     ContractProvider,
        via:          Sender,
        newCollector: Address,
        value:        bigint = toNano("0.05"),
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(RegistryOps.UPDATE_PROTOCOL_COLLECTOR, 32)
                .storeUint(0, 64)
                .storeAddress(newCollector)
            .endCell(),
        });
    }

    /** Emergency: remove a stale service entry (owner only).
     *  Use when a Factory deploy bounced, leaving a registered-but-missing Factory.
     *  After deregistration the service can re-register normally. */
    async sendDeregister(
        provider:    ContractProvider,
        via:         Sender,
        serviceAddr: Address,
        value:       bigint = toNano("0.05"),
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(RegistryOps.DEREGISTER, 32)
                .storeUint(0, 64)
                .storeAddress(serviceAddr)
            .endCell(),
        });
    }

    /** Withdraw excess TON to owner address (owner only). */
    async sendWithdraw(
        provider: ContractProvider,
        via:      Sender,
        value:    bigint = toNano("0.05"),
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(RegistryOps.WITHDRAW, 32)
                .storeUint(0, 64)
            .endCell(),
        });
    }

    // ── Getters ───────────────────────────────────────────────────────────────

    /** Total number of Factories deployed through this Registry. */
    async getFactoryCount(provider: ContractProvider): Promise<number> {
        const result = await provider.get("get_factory_count", []);
        return Number(result.stack.readBigNumber());
    }

    /** Current platform fee in basis points (e.g. 50 = 0.5%). */
    async getPlatformFeeBps(provider: ContractProvider): Promise<number> {
        const result = await provider.get("get_platform_fee_bps", []);
        return Number(result.stack.readBigNumber());
    }

    /** Returns the Factory address for a given service operator wallet.
     *  Throws if the service has not registered yet. */
    async getFactoryAddress(
        provider:    ContractProvider,
        serviceAddr: Address,
    ): Promise<Address> {
        const result = await provider.get("get_factory_address", [
            {
                type: "slice",
                cell: beginCell().storeAddress(serviceAddr).endCell(),
            },
        ]);
        return result.stack.readAddress();
    }

    /** ORBIT relayer public key stored in this Registry. */
    async getRelayerPubkey(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get("get_relayer_pubkey", []);
        return result.stack.readBigNumber();
    }

    /** Returns true when new registrations are paused. */
    async getIsPaused(provider: ContractProvider): Promise<boolean> {
        const result = await provider.get("is_paused", []);
        return Number(result.stack.readBigNumber()) !== 0;
    }

    /** Returns true if the given service address has already registered. */
    async getIsRegistered(
        provider:    ContractProvider,
        serviceAddr: Address,
    ): Promise<boolean> {
        const result = await provider.get("is_registered", [
            {
                type: "slice",
                cell: beginCell().storeAddress(serviceAddr).endCell(),
            },
        ]);
        return Number(result.stack.readBigNumber()) !== 0;
    }

    async getOwnerAddr(provider: ContractProvider): Promise<Address> {
        const result = await provider.get("get_owner_addr", []);
        return result.stack.readAddress();
    }

    async getFeeCollector(provider: ContractProvider): Promise<Address> {
        const result = await provider.get("get_fee_collector", []);
        return result.stack.readAddress();
    }

    async getProtocolFeeCollector(provider: ContractProvider): Promise<Address> {
        const result = await provider.get("get_protocol_fee_collector", []);
        return result.stack.readAddress();
    }

    async getVersion(provider: ContractProvider): Promise<number> {
        const result = await provider.get("get_version", []);
        return Number(result.stack.readBigNumber());
    }
}
