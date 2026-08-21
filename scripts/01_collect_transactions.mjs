import { writeFile } from "node:fs/promises";
import { WALLET } from "./_wallet.mjs";

const RPC = "https://api.mainnet-beta.solana.com";
const OUTPUT = new URL("./wallet_events.json", import.meta.url);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function rpc(method, params, id = 1) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const response = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      if (response.status === 429) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (body.error) {
        const retryable = [-32005, -32004, -32603].includes(body.error.code);
        if (retryable) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new Error(JSON.stringify(body.error));
      }
      return body.result;
    } catch (error) {
      if (attempt === 7) throw error;
      await sleep(500 * 2 ** attempt);
    }
  }
}

async function rpcTransactionBatch(signatureRecords) {
  const results = new Array(signatureRecords.length);
  let pending = signatureRecords.map((record, index) => ({ record, index }));
  for (let attempt = 0; attempt < 12 && pending.length; attempt += 1) {
    const response = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pending.map(({ record, index }) => ({
        jsonrpc: "2.0",
        id: index,
        method: "getTransaction",
        params: [record.signature, {
          encoding: "jsonParsed",
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        }],
      }))),
    });
    if (!response.ok) {
      await sleep(10_500);
      continue;
    }
    const bodies = await response.json();
    const byId = new Map(bodies.map((body) => [body.id, body]));
    const nextPending = [];
    for (const item of pending) {
      const body = byId.get(item.index);
      if (body && !body.error) results[item.index] = body.result;
      else nextPending.push(item);
    }
    pending = nextPending;
    if (pending.length) await sleep(10_500);
  }
  if (pending.length) throw new Error(`Unable to fetch ${pending.length} transactions after retries`);
  return results;
}

async function getSignatures() {
  const result = [];
  let before;
  for (;;) {
    const options = { limit: 1000, commitment: "confirmed" };
    if (before) options.before = before;
    const page = await rpc("getSignaturesForAddress", [WALLET, options]);
    result.push(...page);
    if (page.length < 1000) break;
    before = page.at(-1).signature;
  }
  return result;
}

function accountPubkey(accountKey) {
  return typeof accountKey === "string" ? accountKey : accountKey.pubkey;
}

function amountMap(balances = []) {
  const result = new Map();
  for (const balance of balances) {
    if (balance.owner !== WALLET) continue;
    const key = `${balance.accountIndex}:${balance.mint}`;
    result.set(key, {
      mint: balance.mint,
      decimals: balance.uiTokenAmount.decimals,
      amount: BigInt(balance.uiTokenAmount.amount),
    });
  }
  return result;
}

function normalize(signatureRecord, tx) {
  if (!tx) return { signature: signatureRecord.signature, missing: true };
  const meta = tx.meta;
  const keys = tx.transaction.message.accountKeys.map(accountPubkey);
  const walletIndex = keys.indexOf(WALLET);
  const pre = amountMap(meta.preTokenBalances);
  const post = amountMap(meta.postTokenBalances);
  const tokenKeys = new Set([...pre.keys(), ...post.keys()]);
  const tokenDeltas = new Map();

  for (const key of tokenKeys) {
    const before = pre.get(key);
    const after = post.get(key);
    const mint = (after ?? before).mint;
    const decimals = (after ?? before).decimals;
    const raw = (after?.amount ?? 0n) - (before?.amount ?? 0n);
    const current = tokenDeltas.get(mint) ?? { raw: 0n, decimals };
    current.raw += raw;
    tokenDeltas.set(mint, current);
  }

  const tokenChanges = [...tokenDeltas.entries()]
    .filter(([, value]) => value.raw !== 0n)
    .map(([mint, value]) => ({
      mint,
      raw: value.raw.toString(),
      decimals: value.decimals,
      amount: Number(value.raw) / 10 ** value.decimals,
    }));

  const outerInstructions = tx.transaction.message.instructions ?? [];
  const programIds = [...new Set(outerInstructions.map((instruction) => instruction.programId).filter(Boolean))];
  const instructions = outerInstructions.map((instruction) => ({
    programId: instruction.programId,
    parsedType: instruction.parsed?.type,
    parsedInfo: instruction.parsed?.info,
  }));
  const logs = meta.logMessages ?? [];
  const instructionNames = [...new Set(logs
    .filter((line) => line.includes("Program log: Instruction:"))
    .map((line) => line.split("Program log: Instruction:")[1].trim()))];

  return {
    signature: signatureRecord.signature,
    slot: tx.slot,
    blockTime: tx.blockTime,
    isoTime: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
    err: meta.err,
    feeSol: meta.fee / 1e9,
    walletSolDelta: walletIndex >= 0 ? (meta.postBalances[walletIndex] - meta.preBalances[walletIndex]) / 1e9 : 0,
    tokenChanges,
    programIds,
    instructionNames,
    instructions,
    logHints: logs.filter((line) => /Jupiter|Whirlpool|Kamino|Drift|Lend|Marginfi|Earn|Swap|Liquidity|Deposit|Withdraw|Borrow|Repay|Claim/i.test(line)),
  };
}

async function main() {
  const signatures = await getSignatures();
  const normalized = new Array(signatures.length);
  const batchSize = 20;
  for (let start = 0; start < signatures.length; start += batchSize) {
    const batchRecords = signatures.slice(start, start + batchSize);
    const txs = await rpcTransactionBatch(batchRecords);
    for (let offset = 0; offset < batchRecords.length; offset += 1) {
      normalized[start + offset] = normalize(batchRecords[offset], txs[offset]);
    }
    process.stdout.write(`fetched ${Math.min(start + batchSize, signatures.length)}/${signatures.length}\n`);
    await sleep(10_500);
  }

  const output = {
    wallet: WALLET,
    fetchedAt: new Date().toISOString(),
    signatureCount: signatures.length,
    events: normalized,
  };
  await writeFile(OUTPUT, JSON.stringify(output, null, 2));
  process.stdout.write(JSON.stringify({
    output: OUTPUT.pathname,
    signatures: signatures.length,
    successful: normalized.filter((event) => !event.err && !event.missing).length,
    failed: normalized.filter((event) => event.err).length,
    oldest: normalized.at(-1)?.isoTime,
    newest: normalized.at(0)?.isoTime,
  }, null, 2));
}

await main();
