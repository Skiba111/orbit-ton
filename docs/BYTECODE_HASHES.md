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
| **code_hash** (cell hash) | `38ca5fc8e3879a211926192edae425f7079c24f1b9fd1327cd49b31c11b6585f` |
| **boc_sha256** (SHA-256 of serialised BOC) | `6392960bfbaae0fd71ff5b352f82c22e60206f45cb3009e9b392066c136241af` |
| BOC size | 4318 bytes |
| `get_version()` | `1` → `2` (v2 adds Jetton deposit isolation fix) |

## Factory contract (`contracts/factory.tolk`)

| Field | Value |
|-------|-------|
| **code_hash** (cell hash) | `ae3db687280739351be2186c5d2e6d943035ac0124d3e3b2f4e878be8aa4e438` |
| **boc_sha256** (SHA-256 of serialised BOC) | `2938f6df1fb0560a05843105115a9987f2ba6c3aae5ab6651326cbdd9c6214a3` |
| BOC size | 2360 bytes |
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
- These hashes reflect **v0.1.2** with all security fixes applied:
  - `OP_UPDATE_FEE_BPS` removed from Factory (fee_bps immutable)
  - Jetton deposit isolation fix in Subscription (empty-body payment_type guard)
  - `OP_CHANGE_PLAN` minimum msg_value guard in Factory
  - Registry balance guard before Factory deploy
  - `keeper_wallet` addr_none validation in Subscription
  - `split_fee` fee_bps ceiling assert in fee-router

---

*Last updated: 2026-05-16 — ORBIT v0.1.2*
