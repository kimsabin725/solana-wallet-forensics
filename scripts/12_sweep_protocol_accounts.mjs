// Sweep every program the wallet ever touched for accounts that embed the
// wallet pubkey, so no protocol-held position is left unvalued.
import { writeFile } from "node:fs/promises";
import { WALLET } from "./_wallet.mjs";

const RPC = "https://api.mainnet-beta.solana.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROGRAMS = [
  "61DFfeTKM7trxYcPQCM78bJ794ddZprZpAwAnLiwTpYH",
  "jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi",
  "jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9",
  "jupgfSgfuAXv4B6R2Uxu85Z1qdzgju79s6MfZekN6XS",
  "HumaXepHnjaRCpjYTokxY4UtaJcmx41prQ8cxGmFC5fn",
  "raTeAJ92EGM17TBENyDNvrsjmhhujvaanXCFKuxF494",
  "6LtLpnUFNByNXLyCoK9wA2MykKAmQNZKBdY8s47dehDc",
  "inv1tEtSwRMtM44tbvJGNiTxMvDfPVnX9StyqXfDfks",
  "DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH",
  "vsRJM68m7i18PwzTFphgPYXTujCgxEi28knpUwSmg3q",
  "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr",
  "proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u",
  "HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ",
];

async function rpc(method, params) {
  for (let a = 0; a < 6; a += 1) {
    try {
      const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (res.status === 429) { await sleep(800 * 2 ** Math.min(a, 4)); continue; }
      const body = await res.json();
      if (body.error) return { __error: body.error.message ?? JSON.stringify(body.error) };
      return body.result;
    } catch (e) { if (a === 5) return { __error: e.message }; await sleep(800); }
  }
}

const out = [];
for (const prog of PROGRAMS) {
  for (const offset of [8, 40, 72, 104]) {
    const res = await rpc("getProgramAccounts", [prog, {
      encoding: "base64", filters: [{ memcmp: { offset, bytes: WALLET } }],
    }]);
    if (res?.__error) { console.error(`${prog} @${offset}: ERROR ${res.__error}`); await sleep(300); continue; }
    if (!res?.length) { await sleep(250); continue; }
    for (const a of res) {
      const buf = Buffer.from(a.account.data[0], "base64");
      out.push({ program: prog, offset, address: a.pubkey, dataLen: buf.length, lamports: a.account.lamports, dataHex: buf.toString("hex") });
      console.error(`FOUND ${prog} @${offset} -> ${a.pubkey} len=${buf.length}`);
    }
    await sleep(300);
  }
}

await writeFile(new URL("./protocol_accounts_sweep.json", import.meta.url), JSON.stringify(out, null, 2));
console.error(`\ntotal accounts found: ${out.length}`);
