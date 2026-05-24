# Running a Keeper

Keepers are external actors who trigger billing cycles on ORBIT subscriptions and earn a small TON reward per successful charge. No permission or registration is needed — anyone can run a keeper.

## Economics

| Item | Amount |
|------|--------|
| Base reward per charge | 0.01 TON (from subscription deposit) |
| Bonus reward per charge | 0.01 TON (from factory keeper pool, when funded) |
| Max reward per charge | 0.02 TON |
| Gas cost per charge | ~0.005 TON |
| **Net profit per charge** | **~0.005 – 0.015 TON** |

The base reward is always available as long as the subscription has a funded deposit. The bonus reward comes from the factory's keeper pool — service operators can top it up with `OP_FUND_KEEPER_POOL`.

## Two modes: relayer (signed) vs keeper (permissionless)

ORBIT subscriptions support two charge modes. The mode is set at Factory deploy time and applies to every Subscription deployed by that Factory.

| Mode | `keeper_mode` | Who can charge | Message format |
|------|--------------|----------------|----------------|
| **Relayer** | `0` (default) | Only the holder of `relayer_pubkey` | Ed25519 signed — 512-bit sig prefix |
| **Keeper** | `1` | Anyone | Unsigned — just seqno + timestamp + op + wallet |

## How it works

1. A caller sends an `OP_CHARGE_EXT` external message to a Subscription whose `next_billing_time` has passed.
2. The Subscription verifies the message (signature in relayer mode; seqno + timestamp freshness in both modes).
3. If the subscription is chargeable, the billing cycle runs and the charge reward is sent to the relayer/keeper wallet.
4. `next_billing_time` advances by one period, preventing double-charges.

## Using the ORBIT relayer (relayer mode — default)

The built-in relayer (`scripts/relayer.ts`) operates in **signed relayer mode** (`keeper_mode = 0`). It discovers subscriptions via factory transaction history and sends signed charge messages automatically.

```bash
export FACTORY_ADDRESS="EQD..."
export RELAYER_MNEMONIC="word1 word2 ... word24"
export NETWORK=mainnet
export POLL_INTERVAL_MS=60000
ts-node scripts/relayer.ts
```

The relayer's pubkey must match the `relayer_pubkey` stored in each Subscription. This is set at Factory deploy time via `deploy-registry.ts` (the `RELAYER_PUBKEY` env var).

## Writing a custom keeper (keeper mode only)

> **Requires `keeper_mode = 1`.** If the Factory was deployed with `keeper_mode = 0` (the default), unsigned messages are rejected. Check `getIsKeeperMode()` before targeting a subscription.

In keeper mode, any external message with this layout triggers a charge:

**Keeper mode (`keeper_mode = 1`) message layout:**
```
seqno          (32 bits)  — current subscription seqno (from getSeqno getter)
timestamp      (32 bits)  — current unix time (must be within 60 s of on-chain time)
op             (32 bits)  — 0x4F520030 (OP_CHARGE_EXT)
keeper_wallet  (addr)     — MsgAddress of your wallet — reward is sent here
```

**Relayer mode (`keeper_mode = 0`) message layout:**
```
signature      (512 bits) — Ed25519 signature over the remaining slice
seqno          (32 bits)
timestamp      (32 bits)
op             (32 bits)  — 0x4F520030 (OP_CHARGE_EXT)
```

```typescript
// Keeper mode (keeper_mode = 1) — no signature required
import { Address, beginCell } from "@ton/core";
import { TonClient } from "@ton/ton";
import { Subscription } from "../wrappers/Subscription";

const client = new TonClient({
    endpoint: "https://toncenter.com/api/v2/jsonRPC",
    apiKey:   process.env.TONCENTER_API_KEY,
});

const subAddr    = Address.parse("EQD...subscription_address...");
const myWallet   = Address.parse("EQD...your_keeper_wallet...");

const sub        = client.open(Subscription.createFromAddress(subAddr));
const seqno      = await sub.getSeqno();
const timestamp  = Math.floor(Date.now() / 1000);

const extMsg = beginCell()
    .storeUint(seqno,      32)
    .storeUint(timestamp,  32)
    .storeUint(0x4F520030, 32)  // OP_CHARGE_EXT
    .storeAddress(myWallet)     // keeper_wallet — reward is sent here
    .endCell();

await client.sendExternalMessage(sub, extMsg);
```

