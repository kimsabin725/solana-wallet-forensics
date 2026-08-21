import {
  PermissionlessClient,
  SolanaChainEnum,
  DepositMode,
} from "@huma-finance/permissionless-sdk";
import { PublicKey } from "@solana/web3.js";
import { writeFile } from "node:fs/promises";
import { WALLET } from "./_wallet.mjs";

const rpc = "https://api.mainnet-beta.solana.com";
const owner = new PublicKey(WALLET);
const client = new PermissionlessClient(rpc, SolanaChainEnum.MAINNET);

const price = await client.getModeTokenPrice(DepositMode.CLASSIC);
const targetApy = await client.getModeTargetApy(DepositMode.CLASSIC);
let balances;
let balancesError;
try {
  balances = await client.getBalances(owner, DepositMode.CLASSIC);
} catch (error) {
  balancesError = String(error);
}

const output = {
  priceRaw: price.toString(),
  priceUsdc: Number(price.toString()) / 1e6,
  targetApyBps: targetApy,
  balances: balances ? {
    lockedRaw: balances.lockedBalance.toString(),
    unlockedRaw: balances.unlockedBalance.toString(),
    pendingRedemptionsRaw: balances.pendingRedemptions.toString(),
    lockedPst: Number(balances.lockedBalance.toString()) / 1e6,
    unlockedPst: Number(balances.unlockedBalance.toString()) / 1e6,
    pendingRedemptionsPst: Number(balances.pendingRedemptions.toString()) / 1e6,
  } : null,
  balancesError,
};

await writeFile(new URL("./huma_snapshot.json", import.meta.url), JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
