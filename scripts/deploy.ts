// Deployment script for ORBIT contracts.
//
// Order:
//   1. Deploy FeeCollector (requires your protocol Ed25519 key)
//   2. Deploy Factory (requires service address + fee_collector address)
//
// Usage:
//   npx blueprint run deploy
//
// Environment variables:
//   MNEMONICS          — space-separated wallet seed phrase
//   FEE_COLLECTOR_PUBKEY — hex Ed25519 public key for fee withdrawal
//   TONCENTER_API_KEY  — optional; use mainnet key for production

import { NetworkProvider } from "@ton/blueprint";
import { Address, toNano } from "@ton/core";
import { compile } from "@ton/blueprint";
import { FeeCollector, buildFeeCollectorData } from "../wrappers/FeeCollector";
import { Factory, FactoryConfig, buildFactoryData } from "../wrappers/Factory";

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();

    // ── Step 1: Deploy FeeCollector ───────────────────────────────────────────
    ui.write("Deploying FeeCollector...");

    const feeCollectorPubkeyHex = process.env.FEE_COLLECTOR_PUBKEY ?? "";
    if (!feeCollectorPubkeyHex) {
        throw new Error("Set FEE_COLLECTOR_PUBKEY environment variable");
    }
    const feeCollectorPubkey = BigInt("0x" + feeCollectorPubkeyHex);

    const feeCollectorCode = await compile("fee-collector");
    const feeCollector = provider.open(
        FeeCollector.createFromConfig({ ownerPubkey: feeCollectorPubkey }, feeCollectorCode)
    );

    if (!(await provider.isContractDeployed(feeCollector.address))) {
        await feeCollector.sendDeploy(provider.sender(), toNano("1.0")); // 1 TON for rent
        await provider.waitForDeploy(feeCollector.address);
    }
    ui.write(`FeeCollector deployed at: ${feeCollector.address.toString()}`);

    // ── Step 2: Deploy Factory ────────────────────────────────────────────────
    ui.write("Deploying Factory...");

    const serviceAddr = await ui.inputAddress("Enter service owner address:");
    const subCode     = await compile("subscription");
    const factoryCode = await compile("factory");

    // Ask fee BPS
    const feeBpsStr = await ui.input("Protocol fee in basis points (e.g. 20 = 0.2%):");
    const feeBps = parseInt(feeBpsStr, 10);

    const relayerPubkeyHex = await ui.input("Relayer Ed25519 public key (hex, 64 chars):");
    const relayerPubkey = BigInt("0x" + relayerPubkeyHex);

    const factoryCfg: FactoryConfig = {
        relayerPubkey,
        serviceAddr,
        feeCollector: feeCollector.address,
        feeBps,
        subCode,
        plans: [
            { price: toNano("1"), period: 2592000, trialPeriod: 604800 }, // Plan 0: 1 TON/month, 7d trial
            { price: toNano("5"), period: 2592000, trialPeriod: 0 },       // Plan 1: 5 TON/month, no trial
        ],
    };

    const factory = provider.open(
        Factory.createFromConfig(factoryCfg, factoryCode)
    );

    if (!(await provider.isContractDeployed(factory.address))) {
        await factory.sendDeploy(provider.sender(), toNano("0.5"));
        await provider.waitForDeploy(factory.address);
    }
    ui.write(`Factory deployed at: ${factory.address.toString()}`);

    // ── Summary ───────────────────────────────────────────────────────────────
    ui.write("\n=== ORBIT Deployment Complete ===");
    ui.write(`FeeCollector : ${feeCollector.address.toString()}`);
    ui.write(`Factory      : ${factory.address.toString()}`);
    ui.write(`Fee BPS      : ${feeBps} (${feeBps / 100}%)`);
    ui.write("\nSave these addresses — you will need them for the relayer.");
}
