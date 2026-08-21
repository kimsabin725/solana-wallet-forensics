import { Client } from "@jup-ag/lend-read";
import { Connection } from "@solana/web3.js";
import { writeFile } from "node:fs/promises";

const client = new Client(new Connection("https://api.mainnet-beta.solana.com", "confirmed"));
const mints = [
  "3TdQqvWTFL3k42yfQA7pnkiLPZrx2oA9iUDvv4po2eNe",
  "4GCXgwFKNkkd58fkXgYfzYMN1Z5PmvahtzDwZykyVx9n",
  "8nCv93Y3nNa68EW255WCp2jDjf4K6pAynz8AkSSfXBcv",
  "CqLgNx7KcaFeWkMQGyfRz5CdRDiTQXqAPsAGgCYydGSP",
  "FDxFzN1mjotxhXNmPsPzczDWopWPnMp8N6wXpn9t2djy",
  "H4R4SpDPEPSjVpQWkDDVooja2z1Ecr3RF2RnSKcaP6V2",
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function replacer(_key, value) {
  if (typeof value === "bigint") return value.toString();
  if (value && typeof value.toBase58 === "function") return value.toBase58();
  if (value && value.constructor?.name === "BN") return value.toString();
  return value;
}
const accounts = [];
for (const mint of mints) {
  const matches = await client.vault.program.account.position.all([{ memcmp: { bytes: mint, offset: 14 } }]);
  accounts.push(...matches.map((match) => ({ mint, publicKey: match.publicKey, account: match.account })));
  await sleep(2500);
}
await writeFile(new URL("./jupiter_position_accounts.json", import.meta.url), JSON.stringify(accounts, replacer, 2));
console.log(JSON.stringify(accounts, replacer, 2));
