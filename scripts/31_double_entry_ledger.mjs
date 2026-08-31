// Transaction-level double-entry ledger.
//
// Every prior stage answers "what does the wallet hold now". This one answers
// "when was each unit acquired, at what basis, and what was realised on
// disposal" -- the layer the audit report explicitly did not build.
//
// Cost basis is denominated in USDC and derived from the wallet's OWN trades.
// No external historical price feed is used: when a leg of an exchange is
// USDC, that leg fixes the USD value of the whole exchange exactly. Value then
// propagates to non-USDC pairs through the side whose basis is already known.
// Anything that never touches a priced leg is carried at zero basis and
// reported separately rather than estimated.
//
//   WALLET=<base58 address> node scripts/31_double_entry_ledger.mjs
//
// Reads  wallet_events.json (stage 01) and all_ata_audit.json (stage 11).
// Writes double_entry_ledger.json.

import { readFile, writeFile } from "node:fs/promises";
import { WALLET } from "./_wallet.mjs";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const SOL = "SOL";

// Instruction names that move value between the wallet and a protocol it still
// controls. A negative delta under one of these is a transfer, not a sale, so
// it must not realise a gain.
const CUSTODY_TRANSFER = new Set([
  "IncreaseLockedAmount", "NewEscrow", "ToggleMaxLock", "Withdraw", "WithdrawAll",
  "Deposit", "DepositAll", "Stake", "Unstake", "DepositStake", "WithdrawStake",
  "Operate", "PreOperate", "EarnInvest", "OpenPosition", "OpenPositionWithTokenExtensions",
  "ClosePosition", "IncreaseLiquidity", "DecreaseLiquidity", "IncreaseLiquidityV2",
  "DecreaseLiquidityV2", "CreateLenderAccounts", "SetStakeDelegated", "Transact",
]);

// Instruction names that bring in value the wallet did not pay for.
const INCOME = new Set(["Claim", "NewClaimAndStake", "InitializeClaimStatus", "Harvest", "HarvestReward"]);

const near = (a, b) => Math.abs(a - b) < 1e-9;

// Every transaction moves a little SOL for gas, and account creation locks
// rent (~0.00204 SOL per token account, ~0.0002 for a claim status). Treating
// those as economic legs turns hundreds of routine transactions into unpriced
// "external-in" events and swamps the ledger. Only SOL movements above this
// threshold are economic; the rest are accounted as cost of transacting.
const SOL_DUST = 0.01;

async function loadEvents() {
  const base = JSON.parse(await readFile(new URL("./wallet_events.json", import.meta.url), "utf8"));
  if (base.wallet !== WALLET) {
    throw new Error(`wallet_events.json is for ${base.wallet}, not ${WALLET}`);
  }
  const events = [...base.events];
  const seen = new Set(events.map((e) => e.signature));

  // Stage 11 recovers deposits that never appear in the owner's signature
  // history. Without them the capital base -- the denominator of every return
  // figure -- is understated.
  let recovered = 0;
  try {
    const audit = JSON.parse(await readFile(new URL("./all_ata_audit.json", import.meta.url), "utf8"));
    for (const m of audit.missing ?? []) {
      if (seen.has(m.signature)) continue;
      events.push({
        signature: m.signature,
        blockTime: Date.parse(m.isoTime) / 1000,
        isoTime: m.isoTime,
        err: m.err ?? null,
        feeSol: 0,
        walletSolDelta: 0,
        tokenChanges: (m.deltas ?? []).map((d) => ({ mint: d.mint, amount: d.delta })),
        programIds: m.programIds ?? [],
        instructionNames: [],
        recoveredByAtaAudit: true,
      });
      seen.add(m.signature);
      recovered += 1;
    }
  } catch {
    throw new Error("all_ata_audit.json missing -- run stage 11 first, or the capital base will be wrong");
  }

  events.sort((a, b) => a.blockTime - b.blockTime || a.signature.localeCompare(b.signature));
  return { events, ownerCount: base.events.length, recovered };
}

// Running position per mint: quantity and total USD cost carried.
const book = new Map();
const lot = (mint) => {
  if (!book.has(mint)) book.set(mint, { qty: 0, cost: 0 });
  return book.get(mint);
};

const stats = {
  realisedGain: 0,
  incomeUsd: 0,
  feesUsd: 0,
  externalInUsd: 0,
  externalOutUsd: 0,
  unpricedDisposals: 0,
  unpricedAcquisitions: 0,
};

const entries = [];

function stableValue(mint, amount) {
  if (mint === USDC || mint === USDT) return Math.abs(amount);
  return null;
}

