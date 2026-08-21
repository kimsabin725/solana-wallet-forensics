// Find the custody's current cumulative interest index so the legacy loan's
// accrued interest can be computed against the position's snapshot.
import { writeFile } from "node:fs/promises";

const RPC = "https://api.mainnet-beta.solana.com";
const CUSTODY = "G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa";
const SNAPSHOT = 1019986440526782966n; // from BorrowPosition offset 136

async function rpc(method, params) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}

const acc = await rpc("getAccountInfo", [CUSTODY, { encoding: "base64" }]);
const buf = Buffer.from(acc.value.data[0], "base64");
console.error(`custody len=${buf.length} owner=${acc.value.owner}`);

const hits = [];
for (let off = 8; off + 16 <= buf.length; off += 1) {
  const lo = buf.readBigUInt64LE(off);
  const hi = buf.readBigUInt64LE(off + 8);
  const u128 = lo + (hi << 64n);
  // an interest index just above the snapshot, within a plausible range
  if (u128 >= SNAPSHOT && u128 < SNAPSHOT * 3n) {
    hits.push({ off, u128: u128.toString(), ratio: Number(u128) / Number(SNAPSHOT) });
  }
}
console.error("\n-- u128 candidates >= snapshot --");
for (const h of hits) console.error(`  off ${h.off}: ${h.u128}  ratio=${h.ratio.toFixed(9)}`);

const u64hits = [];
for (let off = 8; off + 8 <= buf.length; off += 1) {
  const v = buf.readBigUInt64LE(off);
  if (v >= SNAPSHOT && v < SNAPSHOT * 3n) u64hits.push({ off, v: v.toString(), ratio: Number(v) / Number(SNAPSHOT) });
}
console.error("\n-- u64 candidates >= snapshot --");
for (const h of u64hits) console.error(`  off ${h.off}: ${h.v}  ratio=${h.ratio.toFixed(9)}`);

await writeFile(new URL("./perps_custody_raw.json", import.meta.url), JSON.stringify({
  address: CUSTODY, dataLen: buf.length, dataHex: buf.toString("hex"),
  snapshot: SNAPSHOT.toString(), u128Candidates: hits, u64Candidates: u64hits,
}, null, 2));
