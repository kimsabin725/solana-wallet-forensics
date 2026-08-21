import { readFile, writeFile } from "node:fs/promises";
import { WALLET } from "./_wallet.mjs";

const RPC = "https://api.mainnet-beta.solana.com";
const USDC_ATA = "2HN6syswgvKwqawfWHW2fcm3dTSHyYKCp1AUtAgJq9gK";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function rpc(method, params) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (response.status === 429) {
      await sleep(750 * 2 ** Math.min(attempt, 5));
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (!body.error) return body.result;
    await sleep(750 * 2 ** Math.min(attempt, 5));
  }
  throw new Error(`${method} failed after retries`);
}

async function getSignatures() {
  const rows = [];
  let before;
  for (;;) {
    const options = { limit: 1000, commitment: "confirmed" };
    if (before) options.before = before;
    const page = await rpc("getSignaturesForAddress", [USDC_ATA, options]);
    rows.push(...page);
    if (page.length < 1000) return rows;
    before = page.at(-1).signature;
  }
}

function pubkey(value) {
  return typeof value === "string" ? value : value.pubkey;
}

function ataAmount(balances, accountIndex) {
  const balance = (balances ?? []).find((item) =>
    item.accountIndex === accountIndex && item.mint === USDC_MINT);
  return BigInt(balance?.uiTokenAmount.amount ?? "0");
}

function outerTransferSummary(tx) {
  return (tx.transaction.message.instructions ?? [])
    .filter((instruction) => ["transfer", "transferChecked"].includes(instruction.parsed?.type))
    .map((instruction) => instruction.parsed.info)
    .filter((info) => info.source === USDC_ATA || info.destination === USDC_ATA)
    .map((info) => ({
      source: info.source,
      destination: info.destination,
      authority: info.authority,
      amount: info.tokenAmount?.uiAmount ?? Number(info.amount ?? 0) / 1e6,
    }));
}

async function main() {
  const walletData = JSON.parse(await readFile(new URL("./wallet_events.json", import.meta.url)));
  const walletSignatures = new Set(walletData.events.map((event) => event.signature));
  const signatures = await getSignatures();
  const missing = signatures.filter((row) => !walletSignatures.has(row.signature));
  const rows = [];

  for (let index = 0; index < missing.length; index += 1) {
    const record = missing[index];
    const tx = await rpc("getTransaction", [record.signature, {
      encoding: "jsonParsed",
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    }]);
    if (!tx || tx.meta.err) continue;
    const keys = tx.transaction.message.accountKeys.map(pubkey);
    const accountIndex = keys.indexOf(USDC_ATA);
    if (accountIndex < 0) continue;
    const pre = ataAmount(tx.meta.preTokenBalances, accountIndex);
    const post = ataAmount(tx.meta.postTokenBalances, accountIndex);
    const rawDelta = post - pre;
    if (rawDelta === 0n) continue;
    rows.push({
      signature: record.signature,
      isoTime: new Date(tx.blockTime * 1000).toISOString(),
      amount: Number(rawDelta) / 1e6,
      walletPresent: keys.includes(WALLET),
      outerTransfers: outerTransferSummary(tx),
    });
    if ((index + 1) % 20 === 0) {
      process.stdout.write(`fetched ${index + 1}/${missing.length}\n`);
    }
    await sleep(120);
  }

  rows.sort((a, b) => a.isoTime.localeCompare(b.isoTime));
  const output = {
    usdcAta: USDC_ATA,
    signatureCount: signatures.length,
    signaturesMissingFromWalletHistory: missing.length,
    netMissingUsdcDelta: rows.reduce((sum, row) => sum + row.amount, 0),
    positiveMissingUsdcDelta: rows.filter((row) => row.amount > 0).reduce((sum, row) => sum + row.amount, 0),
    negativeMissingUsdcDelta: rows.filter((row) => row.amount < 0).reduce((sum, row) => sum + row.amount, 0),
    rows,
  };
  await writeFile(new URL("./usdc_ata_audit.json", import.meta.url), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
}

await main();