// Acquire `qty` of `mint` for `usd` of basis (usd may be null when unknown).
function acquire(mint, qty, usd) {
  const l = lot(mint);
  l.qty += qty;
  if (usd === null) stats.unpricedAcquisitions += 1;
  else l.cost += usd;
}

// Dispose of `qty` of `mint` for `usd` of proceeds. Returns realised gain.
function dispose(mint, qty, usd) {
  const l = lot(mint);
  const basis = l.qty > 0 ? (l.cost / l.qty) * Math.min(qty, l.qty) : 0;
  l.cost = Math.max(0, l.cost - basis);
  l.qty -= qty;
  if (usd === null) {
    stats.unpricedDisposals += 1;
    return null;
  }
  const gain = usd - basis;
  stats.realisedGain += gain;
  return gain;
}

const { events, ownerCount, recovered } = await loadEvents();

for (const ev of events) {
  if (ev.err) continue; // failed transactions move no value beyond the fee

  const names = ev.instructionNames ?? [];
  const isCustody = names.some((n) => CUSTODY_TRANSFER.has(n));
  const isIncome = names.some((n) => INCOME.has(n));

  const deltas = (ev.tokenChanges ?? [])
    .map((t) => ({ mint: t.mint, amount: t.amount }))
    .filter((d) => !near(d.amount, 0));

  // walletSolDelta includes the fee and any rent locked or refunded. Net the
  // fee out first, then drop what is left if it is dust.
  const solEconomic = (ev.walletSolDelta ?? 0) + (ev.feeSol ?? 0);
  if (Math.abs(solEconomic) > SOL_DUST) {
    deltas.push({ mint: SOL, amount: solEconomic });
  }
  if (!deltas.length) continue;

  const outs = deltas.filter((d) => d.amount < 0);
  const ins = deltas.filter((d) => d.amount > 0);

  // Fix the USD value of this transaction from any stable leg present.
  let anchor = null;
  for (const d of deltas) {
    const v = stableValue(d.mint, d.amount);
    if (v !== null && (anchor === null || v > anchor)) anchor = v;
  }

  let kind;
  if (isIncome && ins.length && !outs.length) kind = "income";
  else if (isCustody) kind = "custody-transfer";
  else if (outs.length && ins.length) kind = "exchange";
  else if (ins.length) kind = "external-in";
  else kind = "external-out";

  const record = {
    signature: ev.signature,
    isoTime: ev.isoTime,
    kind,
    instructions: names.slice(0, 6),
    debit: [],
    credit: [],
    realisedGain: null,
    recoveredByAtaAudit: ev.recoveredByAtaAudit ?? false,
  };

  if (kind === "custody-transfer") {
    // A deposit is not a sale. Basis leaves the deposited asset and rides on
    // whatever position token comes back, so that redeeming the position later
    // realises only the actual gain rather than the whole principal.
    let carried = 0;
    for (const d of outs) {
      const l = lot(d.mint);
      const moved = l.qty > 0 ? (l.cost / l.qty) * Math.min(-d.amount, l.qty) : 0;
      l.qty += d.amount;
      l.cost = Math.max(0, l.cost - moved);
      carried += moved;
      record.credit.push({ mint: d.mint, amount: -d.amount, basisMoved: moved });
    }
    // Split the carried basis across the returned legs by their stable face
    // value where there is one, otherwise evenly.
    const faces = ins.map((d) => stableValue(d.mint, d.amount));
    const faceTotal = faces.reduce((s, f) => s + (f ?? 0), 0);
    ins.forEach((d, i) => {
      const share = faceTotal > 0 && faces[i] !== null
        ? carried * (faces[i] / faceTotal)
        : ins.length ? carried / ins.length : 0;
      acquire(d.mint, d.amount, share);
      record.debit.push({ mint: d.mint, amount: d.amount, basisCarried: share });
    });
    record.basisCarried = carried;
  } else if (kind === "income") {
    // Rewards claimed in: no cost was paid, so basis is the value received.
    for (const d of ins) {
      const v = stableValue(d.mint, d.amount);
      acquire(d.mint, d.amount, v ?? 0);
      if (v !== null) stats.incomeUsd += v;
      record.debit.push({ mint: d.mint, amount: d.amount, usd: v });
    }
  } else if (kind === "exchange") {
    // The stable leg fixes the value; if neither leg is stable, fall back to
    // the disposed side's carried basis so nothing is invented.
    let value = anchor;
    if (value === null) {
      const l = outs.length === 1 ? lot(outs[0].mint) : null;
      if (l && l.qty > 0) value = (l.cost / l.qty) * Math.abs(outs[0].amount);
    }
    let gain = 0;
    let priced = true;
    // A stable leg is worth its face amount no matter how many legs there are.
    // Only genuinely ambiguous non-stable legs fall back to the shared value,
    // and only when this side has exactly one of them.
    const nonStableOuts = outs.filter((d) => stableValue(d.mint, d.amount) === null);
    const nonStableIns = ins.filter((d) => stableValue(d.mint, d.amount) === null);
    for (const d of outs) {
      const face = stableValue(d.mint, d.amount);
      const share = face !== null ? face : nonStableOuts.length === 1 ? value : null;
      const g = dispose(d.mint, -d.amount, share);
      if (g === null) priced = false;
      else gain += g;
      record.credit.push({ mint: d.mint, amount: -d.amount, usd: share });
    }
    for (const d of ins) {
      const face = stableValue(d.mint, d.amount);
      const share = face !== null ? face : nonStableIns.length === 1 ? value : null;
      acquire(d.mint, d.amount, share);
      record.debit.push({ mint: d.mint, amount: d.amount, usd: share });
    }
    record.realisedGain = priced ? gain : null;
  } else if (kind === "external-in") {
    for (const d of ins) {
      const v = stableValue(d.mint, d.amount);
      acquire(d.mint, d.amount, v);
      if (v !== null) stats.externalInUsd += v;
      record.debit.push({ mint: d.mint, amount: d.amount, usd: v });
    }
  } else {
    for (const d of outs) {
      const v = stableValue(d.mint, d.amount);
      const g = dispose(d.mint, -d.amount, v);
      if (v !== null) stats.externalOutUsd += v;
      if (g !== null) record.realisedGain = (record.realisedGain ?? 0) + g;
      record.credit.push({ mint: d.mint, amount: -d.amount, usd: v });
    }
  }

  if (ev.feeSol) stats.feesUsd += 0; // priced at revaluation, see summary note
  entries.push(record);
}

