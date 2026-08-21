import { Client } from "@jup-ag/lend-read";
import { Connection, PublicKey } from "@solana/web3.js";
import { readFile, writeFile } from "node:fs/promises";
import { WALLET } from "./_wallet.mjs";

const client = new Client(new Connection("https://api.mainnet-beta.solana.com", "confirmed"));
client.vault.program.provider.wallet = {
  publicKey: new PublicKey(WALLET),
  async signTransaction(transaction) { return transaction; },
  async signAllTransactions(transactions) { return transactions; },
};
const raw = JSON.parse(await readFile(new URL("./jupiter_vault_raw_snapshot.json", import.meta.url), "utf8"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function replacer(_key, value) {
  if (typeof value === "bigint") return value.toString();
  if (value && typeof value.toBase58 === "function") return value.toBase58();
  if (value && value.constructor?.name === "BN") return value.toString();
  return value;
}
const results = [];
for (const entry of raw) {
  if (results.some((x) => x.vaultId === entry.position.vaultId)) continue;
  const price = await client.vault.getOraclePrice(new PublicKey(entry.vaultConfig.oracle));
  results.push({ vaultId: entry.position.vaultId, supplyMint: entry.vaultConfig.supplyToken, borrowMint: entry.vaultConfig.borrowToken, oracle: entry.vaultConfig.oracle, price });
  await sleep(2200);
}
await writeFile(new URL("./jupiter_oracle_snapshot.json", import.meta.url), JSON.stringify(results, replacer, 2));
console.log(JSON.stringify(results, replacer, 2));
