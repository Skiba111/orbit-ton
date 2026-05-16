// Registry Contract — ORBIT platform entry point.
//
// The Registry is the top-level contract of the ORBIT platform.
// Any service developer can register by sending a single transaction;
// the Registry deploys a ready-to-use Factory on their behalf with
// ORBIT's enforced fee settings baked in.
//
// Key property: platform_fee_bps and fee_collector are stored in the
// Registry and copied into every Factory at deploy time.  A service
// operator cannot override them — they are baked into the Factory's
// immutable state at construction.
//
// Storage layout:
//   Root bits:
//     [256] relayer_pubkey    — ORBIT relayer key shared across all Factories
//     [1]   paused            — blocks new registrations when 1
//     [16]  platform_fee_bps  — enforced fee for all deployed Factories (0-1000)
//     [32]  factory_count     — total number of Factories deployed so far
//
//   Ref 0 — addresses (801 bits):
//     owner_addr              (267 bits) — ORBIT operator (controls Registry)
//     fee_collector           (267 bits) — receives platform_fee_bps on every charge
//     protocol_fee_collector  (267 bits) — receives PROTOCOL_FEE_BPS on every charge
//
//   Ref 1 — contract code cells:
//     factory_code_ref  → cell (compiled Factory bytecode)
//     sub_code_ref      → cell (compiled Subscription bytecode)
//
//   services dict (inline, after bits):
//     key:   service_addr.hash() — 256 bits
//     value: factory_addr        — addr_std slice (267 bits)
//     Grows as developers register; maps each service to its Factory.
//
// Operations:
//   OP_REGISTRY_REGISTER         — any wallet: deploy a Factory for sender
//   OP_REGISTRY_UPDATE_FEE       — owner: update platform_fee_bps (future deployments)
//   OP_REGISTRY_UPDATE_COLLECTOR — owner: update fee_collector address
//   OP_REGISTRY_UPDATE_RELAYER   — owner: update relayer_pubkey
//   OP_REGISTRY_PAUSE            — owner: pause new registrations
//   OP_REGISTRY_RESUME           — owner: resume
//   OP_REGISTRY_WITHDRAW         — owner: withdraw excess TON
//
// Gas model:
//   OP_REGISTRY_REGISTER requires at least REGISTRY_MIN_VALUE (0.2 TON):
//     FACTORY_INIT_DEPOSIT (0.15 TON) forwarded to the new Factory for rent
//     REGISTRY_EXEC_GAS   (0.05 TON) covers Registry execution overhead
//   The new Factory receives 0.15 TON and is immediately ready for use.

import "@stdlib/tvm-dicts"
import "../utils/errors.tolk"
import "../utils/ops.tolk"
import "../utils/math-safe.tolk"
import "../access/role-manager.tolk"
import "../access/emergency-pause.tolk"

const REGISTRY_RESERVE:     int = 100000000;  // 0.1 TON — always kept for rent
const REGISTRY_EXEC_GAS:    int = 50000000;   // 0.05 TON — Registry execution + factory deploy overhead
const FACTORY_INIT_DEPOSIT: int = 150000000;  // 0.15 TON — forwarded to new Factory for rent
const REGISTRY_MIN_VALUE:   int = 200000000;  // 0.2 TON  — minimum msg_value to register

// ── Storage ───────────────────────────────────────────────────────────────────

fun load_registry_storage(): (int, int, int, int, slice, slice, slice, cell, cell, dict) {
    var ds: slice = contract.getData().beginParse();

    var relayer_pubkey:   int = ds.loadUint(256);
    var paused:           int = ds.loadUint(1);
    var platform_fee_bps: int = ds.loadUint(16);
    var factory_count:    int = ds.loadUint(32);

    var addr_ref: slice = ds.loadRef().beginParse();
    var owner_addr:              slice = addr_ref.loadAddress() as slice;
    var fee_collector:           slice = addr_ref.loadAddress() as slice;
    var protocol_fee_collector:  slice = addr_ref.loadAddress() as slice;

    var codes_ref: slice = ds.loadRef().beginParse();
    var factory_code:      cell = codes_ref.loadRef();
    var subscription_code: cell = codes_ref.loadRef();

    var services: dict = ds.loadDict();

    return (
        relayer_pubkey, paused, platform_fee_bps, factory_count,
        owner_addr, fee_collector, protocol_fee_collector,
        factory_code, subscription_code, services
    );
}

