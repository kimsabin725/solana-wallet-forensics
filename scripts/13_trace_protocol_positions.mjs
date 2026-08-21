// Resolve the residual small positions the wallet parked in minor protocols.
import { writeFile } from "node:fs/promises";
import { WALLET } from "./_wallet.mjs";

const RPC = "https://api.mainnet-beta.solana.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params) {
  for (let a = 0; a < 8; a += 1) {
    const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.status === 429) { await sleep(800 * 2 ** Math.min(a, 4)); continue; }
    const body = await res.json();
    if (!body.error) return body.result;
    await sleep(800 * 2 ** Math.min(a, 4));
  }
  throw new Error(`${method} failed`);
}

const TXS = {
  hupfpnStake: "2EhMWcb6skLweUh5iQZhekEaU82u3u3v1BXtN7oK5nFceFPoyMoqSkVvyzEtAS1ka1SaXXZxwvya9qZhhdPGqbJq",
  inv1t100Usdc: "57xUpeTGJ43XpjC5zhk9cY4k5nGMRcKstuR6rzgZ7X7oVozaxDRnLLtSy2DMGddoPadagZdd1CPLEMicgEc8deEw",
  realmsVoter: "5zohdTQXKcutM5dt6JU9QHLLvjBcArmNWCdqkFvp7iDSvLryKcUW5rH1wiyM1sXBL699vreqQ2q7nWZQNRvLqdCo",
};

const out = {};
for (const [name, sig] of Object.entries(TXS)) {
  const tx = await rpc("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  console.error(`\n=== ${name} (${tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : "?"}) ===`);
  console.error(`accounts: ${keys.length}`);
  // check which of these accounts still exist and what they hold
  const infos = await rpc("getMultipleAccounts", [keys, { encoding: "jsonParsed" }]);
  const rows = [];
  keys.forEach((k, i) => {
    const v = infos.value[i];
    if (!v) return;
    const parsed = v.data?.parsed;
    const row = { address: k, owner: v.owner, lamports: v.lamports, dataLen: v.data?.space ?? null };
    if (parsed?.type === "account") {
      row.tokenMint = parsed.info.mint;
      row.tokenOwner = parsed.info.owner;
      row.tokenAmount = parsed.info.tokenAmount.uiAmountString;
    }
    rows.push(row);
    const tag = row.tokenMint ? `TOKEN mint=${row.tokenMint.slice(0, 8)} owner=${row.tokenOwner?.slice(0, 8)} amt=${row.tokenAmount}` : `prog=${v.owner.slice(0, 8)} len=${row.dataLen}`;
    console.error(`  ${k}  ${tag}`);
  });
  out[name] = { signature: sig, accounts: rows,
    postTokenBalances: tx.meta?.postTokenBalances, logs: (tx.meta?.logMessages ?? []).slice(0, 40) };
  await sleep(300);
}

await writeFile(new URL("./small_positions_trace.json", import.meta.url), JSON.stringify(out, null, 2));
console.error("\nwritten small_positions_trace.json");
