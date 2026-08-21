// Decode the legacy Jupiter Perps BorrowPosition and its custody to derive
// the current debt including accrued interest.
import { writeFile } from "node:fs/promises";

const RPC = "https://api.mainnet-beta.solana.com";
const POSITION = "9GLG3VqJFLNk1xp9NBCqubUBXaMDGhWh45dn5176iNgT";
const PERPS = "PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu";
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

const acc = await rpc("getAccountInfo", [POSITION, { encoding: "base64" }]);
const buf = Buffer.from(acc.value.data[0], "base64");
console.error(`position len=${buf.length} owner=${acc.value.owner}`);
console.error(`disc=${buf.subarray(0, 8).toString("hex")}`);

// walk u64/u128 candidates so the layout can be identified by value
const u64s = [];
for (let off = 8; off + 8 <= buf.length; off += 1) {
  u64s.push({ off, v: buf.readBigUInt64LE(off).toString() });
}
console.error("\n-- notable u64 values --");
for (const { off, v } of u64s) {
  const n = BigInt(v);
  if (n > 1000n && n < 10n ** 22n) console.error(`  off ${off}: ${v}`);
}

console.error("\n-- pubkey-looking fields --");
const { PublicKey } = await import("@solana/web3.js");
for (let off = 8; off + 32 <= buf.length; off += 1) {
  const sub = buf.subarray(off, off + 32);
  const nonzero = sub.filter((b) => b !== 0).length;
  if (nonzero > 24) {
    try { console.error(`  off ${off}: ${new PublicKey(sub).toBase58()}`); } catch {}
  }
}

console.error(`\nhex dump:\n${buf.toString("hex").match(/.{1,64}/g).join("\n")}`);

await writeFile(new URL("./legacy_jlp_position_raw.json", import.meta.url), JSON.stringify({
  address: POSITION, owner: acc.value.owner, lamports: acc.value.lamports,
  dataLen: buf.length, dataHex: buf.toString("hex"),
  u64Scan: u64s,
}, null, 2));
