# ORBIT Official Bytecode Hashes

These hashes identify the canonical ORBIT v0.1.2 contract bytecode compiled from this repository.

Any integrator can verify they are running official ORBIT code by recompiling from source and comparing hashes,
or by checking the `get_version()` getter on a deployed contract.

## How to verify

```bash
npx ts-node scripts/_compute-hashes.ts
```

Compare the output to the values below.  Mismatch = non-official bytecode.

---

## Subscription contract (`contracts/subscription.tolk`)

| Field | Value |
|-------|-------|
| **code_hash** (cell hash) | `334455420888a262996314f7d37d9752d36b02460817f7ff48fa17ae4fc60e41` |
| **boc_sha256** (SHA-256 of serialised BOC) | `5bd9c30dccde5e2878df1276aa6b3a1fdbc501bc4dffd9717fe94cc77f5793f3` |
| BOC size | 4319 bytes |
| `get_version()` | `2` |

## Factory contract (`contracts/factory.tolk`)

| Field | Value |
|-------|-------|
| **code_hash** (cell hash) | `ff41736ad5a446d9d5153fe29db20142da5e9adfe593f3cb1a26f4ec7acabcda` |
| **boc_sha256** (SHA-256 of serialised BOC) | `e59e41151ff4c78c305dbe09f56e7162de9d9e9c00526405f2ae86423d050dd0` |
| BOC size | 2361 bytes |
| `get_version()` | `2` |

## Registry contract (`contracts/registry.tolk`)

| Field | Value |
|-------|-------|
| **code_hash** (cell hash) | `224160ee981cce74708b14778e93633f3a0c5a51a494cf9b53cffc100a88c87b` |
| **boc_sha256** (SHA-256 of serialised BOC) | `a55fb57b6c97d8e59119696f2f112e8c35c170c6963d483aebddb2b7bfbba940` |
| BOC size | 1388 bytes |
| `get_version()` | `1` |

---

## Important notes

- **code_hash** is the SHA-256 of the raw code cell.  It is what `get_code_hash()` (or `cell.hash()`) returns
  and is the most stable identifier across different BOC serialisation formats.
- **boc_sha256** is the SHA-256 of the canonical BOC produced by `@ton/core`'s `Cell.toBoc()`.
  It is useful for file-level verification but depends on the serialiser version.
- Both hashes above were produced with `optimizationLevel: 2` (the production default).
  Changing the optimisation level will change the hashes.
- These hashes reflect the current codebase with all security fixes applied:
  - `PROTOCOL_FEE_BPS = 150` (1.5%) baked into Subscription and Factory bytecode
  - `OP_UPDATE_FEE_BPS` removed from Factory (fee_bps immutable)
  - Jetton deposit isolation fix in Subscription (empty-body payment_type guard)
  - `OP_CHANGE_PLAN` minimum msg_value guard in Factory
  - Registry balance guard before Factory deploy
  - `keeper_wallet` addr_none validation in Subscription
  - `split_fee` fee_bps ceiling assert in fee-router

---

*Last updated: 2026-05-17 — ORBIT v0.1.2 (PROTOCOL_FEE_BPS = 150)*
