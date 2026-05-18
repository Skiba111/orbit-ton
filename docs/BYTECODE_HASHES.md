# ORBIT Official Bytecode Hashes

These hashes identify the canonical ORBIT v0.1.3 contract bytecode compiled from this repository.

Any integrator can verify they are running official ORBIT code by comparing the on-chain code hash against the values below,
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
| **code_hash** (cell hash) | `d7d77a61c1a8a490bd830006af5f45ea0d49bd0d47f76d4782cd4413f8008a26` |
| **boc_sha256** (SHA-256 of serialised BOC) | `619b86736a1656b04e65f82d0a9d2d985f57a669d128f3ab2e2f4cfd6567a8a2` |
| BOC size | 4322 bytes |
| `get_version()` | `2` |

## Factory contract (`contracts/factory.tolk`)

| Field | Value |
|-------|-------|
| **code_hash** (cell hash) | `ce8901b421bd4b1e8a6c3c5e4bb618b25ed534add19e4dc55a6ed1174dd17518` |
| **boc_sha256** (SHA-256 of serialised BOC) | `25aba7bdf212533b3b9968901eb96d9b93ed0362b749e2f9be3f3887271b28c4` |
| BOC size | 2371 bytes |
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

- **code_hash** is the canonical TON cell hash (SHA-256 of the standard cell representation including depth and refs descriptors), as returned by `cell.hash()` in `@ton/core`. It is the most stable identifier across different BOC serialisation formats.
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
  - `periods_charged` preserved across plan changes (OP_APPLY_PLAN no longer resets to 0)
  - Jetton `subscriber_jetton_wallet` validated non-null at Factory subscribe time
  - `OP_ROTATE_KEY` added to FeeCollector for emergency key rotation

---

*Last updated: 2026-05-17 — ORBIT v0.1.3*
