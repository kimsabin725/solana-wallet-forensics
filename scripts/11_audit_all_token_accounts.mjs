// Full token-account audit: find deposits/withdrawals that never appear in the
// owner wallet's own signature history (the failure mode documented in ch.2).
import { readFile, writeFile } from "node:fs/promises";
import { PublicKey } from "@solana/web3.js";
import { WALLET } from "./_wallet.mjs";

const RPC = "https://api.mainnet-beta.solana.com";
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN22 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROG = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (res.status === 429) { await sleep(700 * 2 ** Math.min(attempt, 5)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!body.error) return body.result;
      await sleep(700 * 2 ** Math.min(attempt, 5));
    } catch (e) {
      if (attempt === 9) throw e;
      await sleep(700 * 2 ** Math.min(attempt, 5));
    }
  }
  throw new Error(`${method} failed`);
}

function ata(mint, programId) {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(WALLET).toBuffer(), programId.toBuffer(), new PublicKey(mint).toBuffer()],
    ATA_PROG
  )[0].toBase58();
}

async function allSignatures(address) {
  const out = [];
  let before;
  for (;;) {
    const params = [address, before ? { limit: 1000, before } : { limit: 1000 }];
    const page = await rpc("getSignaturesForAddress", params);
    if (!page?.length) break;
    out.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
    await sleep(120);
  }
  return out;
}

const events = JSON.parse(await readFile(new URL("./wallet_events.json", import.meta.url), "utf8"));
const ownerSigs = new Set(events.events.map((e) => e.signature));
const summary = JSON.parse(await readFile(new URL("./wallet_summary.json", import.meta.url), "utf8"));

// 1. every mint the wallet has ever touched
const mints = new Set(summary.tokenTable.map((t) => t.mint));

// 2. current live token accounts (both programs)
const candidates = new Map(); // address -> {mint, source}
for (const prog of [TOKEN, TOKEN22]) {
  const res = await rpc("getTokenAccountsByOwner", [
    WALLET, { programId: prog.toBase58() }, { encoding: "jsonParsed" },
  ]);
  for (const acc of res.value ?? []) {
    const mint = acc.account.data.parsed.info.mint;
    mints.add(mint);
    candidates.set(acc.pubkey, { mint, source: "live" });
  }
}

// 3. derived ATAs for every historical mint under both programs (catches closed ATAs)
for (const mint of mints) {
  for (const prog of [TOKEN, TOKEN22]) {
    try {
      const addr = ata(mint, prog);
      if (!candidates.has(addr)) candidates.set(addr, { mint, source: "derived" });
    } catch { /* non-ATA mint (e.g. position NFT) */ }
  }
}

console.error(`candidate token accounts: ${candidates.size}`);

const perAccount = [];
const missingSigs = new Map(); // sig -> {accounts:[]}
let idx = 0;
for (const [addr, meta] of candidates) {
  idx += 1;
  let sigs = [];
  try { sigs = await allSignatures(addr); } catch (e) { console.error(`ERR ${addr}: ${e.message}`); }
  const missing = sigs.filter((s) => !ownerSigs.has(s.signature));
  perAccount.push({ address: addr, mint: meta.mint, source: meta.source, total: sigs.length, missing: missing.length });
  for (const s of missing) {
    if (!missingSigs.has(s.signature)) missingSigs.set(s.signature, { blockTime: s.blockTime, accounts: [] });
    missingSigs.get(s.signature).accounts.push(addr);
  }
  console.error(`[${idx}/${candidates.size}] ${addr} ${meta.mint.slice(0, 6)} total=${sigs.length} missing=${missing.length}`);
  await sleep(150);
}

console.error(`unique missing signatures: ${missingSigs.size}`);

// 4. decode each missing transaction for wallet-owned deltas
const decoded = [];
let n = 0;
for (const [sig, info] of missingSigs) {
  n += 1;
  let tx = null;
  try {
    tx = await rpc("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
  } catch (e) { console.error(`tx err ${sig}: ${e.message}`); }
  if (!tx) { decoded.push({ signature: sig, error: "fetch-failed", blockTime: info.blockTime }); continue; }
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  const byIdx = new Map();
  for (const b of pre) if (b.owner === WALLET) byIdx.set(b.accountIndex, { mint: b.mint, pre: Number(b.uiTokenAmount.uiAmountString ?? 0), post: 0 });
  for (const b of post) {
    if (b.owner !== WALLET) continue;
    const cur = byIdx.get(b.accountIndex) ?? { mint: b.mint, pre: 0, post: 0 };
    cur.post = Number(b.uiTokenAmount.uiAmountString ?? 0);
    byIdx.set(b.accountIndex, cur);
  }
  const deltas = [];
  for (const v of byIdx.values()) {
    const d = v.post - v.pre;
    if (Math.abs(d) > 1e-12) deltas.push({ mint: v.mint, delta: d });
  }
  decoded.push({
    signature: sig,
    isoTime: info.blockTime ? new Date(info.blockTime * 1000).toISOString() : null,
    err: tx.meta?.err ?? null,
    accounts: info.accounts,
    programIds: [...new Set((tx.transaction.message.instructions ?? []).map((i) => i.programId))],
    deltas,
  });
  if (n % 10 === 0) console.error(`decoded ${n}/${missingSigs.size}`);
  await sleep(150);
}

await writeFile(new URL("./all_ata_audit.json", import.meta.url), JSON.stringify({
  wallet: WALLET, ownerSignatureCount: ownerSigs.size,
  candidateAccounts: perAccount, missingSignatureCount: missingSigs.size, missing: decoded,
}, null, 2));
console.error("written all_ata_audit.json");