fun save_registry_storage(
    relayer_pubkey: int, paused: int, platform_fee_bps: int, factory_count: int,
    owner_addr: slice, fee_collector: slice, protocol_fee_collector: slice,
    factory_code: cell, subscription_code: cell, services: dict
) {
    contract.setData(
        beginCell()
            .storeUint(relayer_pubkey,   256)
            .storeUint(paused,             1)
            .storeUint(platform_fee_bps,  16)
            .storeUint(factory_count,     32)
            .storeRef(
                beginCell()
                    .storeSlice(owner_addr)
                    .storeSlice(fee_collector)
                    .storeSlice(protocol_fee_collector)
                .endCell()
            )
            .storeRef(
                beginCell()
                    .storeRef(factory_code)
                    .storeRef(subscription_code)
                .endCell()
            )
            .storeDict(services)
        .endCell()
    );
}

// ── Services dict helpers ─────────────────────────────────────────────────────

// Returns (factory_addr_slice, found).
// factory_addr is addr_none if the service has not yet registered.
fun get_factory_for_service(services: dict, service_hash: int): (slice, int) {
    var (entry, found) = services.uDictGet(256, service_hash);
    if (!found) {
        var none: slice = beginCell().storeUint(0, 2).endCell().beginParse();
        return (none, 0);
    }
    return (entry!, 1);
}

fun set_factory_for_service(services: dict, service_hash: int, factory_addr: slice): dict {
    services.uDictSet(256, service_hash, factory_addr);
    return services;
}

// ── Factory StateInit builder ─────────────────────────────────────────────────
//
// Constructs the Factory's initial state cell exactly as save_factory_storage()
// in factory.tolk would produce it, but with all counters at zero and empty dicts.
// The service_addr (sender) becomes the Factory owner.

fun build_factory_init(
    service_addr:           slice,
    fee_collector:          slice,
    protocol_fee_collector: slice,
    relayer_pubkey:         int,
    platform_fee_bps:       int,
    factory_code:           cell,
    subscription_code:      cell
): cell {
    // Factory data — matches save_factory_storage() layout in factory.tolk:
    //   relayer_pubkey(256) seqno(32) paused(1) plan_count(32) fee_bps(16)
    //   total_charges(64) total_revenue(coins) keeper_pool(coins)
    //   plans_dict subscriber_info_dict sub_code addr_ref
    var factory_data: cell = beginCell()
        .storeUint(relayer_pubkey,  256)
        .storeUint(0,                32)   // seqno = 0
        .storeUint(0,                 1)   // paused = 0
        .storeUint(0,                32)   // plan_count = 0 (service adds plans later)
        .storeUint(platform_fee_bps, 16)   // enforced by Registry
        .storeUint(0,                64)   // total_charges = 0
        .storeCoins(0)                     // total_revenue = 0
        .storeCoins(0)                     // keeper_pool = 0
        .storeUint(0, 1)                   // plans dict — empty (hme_empty$0)
        .storeUint(0, 1)                   // subscriber_info dict — empty
        .storeRef(subscription_code)
        .storeRef(
            beginCell()
                .storeSlice(service_addr)
                .storeSlice(fee_collector)
                .storeSlice(protocol_fee_collector)
            .endCell()
        )
    .endCell();

    // StateInit TL-B: split_depth=0(1b) special=0(1b) code=1(1b) data=1(1b) library=0(1b) = 0b00110 = 6
    return beginCell()
        .storeUint(6, 5)
        .storeRef(factory_code)
        .storeRef(factory_data)
    .endCell();
}

// Derives addr_std (workchain 0) from a StateInit cell hash.
fun registry_compute_addr(state_init: cell): slice {
    return beginCell()
        .storeUint(4, 3)           // addr_std tag: 0b100
        .storeInt(0, 8)            // workchain = 0
        .storeUint(state_init.hash(), 256)
    .endCell().beginParse();
}

// ── Internal message handler ──────────────────────────────────────────────────

