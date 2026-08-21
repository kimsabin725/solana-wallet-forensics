// Locate the custody's current interest index by comparing our position's
// snapshot against other BorrowPositions on the same custody: a position
// updated recently carries a snapshot equal to the current index.
import { writeFile } from "node:fs/promises";

const RPC = "https://api.mainnet-beta.solana.com";
const PERPS = "PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu";
const CUSTODY = "G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa";
const DISC = "f38c148b20f37237";

async function rpc(method, params) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}

const bs58 = (await import("@solana/web3.js")).PublicKey;
// encode the 8-byte discriminator as base58 for memcmp
function toB58(bytes) {
  const ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = ALPH[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}
const discB58 = toB58(Buffer.from(DISC, "hex"));

const accounts = await rpc("getProgramAccounts", [PERPS, {
  encoding: "base64",
  filters: [
    { dataSize: 256 },
    { memcmp: { offset: 0, bytes: discB58 } },
    { memcmp: { offset: 72, bytes: CUSTODY } },
  ],
}]);
console.error(`peer BorrowPositions on this custody: ${accounts.length}`);

const rows = accounts.map((a) => {
  const b = Buffer.from(a.account.data[0], "base64");
  return {
    address: a.pubkey,
    openTime: Number(b.readBigUInt64LE(104)),
    updateTime: Number(b.readBigUInt64LE(112)),
    borrowSize: b.readBigUInt64LE(120).toString(),
    interestSnapshot: (b.readBigUInt64LE(136) + (b.readBigUInt64LE(144) << 64n)).toString(),
    lockedCollateral: b.readBigUInt64LE(152).toString(),
  };
}).sort((x, y) => y.updateTime - x.updateTime);

console.error("\n-- 12 most recently updated --");
for (const r of rows.slice(0, 12)) {
  console.error(`  ${new Date(r.updateTime * 1000).toISOString()}  snap=${r.interestSnapshot}  borrow=${r.borrowSize}  coll=${r.lockedCollateral}  ${r.address}`);
}

const maxSnap = rows.reduce((m, r) => (BigInt(r.interestSnapshot) > m ? BigInt(r.interestSnapshot) : m), 0n);
console.error(`\nmax snapshot across peers: ${maxSnap}`);
console.error(`our snapshot:              1019986440526782966`);
console.error(`implied growth ratio:      ${Number(maxSnap) / 1019986440526782966}`);

await writeFile(new URL("./perps_peer_positions.json", import.meta.url),
  JSON.stringify({ custody: CUSTODY, count: rows.length, maxSnapshot: maxSnap.toString(), rows }, null, 2));