## When charges fail

A charge will fail (and no reward is paid) if:

- `next_billing_time` has not yet passed
- `status` is PAUSED or CANCELLED
- `deposit < amount + storage_reserve + CHARGE_GAS_BUDGET` (subscription enters GRACE instead)
- The subscription is in the middle of a Jetton transfer (`charging_in_progress = 1`)
- `seqno` or `timestamp` is stale (message older than 60 s)

Failed charges produce a failed transaction with a non-zero exit code. The contract state is unchanged — no seqno increment, no deposit deduction.

## Risks

- **Gas cost with no reward**: if the subscription deposit is exactly at the threshold, the charge may succeed but the reward may not cover gas. Monitor your keeper's balance.
- **Race conditions**: multiple keepers may target the same subscription simultaneously. Only the first one whose transaction is included earns the reward. The others produce failed transactions.
- **keeper_mode = 0**: if a subscription was deployed with `keeper_mode = 0` (the default), only the relayer's signed external messages are accepted. Unsigned keeper messages will be rejected. Check the `getIsKeeperMode()` getter before targeting a subscription.

## Front-running and MEV in open keeper mode

> This section describes a **known, intentional trade-off** in `keeper_mode = 1`. The design is permissionless by design to avoid centralization. Operators who require censorship resistance over execution guarantee should use `keeper_mode = 0` (default).

### What is front-running here?

In `keeper_mode = 1`, the reward destination is the `keeper_wallet` field in the external message body. Because TON external messages are publicly visible in the mempool before inclusion, an adversary can:

1. Observe a pending keeper charge message for subscription `X`.
2. Construct an identical message with **their own wallet address** as `keeper_wallet`.
3. Submit it with a higher-priority transaction (or collude with a validator) to be included first.

The subscription's seqno replay protection ensures only **one** charge succeeds per billing cycle — the adversary's transaction is included first, earns the reward, and the original keeper's transaction fails on the stale `seqno` check.

### Impact

- The subscriber is charged correctly — **funds are never stolen from subscribers**. The billing cycle completes normally.
- Only the **keeper reward** is diverted. The adversary receives the reward instead of the legitimate keeper.
- Service operators are not directly affected; billing still executes on time.

### Mitigations

| Mitigation | How |
|---|---|
| **Use relayer mode** (`keeper_mode = 0`) | The relayer's Ed25519 signature is required; no one can replace the reward wallet without the private key. Default for all Factories deployed via Registry. |
| **Submit charges just-in-time** | Minimize mempool exposure by submitting as close to `next_billing_time` as possible, not earlier. |
| **Run a private RPC endpoint** | Submit external messages directly to a trusted validator node, bypassing the public mempool. |
| **Accept the risk** | If your service has low-value subscriptions, the economic cost of front-running the reward (0.01–0.02 TON per charge) may not justify private infrastructure. |

### Why keeper_mode exists despite this risk

Keeper mode enables **trustless, permissionless billing**: any actor worldwide can ensure a subscription is charged on time without being granted special permissions. This is valuable for:
- Decentralized services where the operator cannot run persistent infrastructure.
- Emergency fallback when the primary relayer is offline.
- Third-party billing networks that want to participate in ORBIT without whitelisting.

**The default (`keeper_mode = 0`) is recommended for production deployments.** Keeper mode should be explicitly opted into by operators who understand the above trade-offs.

## Checking keeper_mode

```typescript
const isKeeper = await sub.getIsKeeperMode();
if (!isKeeper) {
    // Only relayer can charge this subscription — skip
}
```