fun onInternalMessage(my_balance: int, msg_value: int, in_msg_full: cell, in_msg_body: slice) {
    if (in_msg_body.isEnd()) { return; }   // accept plain TON top-ups

    var cs: slice = in_msg_full.beginParse();
    var flags: int = cs.loadUint(4);
    if (flags & 1) { return; }             // ignore bounced messages

    var sender: slice = cs.loadAddress() as slice;
    var op: int = in_msg_body.loadUint(32);
    in_msg_body.loadUint(64);              // query_id (ignored, for forward compatibility)

    var (
        relayer_pubkey, paused, platform_fee_bps, factory_count,
        owner_addr, fee_collector, protocol_fee_collector,
        factory_code, subscription_code, services
    ) = load_registry_storage();

    // ── OP_REGISTRY_REGISTER ──────────────────────────────────────────────────
    //
    // Deploys a Factory for the sender.  Sender becomes the Factory's service_addr
    // (owner) and can add plans, pause, withdraw via their Factory directly.
    //
    // The Registry enforces:
    //   • fee_collector  = ORBIT's fee_collector (platform fee recipient)
    //   • fee_bps        = platform_fee_bps (e.g. 50 = 0.5%)
    //   • relayer_pubkey = ORBIT's relayer key
    // These cannot be overridden by the service operator.
    //
    // One Factory per sender.  Re-registration reverts with ERROR_ALREADY_EXISTS.
    //
    // Minimum value: 0.2 TON (0.15 forwarded to Factory + 0.05 execution).
    if (op == OP_REGISTRY_REGISTER) {
        require_not_paused(paused);
        assert(msg_value >= REGISTRY_MIN_VALUE, ERROR_INSUFFICIENT_FUNDS);

        var service_hash: int = sender.hash();
        var (_, already_registered) = get_factory_for_service(services, service_hash);
        assert(!already_registered, ERROR_ALREADY_EXISTS);

        var init_state: cell = build_factory_init(
            sender,
            fee_collector,
            protocol_fee_collector,
            relayer_pubkey,
            platform_fee_bps,
            factory_code,
            subscription_code
        );
        var factory_addr: slice = registry_compute_addr(init_state);

        // Deploy the Factory: send FACTORY_INIT_DEPOSIT for its rent reserve
        var deploy_msg: cell = beginCell()
            .storeUint(0x18, 6)               // bounceable internal
            .storeSlice(factory_addr)
            .storeCoins(FACTORY_INIT_DEPOSIT)
            .storeUint(6, 108)                // init_present(1) init_ref(1) no_body(0)
            .storeRef(init_state)
        .endCell();
        sendRawMessage(deploy_msg, 1);        // pay fees from incoming message value

        services = set_factory_for_service(services, service_hash, factory_addr);

        save_registry_storage(
            relayer_pubkey, paused, platform_fee_bps, factory_count + 1,
            owner_addr, fee_collector, protocol_fee_collector,
            factory_code, subscription_code, services
        );
        return;
    }

    // ── OP_REGISTRY_UPDATE_FEE ────────────────────────────────────────────────
    // Updates platform_fee_bps for future Factory deployments.
    // Existing Factories are NOT affected (fee_bps is snapshotted at deploy time).
    if (op == OP_REGISTRY_UPDATE_FEE) {
        require_owner(sender, owner_addr);
        var new_fee_bps: int = in_msg_body.loadUint(16);
        validate_fee_bps(new_fee_bps);
        save_registry_storage(
            relayer_pubkey, paused, new_fee_bps, factory_count,
            owner_addr, fee_collector, protocol_fee_collector,
            factory_code, subscription_code, services
        );
        return;
    }

    // ── OP_REGISTRY_UPDATE_COLLECTOR ─────────────────────────────────────────
    // Updates fee_collector for future Factory deployments.
    // Existing Factories keep their original fee_collector.
    if (op == OP_REGISTRY_UPDATE_COLLECTOR) {
        require_owner(sender, owner_addr);
        var new_collector: slice = in_msg_body.loadAddress() as slice;
        save_registry_storage(
            relayer_pubkey, paused, platform_fee_bps, factory_count,
            owner_addr, new_collector, protocol_fee_collector,
            factory_code, subscription_code, services
        );
        return;
    }

    // ── OP_REGISTRY_UPDATE_RELAYER ────────────────────────────────────────────
    // Updates relayer_pubkey for future Factory deployments.
    // Existing Factories keep their original relayer key.
    if (op == OP_REGISTRY_UPDATE_RELAYER) {
        require_owner(sender, owner_addr);
        var new_relayer: int = in_msg_body.loadUint(256);
        save_registry_storage(
            new_relayer, paused, platform_fee_bps, factory_count,
            owner_addr, fee_collector, protocol_fee_collector,
            factory_code, subscription_code, services
        );
        return;
    }

    // ── OP_REGISTRY_PAUSE / RESUME ────────────────────────────────────────────
    if (op == OP_REGISTRY_PAUSE) {
        require_owner(sender, owner_addr);
        save_registry_storage(
            relayer_pubkey, 1, platform_fee_bps, factory_count,
            owner_addr, fee_collector, protocol_fee_collector,
            factory_code, subscription_code, services
        );
        return;
    }

    if (op == OP_REGISTRY_RESUME) {
        require_owner(sender, owner_addr);
        save_registry_storage(
            relayer_pubkey, 0, platform_fee_bps, factory_count,
            owner_addr, fee_collector, protocol_fee_collector,
            factory_code, subscription_code, services
        );
        return;
    }

    // ── OP_REGISTRY_WITHDRAW ──────────────────────────────────────────────────
    // Withdraws excess TON above REGISTRY_RESERVE to owner_addr.
    if (op == OP_REGISTRY_WITHDRAW) {
        require_owner(sender, owner_addr);
        var balance:   int = contract.getOriginalBalance();
        var available: int = safe_sub(balance, REGISTRY_RESERVE);
        assert(available > 0, ERROR_INSUFFICIENT_FUNDS);

        reserveToncoinsOnBalance(REGISTRY_RESERVE, 0);

        var msg: cell = beginCell()
            .storeUint(0x10, 6)   // non-bounceable
            .storeSlice(owner_addr)
            .storeCoins(0)
            .storeUint(0, 107)
        .endCell();
        sendRawMessage(msg, 128); // send all remaining balance
        return;
    }

    throw ERROR_INVALID_OP;
}

