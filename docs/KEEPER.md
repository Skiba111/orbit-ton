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

## How it works

1. A keeper sends a signed `OP_CHARGE_EXT` external message to a subscription whose `next_billing_time` has passed.
2. The Subscription contract verifies the message (seqno + timestamp freshness).
3. If the subscription is chargeable, the billing cycle runs and the keeper's wallet receives the reward.
4. `next_billing_time` advances by one period, preventing double-charges.

## Using the ORBIT relayer as a keeper

The built-in relayer (`scripts/relayer.ts`) operates in keeper-compatible mode. It discovers subscriptions via factory transaction history and sends charge messages automatically.

```bash
export FACTORY_ADDRESS="EQD..."
export RELAYER_MNEMONIC="word1 word2 ... word24"
export NETWORK=mainnet
export POLL_INTERVAL_MS=60000
ts-node scripts/relayer.ts
```

The relayer's pubkey must match the `relayer_pubkey` stored in each subscription. This is set at factory deploy time and can be rotated per-subscription via `OP_ROTATE_RELAYER` (service owner only).

## Writing a custom keeper

Any external message with this layout will trigger a charge:

```
seqno     (32 bits)   — current subscription seqno (from get_seqno getter)
timestamp (32 bits)   — current unix time (must be within 60 s of on-chain time)
op        (32 bits)   — 0x4F520030 (OP_CHARGE_EXT)
```

No signature is required when `keeper_mode = 1`. The message is accepted from any sender.

```typescript
import { beginCell } from "@ton/core";

const seqno     = await sub.getSeqno();
const timestamp = Math.floor(Date.now() / 1000);

const extMsg = beginCell()
    .storeUint(seqno,      32)
    .storeUint(timestamp,  32)
    .storeUint(0x4F520030, 32)  // OP_CHARGE_EXT
    .storeAddress(myWallet)     // keeper_wallet — reward destination
.endCell();

await client.sendExternalMessage(Subscription.createFromAddress(subAddr), extMsg);
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
- **keeper_mode = 0**: if a subscription was deployed with `keeper_mode = false`, only the relayer's signed external messages are accepted. Unsigned keeper messages will be rejected. Check the `is_keeper_mode` getter before targeting a subscription.

## Checking keeper_mode

```typescript
const isKeeper = await sub.getIsKeeperMode();
if (!isKeeper) {
    // Only relayer can charge this subscription — skip
}
```