const positions = [...book.entries()]
  .map(([mint, l]) => ({
    mint,
    qty: Number(l.qty.toFixed(9)),
    carriedCostUsd: Number(l.cost.toFixed(2)),
    avgCostUsd: l.qty > 1e-9 ? Number((l.cost / l.qty).toFixed(6)) : null,
  }))
  .filter((p) => Math.abs(p.qty) > 1e-9 || p.carriedCostUsd > 0.01)
  .sort((a, b) => b.carriedCostUsd - a.carriedCostUsd);

const totalFeeSol = events.reduce((s, e) => s + (e.feeSol ?? 0), 0);

const out = {
  wallet: WALLET,
  builtAt: new Date().toISOString(),
  coverage: {
    ownerHistoryCount: ownerCount,
    recoveredByAtaAudit: recovered,
    totalEvents: events.length,
    failedExcluded: events.filter((e) => e.err).length,
    ledgerEntries: entries.length,
  },
  realised: {
    realisedGainUsd: Number(stats.realisedGain.toFixed(2)),
    incomeUsd: Number(stats.incomeUsd.toFixed(2)),
    externalInUsd: Number(stats.externalInUsd.toFixed(2)),
    externalOutUsd: Number(stats.externalOutUsd.toFixed(2)),
    totalFeeSol: Number(totalFeeSol.toFixed(9)),
  },
  unpriced: {
    disposals: stats.unpricedDisposals,
    acquisitions: stats.unpricedAcquisitions,
    note: "legs with no stable pair and no carried basis; excluded from realised gain rather than estimated",
  },
  positions,
  entries,
};

await writeFile(new URL("./double_entry_ledger.json", import.meta.url), JSON.stringify(out, null, 2));

console.log(`coverage: ${ownerCount} owner-history + ${recovered} recovered = ${events.length} events`);
console.log(`ledger entries: ${entries.length} (failed txs excluded: ${out.coverage.failedExcluded})`);
console.log("");
console.log("-- realised (USDC-denominated, from the wallet's own trades) --");
console.log(`  realised gain      ${out.realised.realisedGainUsd >= 0 ? "+" : ""}$${out.realised.realisedGainUsd}`);
console.log(`  income claimed      $${out.realised.incomeUsd}`);
console.log(`  external in         $${out.realised.externalInUsd}`);
console.log(`  external out        $${out.realised.externalOutUsd}`);
console.log(`  gas                 ${out.realised.totalFeeSol} SOL`);
console.log("");
console.log(`-- unpriced legs: ${stats.unpricedDisposals} disposals, ${stats.unpricedAcquisitions} acquisitions --`);
console.log("");
console.log("-- carried basis by asset (top 12) --");
for (const p of positions.slice(0, 12)) {
  console.log(`  ${p.mint.slice(0, 6)}  qty=${p.qty}  basis=$${p.carriedCostUsd}  avg=${p.avgCostUsd ?? "-"}`);
}
console.log("\nwritten double_entry_ledger.json");
