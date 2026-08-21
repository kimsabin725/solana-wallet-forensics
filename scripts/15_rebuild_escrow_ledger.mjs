// Rebuild the staked-JUP balance from the escrow vault's own transaction history.
import { writeFile } from "node:fs/promises";

const RPC = "https://api.mainnet-beta.solana.com";
const ESCROW_TOKENS = "G5AuJwbvxeNyvbwuv6Zq43vDzpVbFP2wfQrvDExyj7Tz";
const JUP_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params) {
  for (let a = 0; a < 10; a += 1) {
    const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.status === 429) { await sleep(700 * 2 ** Math.min(a, 5)); continue; }
    const body = await res.json();
    if (!body.error) return body.result;
    await sleep(700 * 2 ** Math.min(a, 5));
  }
  throw new Error(`${method} failed`);
}

const sigs = await rpc("getSignaturesForAddress", [ESCROW_TOKENS, { limit: 1000 }]);
sigs.sort((a, b) => a.blockTime - b.blockTime);

const rows = [];
let running = 0;
for (const s of sigs) {
  const tx = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
  const pre = (tx.meta?.preTokenBalances ?? []).find((b) => b.mint === JUP_MINT && b.owner && tx.transaction.message.accountKeys[b.accountIndex]?.pubkey === ESCROW_TOKENS);
  const post = (tx.meta?.postTokenBalances ?? []).find((b) => b.mint === JUP_MINT && tx.transaction.message.accountKeys[b.accountIndex]?.pubkey === ESCROW_TOKENS);
  const before = Number(pre?.uiTokenAmount.uiAmountString ?? 0);
  const after = Number(post?.uiTokenAmount.uiAmountString ?? 0);
  const delta = after - before;
  running = after;
  const ix = (tx.meta?.logMessages ?? []).filter((l) => l.startsWith("Program log: Instruction:")).map((l) => l.replace("Program log: Instruction: ", ""));
  const claimLog = (tx.meta?.logMessages ?? []).filter((l) => /claimed/i.test(l));
  rows.push({
    isoTime: new Date(s.blockTime * 1000).toISOString(),
    signature: s.signature, instructions: ix,
    before, after, delta, claimLog,
  });
  console.error(`${new Date(s.blockTime * 1000).toISOString()}  ${delta >= 0 ? "+" : ""}${delta.toFixed(6)}  -> ${after.toFixed(6)}  [${ix.join(",")}]`);
  await sleep(150);
}

const totalIn = rows.filter((r) => r.delta > 0).reduce((a, r) => a + r.delta, 0);
const totalOut = rows.filter((r) => r.delta < 0).reduce((a, r) => a + r.delta, 0);
console.error(`\ntotal in  = ${totalIn}`);
console.error(`total out = ${totalOut}`);
console.error(`final     = ${running}`);

await writeFile(new URL("./jup_escrow_ledger.json", import.meta.url),
  JSON.stringify({ escrowTokens: ESCROW_TOKENS, rows, totalIn, totalOut, final: running }, null, 2));
