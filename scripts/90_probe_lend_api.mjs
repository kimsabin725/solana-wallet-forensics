import { Client } from "@jup-ag/lend-read";
import { Connection, PublicKey } from "@solana/web3.js";
import { writeFile } from "node:fs/promises";
import { WALLET } from "./_wallet.mjs";

const rpc = "https://solana-rpc.publicnode.com";
const wallet = new PublicKey(WALLET);
const client = new Client(new Connection(rpc, "confirmed"));

function replacer(_key, value) {
  if (typeof value === "bigint") return value.toString();
  if (value && typeof value.toBase58 === "function") return value.toBase58();
  if (value && value.constructor?.name === "BN" && typeof value.toString === "function") return value.toString();
  return value;
}

const lendingPositions = await client.lending.getUserPositions(wallet);
const jlTokenDetails = await client.lending.getAllJlTokenDetails();
const totalVaults = await client.vault.getTotalVaults();
const vaultPositions = await client.vault.getAllUserPositions(wallet);

const output = { lendingPositions, jlTokenDetails, totalVaults, vaultPositions };
await writeFile(new URL("./jupiter_lend_snapshot.json", import.meta.url), JSON.stringify(output, replacer, 2));
console.log(JSON.stringify({ lendingPositions, totalVaults, vaultPositions }, replacer, 2));
