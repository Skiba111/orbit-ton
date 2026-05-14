# ORBIT Protocol — Technical Overview

## The Problem

Web3 services that need recurring revenue face a structural problem: blockchains are designed for one-time transactions, not ongoing relationships. Existing solutions either require the service to pull funds on a schedule (which means maintaining a trusted hot wallet with user authorisation), or ask users to manually renew every period (which kills retention).

On TON specifically, there is no native subscription primitive. Every service that wants recurring payments must build its own billing infrastructure from scratch, introduce its own trust assumptions, and audit its own custom code.

## What ORBIT Does

ORBIT is a smart-contract protocol that turns a deposit into a stream. A subscriber pre-funds a Subscription contract with enough TON (or Jetton tokens) to cover N billing cycles. The contract automatically charges the service each period using a trustless relayer network. Subscribers can top up at any time, change plans, or cancel and get their remaining deposit back — all without trusting the service with their private keys.

The protocol has three participants:

- **Subscriber** — deposits funds once, authorises the billing cycle at subscribe time
- **Service** — receives payments on schedule, cannot pull more than the agreed amount
- **Relayer / Keeper** — off-chain actor that triggers charges and earns a small reward

## Key Design Decisions

### Deposit model over pull authorisation

TON does not have an ERC-20 `approve` equivalent that works well for recurring payments. Instead, ORBIT uses a pre-funded deposit model: the subscriber sends TON (or Jetton) to their personal Subscription contract, which releases funds to the service at the agreed interval. The subscriber can withdraw the remaining deposit at any time by cancelling.

This means: the service never holds the subscriber's keys, the subscriber never signs an open-ended authorisation, and the on-chain logic — not the service — enforces the billing schedule.

### One contract per subscriber per factory

Every subscriber gets their own Subscription contract, deployed deterministically by the Factory. This means:
- State is isolated: one subscriber's cancelled subscription cannot affect others
- Deposits are isolated: a bug in one subscription cannot drain another
- Addresses are predictable: off-chain systems can compute the address before deployment

### Two-tier keeper network

Charges are triggered externally. Any relayer holding the correct Ed25519 key can trigger a charge. Additionally, any address can act as a **keeper**: in keeper mode, no signature is required — instead the keeper provides their wallet address and earns `KEEPER_REWARD` (0.01 TON) from the subscription balance, plus a bonus from the Factory's keeper pool when funded.

This means the service does not need to run its own infrastructure if it opts into keeper mode — the market provides the trigger layer.

### Grace period instead of instant cancellation

When a subscription runs low on deposit, ORBIT does not cancel immediately. Instead it enters a 3-day grace period during which the subscriber can top up and resume without re-subscribing. This significantly reduces churn for transient payment failures (e.g. subscriber forgot to refill their wallet).

### Protocol fee always in TON

Even for Jetton subscriptions, the protocol fee (`fee_bps` × amount) is paid in TON. This keeps FeeCollector simple (single asset), ensures the protocol always has gas to operate, and makes fee accounting deterministic regardless of which Jetton is used.

## Economic Model

| Actor | Earns | Pays |
|---|---|---|
| Protocol operator | `fee_bps` × amount per charge | Deployment gas (one-time) |
| Service | `net_amount` per charge | Nothing (deposit is subscriber's) |
| Subscriber | The service product | Deposit + gas |
| Keeper | 0.01 TON base + up to 0.01 TON bonus per charge | Transaction gas (~0.005 TON) |

The protocol fee is configurable per Factory (0–10%) and is immutable for existing subscriptions once deployed.

## Comparison with Alternatives

| | ORBIT | Manual pull | Single-contract subscription |
|---|---|---|---|
| Subscriber control | Full — cancel any time | Depends on implementation | Partial |
| Service risk | Zero — cannot over-charge | Service holds authorisation | Variable |
| Jetton support | Yes (TEP-74) | Requires separate logic | Rarely |
| Relayer decentralisation | Keeper network optional | Centralised server required | Centralised |
| Code per service | Zero — reuses shared contract | Custom | Custom |
| Audit surface | One codebase, shared | Per-service | Per-service |

## Limitations and Non-Goals

ORBIT does not include:
- On-chain price oracles — plan prices are set by the service and do not adjust for market conditions
- Dispute resolution — if the service does not deliver, ORBIT does not mediate
- Cross-chain — designed for TON only
- Governance — no DAO, no token, no upgrade mechanism for deployed contracts

## Version History

See [CHANGELOG.md](../CHANGELOG.md).
