# ORBIT Official Bytecode Hashes

These hashes identify canonical ORBIT contract bytecode compiled from this repository.

Any integrator can verify they are running official ORBIT code by comparing the on-chain code hash against the values below,
or by checking the `get_version()` getter on a deployed contract.

## How to verify

```bash
npx ts-node scripts/_compute-hashes.ts
```

Compare the output to the values below.  Mismatch = non-official bytecode.

> **Mainnet note:** contracts currently deployed on mainnet were compiled from v0.1.3 source. Their hashes are listed in the [v0.1.3 section](#v013--mainnet-deployed) below. v0.1.4 hashes apply to new deployments from this codebase.

---

## v0.1.4 — current source

### Subscription contract (`contracts/subscription.tolk`)

| Field | Value |
|-------|-------|
| **code_hash** (cell hash) | `da48c1e2f7402f58f0aba75120853b4453607b6a9e96d5fcdd261aeb584ad9c5` |
| **boc_sha256** (SHA-256 of serialised BOC) | `5f88798772cf653323159c4b17a2a5c7776d640caef0ce57bc2c5fd1e93df9d1` |
| BOC size | 4322 bytes |
| `get_version()` | `2` |

### Factory contract (`contracts/factory.tolk`)

| Field | Value |
|-------|-------|
| **code_hash** (cell hash) | `01461f4daf86b96c4e9a8c3242ac9491a4ce8b748d4a17a07c2de4fbbbcb6458` |
| **boc_sha256** (SHA-256 of serialised BOC) | `3c99f86cb59d89a772c106cd98f094639face4caf3155191809a2b4c0b9c6eac` |
| BOC size | 2371 bytes |
| `get_version()` | `2` |

### Registry contract (`contracts/registry.tolk`)

| Field | Value |
|-------|-------|
| **code_hash** (cell hash) | `224160ee981cce74708b14778e93633f3a0c5a51a494cf9b53cffc100a88c87b` |
| **boc_sha256** (SHA-256 of serialised BOC) | `a55fb57b6c97d8e59119696f2f112e8c35c170c6963d483aebddb2b7bfbba940` |
| BOC size | 1388 bytes |
| `get_version()` | `1` |

### FeeCollector contract (`contracts/fee-collector.tolk`)

| Field | Value |
|-------|-------|
| **code_hash** (cell hash) | `75923afb5c38b0aea92713943f275c080e7e4c7e73ee1b2e45dddc1a31758180` |
| **boc_sha256** (SHA-256 of serialised BOC) | `2ac6d2ca60b5c018b2795469c67070dd18124de83228ea4d40714d0554beeece` |
| BOC size | 636 bytes |
| `get_seqno()` | monotonically increasing per withdrawal |

---

## v0.1.3 — mainnet deployed

These are the hashes of contracts currently live on TON mainnet (Registry, FeeCollector, and initial Factory/Subscription deployments). Use these to verify existing on-chain contracts.

### Subscription contract

| Field | Value |
|-------|-------|
| **code_hash** (cell hash) | `d7d77a61c1a8a490bd830006af5f45ea0d49bd0d47f76d4782cd4413f8008a26` |
| **boc_sha256** (SHA-256 of serialised BOC) | `619b86736a1656b04e65f82d0a9d2d985f57a669d128f3ab2e2f4cfd6567a8a2` |
| BOC size | 4322 bytes |
| `get_version()` | `2` |

### Factory contract

| Field | Value |
|-------|-------|
| **code_hash** (cell hash) | `ce8901b421bd4b1e8a6c3c5e4bb618b25ed534add19e4dc55a6ed1174dd17518` |
| **boc_sha256** (SHA-256 of serialised BOC) | `25aba7bdf212533b3b9968901eb96d9b93ed0362b749e2f9be3f3887271b28c4` |
| BOC size | 2371 bytes |
| `get_version()` | `2` |

### Registry contract

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
  - Dead code removed from `trial-logic.tolk` and `time-oracle.tolk`
  - `get_balance_available()` in FeeCollector uses `safe_sub` consistently

---

*Last updated: 2026-05-18 — ORBIT v0.1.4*