// ── Getters ───────────────────────────────────────────────────────────────────

get fun get_factory_count(): int {
    var (_, _, _, factory_count, _, _, _, _, _, _) = load_registry_storage();
    return factory_count;
}

get fun get_platform_fee_bps(): int {
    var (_, _, platform_fee_bps, _, _, _, _, _, _, _) = load_registry_storage();
    return platform_fee_bps;
}

// Returns the Factory address for a given service address.
// Throws ERROR_NOT_FOUND if the service has not registered yet.
get fun get_factory_address(service_addr: slice): slice {
    var (_, _, _, _, _, _, _, _, _, services) = load_registry_storage();
    var (factory_addr, found) = get_factory_for_service(services, service_addr.hash());
    assert(found, ERROR_NOT_FOUND);
    return factory_addr;
}

get fun get_relayer_pubkey(): int {
    var (relayer_pubkey, _, _, _, _, _, _, _, _, _) = load_registry_storage();
    return relayer_pubkey;
}

get fun is_paused(): int {
    var (_, paused, _, _, _, _, _, _, _, _) = load_registry_storage();
    return paused;
}

get fun get_owner_addr(): slice {
    var (_, _, _, _, owner_addr, _, _, _, _, _) = load_registry_storage();
    return owner_addr;
}

get fun get_fee_collector(): slice {
    var (_, _, _, _, _, fee_collector, _, _, _, _) = load_registry_storage();
    return fee_collector;
}

get fun get_protocol_fee_collector(): slice {
    var (_, _, _, _, _, _, protocol_fee_collector, _, _, _) = load_registry_storage();
    return protocol_fee_collector;
}

// Returns 1 if the given service address has a registered Factory, 0 otherwise.
get fun is_registered(service_addr: slice): int {
    var (_, _, _, _, _, _, _, _, _, services) = load_registry_storage();
    var (_, found) = get_factory_for_service(services, service_addr.hash());
    return found;
}

get fun get_version(): int {
    return 1; // Registry v1
}
