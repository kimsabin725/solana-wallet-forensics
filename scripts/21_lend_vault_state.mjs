import { Client } from "@jup-ag/lend-read";
import { Connection } from "@solana/web3.js";
import { readFile, writeFile } from "node:fs/promises";

const client = new Client(new Connection("https://api.mainnet-beta.solana.com", "confirmed"));
const accounts = JSON.parse(await readFile(new URL("./jupiter_position_accounts.json", import.meta.url), "utf8"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function replacer(_key, value) {
  if (typeof value === "bigint") return value.toString();
  if (value && typeof value.toBase58 === "function") return value.toBase58();
  if (value && value.constructor?.name === "BN") return value.toString();
  return value;
}

const byVault = [];
for (const entry of accounts) {
  const raw = await client.vault.getVaultConfigAndState(entry.account.vaultId);
  const tick = await client.vault.getTick({ vaultId: entry.account.vaultId, tick: entry.account.tick });
  byVault.push({ nftMint: entry.mint, position: entry.account, ...raw, tickData: tick });
  await sleep(2800);
}
await writeFile(new URL("./jupiter_vault_raw_snapshot.json", import.meta.url), JSON.stringify(byVault, replacer, 2));
console.log(JSON.stringify(byVault, replacer, 2));
