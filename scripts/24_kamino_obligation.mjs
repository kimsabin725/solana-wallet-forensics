import {
  KaminoMarket,
  DEFAULT_RECENT_SLOT_DURATION_MS,
} from "@kamino-finance/klend-sdk";
import { address, createSolanaRpc } from "@solana/kit";
import { writeFile } from "node:fs/promises";
import { WALLET } from "./_wallet.mjs";

const rpc = createSolanaRpc("https://api.mainnet-beta.solana.com");
const marketAddress = address("5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua");
const owner = address(WALLET);

const market = await KaminoMarket.load(rpc, marketAddress, DEFAULT_RECENT_SLOT_DURATION_MS);
if (!market) throw new Error("Kamino main market was not found");
const slot = await rpc.getSlot({ commitment: "processed" }).send();
const obligations = await market.getAllUserObligations(owner, slot);

function positionJson(position) {
  return {
    reserveAddress: position.reserveAddress.toString(),
    mintAddress: position.mintAddress.toString(),
    mintFactor: position.mintFactor.toString(),
    amountRaw: position.amount.toString(),
    tokenAmount: position.amount.div(position.mintFactor).toString(),
    marketValueUsd: position.marketValueRefreshed.toString(),
  };
}

function statsJson(stats) {
  return Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, value?.toString?.() ?? value]));
}

const output = {
  slot: slot.toString(),
  market: market.getAddress().toString(),
  obligations: obligations.map((obligation) => ({
    address: obligation.obligationAddress.toString(),
    tag: obligation.obligationTag,
    owner: obligation.state.owner.toString(),
    stats: statsJson(obligation.refreshedStats),
    deposits: [...obligation.deposits.values()].map(positionJson),
    borrows: [...obligation.borrows.values()].map(positionJson),
  })),
};

await writeFile(new URL("./kamino_snapshot.json", import.meta.url), JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
