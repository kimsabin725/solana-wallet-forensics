import { readFile, writeFile } from "node:fs/promises";

const data = JSON.parse(await readFile(new URL("./wallet_events.json", import.meta.url), "utf8"));

const known = {
  So11111111111111111111111111111111111111112: "wSOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "JUP",
  jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v: "jupSOL",
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: "JitoSOL",
  "59obFNBzyTBGowrkif5uK7ojS58vsuWz3ZCvg6tfZAGw": "PST",
  FSGWCMvsxYTQKWtDa9fz7rNWQB31X674q62LbmSPRMu9: "FSG",
  XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB: "TSLAx",
  XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1: "PRCLx",
};

const tokenStats = new Map();
const programStats = new Map();
const instructionStats = new Map();
let totalFees = 0;
let netSol = 0;

for (const event of data.events) {
  totalFees += event.feeSol ?? 0;
  netSol += event.walletSolDelta ?? 0;
  for (const change of event.tokenChanges ?? []) {
    const stat = tokenStats.get(change.mint) ?? {
      mint: change.mint,
      name: known[change.mint] ?? "?",
      txs: 0,
      net: 0,
      inflow: 0,
      outflow: 0,
      first: event.isoTime,
      last: event.isoTime,
    };
    stat.txs += 1;
    stat.net += change.amount;
    if (change.amount > 0) stat.inflow += change.amount;
    if (change.amount < 0) stat.outflow += change.amount;
    stat.first = event.isoTime;
    tokenStats.set(change.mint, stat);
  }
  for (const program of event.programIds ?? []) programStats.set(program, (programStats.get(program) ?? 0) + 1);
  for (const name of event.instructionNames ?? []) instructionStats.set(name, (instructionStats.get(name) ?? 0) + 1);
}

const tokenTable = [...tokenStats.values()].sort((a, b) => b.txs - a.txs);
const programTable = [...programStats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
  .map(([program, txs]) => ({ program, txs }));
const instructionTable = [...instructionStats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50)
  .map(([instruction, txs]) => ({ instruction, txs }));

const economicEvents = data.events
  .filter((event) => !event.err && ((event.tokenChanges?.length ?? 0) || Math.abs(event.walletSolDelta ?? 0) > 0.0025))
  .map((event) => ({
    time: event.isoTime,
    signature: event.signature,
    sol: event.walletSolDelta,
    fee: event.feeSol,
    tokens: (event.tokenChanges ?? []).map((change) => ({
      symbol: known[change.mint] ?? change.mint.slice(0, 6),
      mint: change.mint,
      amount: change.amount,
    })),
    programs: event.programIds,
    instructions: event.instructionNames,
    hints: event.logHints,
  }));

const output = {
  summary: { transactions: data.signatureCount, totalFeesSol: totalFees, netWalletSolChange: netSol },
  tokenTable,
  programTable,
  instructionTable,
  economicEventCount: economicEvents.length,
  economicEvents,
};
await writeFile(new URL("./wallet_summary.json", import.meta.url), JSON.stringify(output, null, 2));
console.log(JSON.stringify({
  summary: output.summary,
  tokenTable,
  programTable,
  instructionTable,
  economicEventCount: economicEvents.length,
}, null, 2));
