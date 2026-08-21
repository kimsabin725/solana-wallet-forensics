// Trace the Jupiter governance escrow to explain the unreconciled staked-JUP increase.
import { readFile, writeFile } from "node:fs/promises";
import { PublicKey } from "@solana/web3.js";
import { WALLET } from "./_wallet.mjs";

const RPC = "https://api.mainnet-beta.solana.com";
const VOTER_PROGRAM = new PublicKey("voTpe3tHQ7AjQHMapgSue2HJFAh2cGsdokqN3XqmVSj");
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

// Escrow accounts are owned by the voter program and carry the owner pubkey at
// offset 40 (disc 8 + locker 32). memcmp finds it without knowing the locker.
const found = await rpc("getProgramAccounts", [VOTER_PROGRAM.toBase58(), {
  encoding: "base64",
  filters: [{ memcmp: { offset: 40, bytes: WALLET } }],
}]);

console.error(`escrow accounts found: ${found.length}`);
const escrows = [];
for (const acc of found) {
  const buf = Buffer.from(acc.account.data[0], "base64");
  const locker = new PublicKey(buf.subarray(8, 40)).toBase58();
  const tokens = new PublicKey(buf.subarray(73, 105)).toBase58();
  const amount = buf.readBigUInt64LE(105);
  const startedAt = buf.readBigInt64LE(113);
  const endsAt = buf.readBigInt64LE(121);
  escrows.push({
    address: acc.pubkey, locker, escrowTokens: tokens,
    amountRaw: amount.toString(), amountUi: Number(amount) / 1e6,
    escrowStartedAt: new Date(Number(startedAt) * 1000).toISOString(),
    escrowEndsAt: Number(endsAt) ? new Date(Number(endsAt) * 1000).toISOString() : null,
    dataLen: buf.length,
  });
  console.error(`escrow ${acc.pubkey} amount=${Number(amount) / 1e6} JUP`);
}

const events = JSON.parse(await readFile(new URL("./wallet_events.json", import.meta.url), "utf8"));
const ownerSigs = new Set(events.events.map((e) => e.signature));

async function allSignatures(address) {
  const out = []; let before;
  for (;;) {
    const page = await rpc("getSignaturesForAddress", [address, before ? { limit: 1000, before } : { limit: 1000 }]);
    if (!page?.length) break;
    out.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
    await sleep(120);
  }
  return out;
}

const report = [];
for (const esc of escrows) {
  // the escrow's JUP vault holds the actual staked tokens
  for (const addr of [esc.address, esc.escrowTokens]) {
    const sigs = await allSignatures(addr);
    const missing = sigs.filter((s) => !ownerSigs.has(s.signature));
    console.error(`${addr}: total=${sigs.length} missing-from-owner=${missing.length}`);
    const decoded = [];
    for (const s of missing) {
      const tx = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      if (!tx) { decoded.push({ signature: s.signature, error: "fetch-failed" }); continue; }
      const pre = tx.meta?.preTokenBalances ?? [];
      const post = tx.meta?.postTokenBalances ?? [];
      const jupDelta = [];
      const idxs = new Set([...pre, ...post].map((b) => b.accountIndex));
      for (const i of idxs) {
        const p = pre.find((b) => b.accountIndex === i);
        const q = post.find((b) => b.accountIndex === i);
        const mint = p?.mint ?? q?.mint;
        if (mint !== JUP_MINT) continue;
        const d = Number(q?.uiTokenAmount.uiAmountString ?? 0) - Number(p?.uiTokenAmount.uiAmountString ?? 0);
        if (Math.abs(d) > 1e-9) jupDelta.push({ owner: q?.owner ?? p?.owner, delta: d });
      }
      decoded.push({
        signature: s.signature,
        isoTime: s.blockTime ? new Date(s.blockTime * 1000).toISOString() : null,
        instructionNames: (tx.meta?.logMessages ?? []).filter((l) => l.startsWith("Program log: Instruction:")).map((l) => l.replace("Program log: Instruction: ", "")),
        jupDelta,
        logs: (tx.meta?.logMessages ?? []).filter((l) => /claim|reward|amount|token/i.test(l)).slice(0, 8),
      });
      await sleep(150);
    }
    report.push({ address: addr, role: addr === esc.address ? "escrow" : "escrowTokens", total: sigs.length, missingCount: missing.length, missing: decoded });
  }
}

const api = await (await fetch(`https://api.jup.ag/portfolio/v1/staked-jup/${WALLET}`)).json().catch((e) => ({ error: String(e) }));

await writeFile(new URL("./jup_escrow_audit.json", import.meta.url),
  JSON.stringify({ escrows, report, stakedJupApi: api }, null, 2));
console.error("written jup_escrow_audit.json");
