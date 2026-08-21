// Single-timestamp revaluation of every position the wallet controls.
import { writeFile } from "node:fs/promises";
import { PublicKey } from "@solana/web3.js";
import { WALLET } from "./_wallet.mjs";

const RPC = "https://api.mainnet-beta.solana.com";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params) {
  for (let a = 0; a < 8; a += 1) {
    const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.status === 429) { await sleep(700 * 2 ** Math.min(a, 5)); continue; }
    const body = await res.json();
    if (!body.error) return body.result;
    await sleep(700 * 2 ** Math.min(a, 5));
  }
  throw new Error(`${method} failed`);
}

const slot = await rpc("getSlot", []);
const blockTime = await rpc("getBlockTime", [slot]);
console.error(`snapshot slot=${slot} time=${new Date(blockTime * 1000).toISOString()}`);

// ---- wallet balances -------------------------------------------------------
const solLamports = (await rpc("getBalance", [WALLET])).value;
const balances = [];
for (const prog of [TOKEN, TOKEN22]) {
  const res = await rpc("getTokenAccountsByOwner", [WALLET, { programId: prog }, { encoding: "jsonParsed" }]);
  for (const acc of res.value ?? []) {
    const info = acc.account.data.parsed.info;
    const amt = Number(info.tokenAmount.uiAmountString ?? 0);
    if (amt > 0) balances.push({ account: acc.pubkey, mint: info.mint, amount: amt, decimals: info.tokenAmount.decimals });
  }
}
console.error(`non-zero token balances: ${balances.length}`);
for (const b of balances) console.error(`  ${b.mint} ${b.amount}`);

// ---- prices ----------------------------------------------------------------
const MINTS = {
  SOL: "So11111111111111111111111111111111111111112",
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  JLP: "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4",
  cbBTC: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
  TSLAx: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
  CRCLx: "XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1",
  jupSOL: "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v",
  JitoSOL: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  JupUSD: "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD",
  jlJupUSD: "7GxATsNMnaC88vdwd2t3mwrFuQwwGvmYPrUQ4D6FotXk",
  PST: "59obFNBzyTBGowrkif5uK7ojS58vsuWz3ZCvg6tfZAGw",
  FSG: "FSGWCMvsxYTQKWtDa9fz7rNWQB31X674q62LbmSPRMu9",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
};
const extraMints = balances.map((b) => b.mint).filter((m) => !Object.values(MINTS).includes(m));
const allMints = [...new Set([...Object.values(MINTS), ...extraMints])];

const prices = {};
for (let i = 0; i < allMints.length; i += 40) {
  const chunk = allMints.slice(i, i + 40);
  const url = `https://api.jup.ag/price/v3?ids=${chunk.join(",")}`;
  try {
    const j = await res2json(url);
    for (const [k, v] of Object.entries(j ?? {})) if (v?.usdPrice) prices[k] = v.usdPrice;
  } catch (e) { console.error(`price fetch error: ${e.message}`); }
  await sleep(400);
}
async function res2json(url) { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }

console.error("\n-- prices --");
for (const [name, mint] of Object.entries(MINTS)) console.error(`  ${name.padEnd(9)} ${prices[mint] ?? "MISSING"}`);
for (const m of extraMints) console.error(`  ${m} ${prices[m] ?? "MISSING"}`);

// ---- staked JUP ------------------------------------------------------------
const escrow = await rpc("getAccountInfo", ["GXcDNmcwcatpRfweensDDe7XWpc541SfBpypmZcbJ2QF", { encoding: "base64" }]);
const stakedJup = Number(Buffer.from(escrow.value.data[0], "base64").readBigUInt64LE(105)) / 1e6;
console.error(`\nstaked JUP: ${stakedJup}`);

// ---- legacy Jupiter Perps JLP loan ----------------------------------------
const legacyPos = Buffer.from((await rpc("getAccountInfo", ["9GLG3VqJFLNk1xp9NBCqubUBXaMDGhWh45dn5176iNgT", { encoding: "base64" }])).value.data[0], "base64");
const legacySnapshot = legacyPos.readBigUInt64LE(136) + (legacyPos.readBigUInt64LE(144) << 64n);
const legacyBorrowRaw = legacyPos.readBigUInt64LE(120);
const legacyCollRaw = legacyPos.readBigUInt64LE(152);
const custody = Buffer.from((await rpc("getAccountInfo", ["G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa", { encoding: "base64" }])).value.data[0], "base64");
const currentIndex = custody.readBigUInt64LE(972) + (custody.readBigUInt64LE(980) << 64n);
const legacyDebt = (Number(legacyBorrowRaw) / 1e9) * (Number(currentIndex) / Number(legacySnapshot));
const legacyColl = Number(legacyCollRaw) / 1e6;
console.error(`legacy JLP loan: collateral ${legacyColl} JLP, debt ${legacyDebt.toFixed(6)} USDC (index ratio ${(Number(currentIndex) / Number(legacySnapshot)).toFixed(9)})`);

await writeFile(new URL("./revaluation_inputs.json", import.meta.url), JSON.stringify({
  slot, isoTime: new Date(blockTime * 1000).toISOString(),
  nativeSol: solLamports / 1e9, balances, prices, mints: MINTS, stakedJup,
  legacyJlpLoan: {
    collateralJlp: legacyColl,
    borrowPrincipalUsdc: Number(legacyBorrowRaw) / 1e9,
    interestSnapshot: legacySnapshot.toString(),
    currentIndex: currentIndex.toString(),
    currentDebtUsdc: legacyDebt,
  },
}, null, 2));
console.error("\nwritten revaluation_inputs.json");
