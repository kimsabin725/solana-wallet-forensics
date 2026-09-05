# solana-wallet-forensics

## 이게 뭔가요 (비개발자용) · What this is (non-technical)

**KR** — 저는 본업으로 펀드 손익을 관리합니다. 기초잔고 + 유입 − 유출 + 운용손익 = 현재잔고가 맞아떨어질 때까지 숫자를 보고하지 않는 일입니다.
같은 기준으로 제 솔라나 지갑(7개 프로토콜, 동시 포지션 12개)을 감사해 봤더니, 공식 도구가 세 군데서 틀린 숫자를 주고 있었습니다.

1. **지갑 주소로 거래를 조회하면 입금이 빠집니다.** 솔라나는 토큰이 지갑이 아니라 별도 토큰 계정에 들어가서, 기존 계정으로 들어온 입금 3건이 기본 조회에서 사라져 있었습니다. 투입 자본이 과소계상돼 수익률 분모가 틀렸습니다.
2. **스테이킹 잔고가 지갑 기록에 없습니다.** 보상이 지갑을 거치지 않고 락업 금고로 바로 들어가서, 금고 쪽 입금 이력으로 거꾸로 재구성해야 했습니다. 이전 분석의 단위 환산 오류 2건과 누락 1건이 여기서 드러났습니다.
3. **어떤 값은 아무 API도 알려주지 않습니다.** 폐기된 프로그램에 남은 대출의 누적 이자가 그랬습니다. 계정 원시 데이터를 직접 읽어 구조를 역추적하고, 같은 금고의 다른 포지션과 대조해 값을 확정했습니다.

이 저장소는 그 감사를 위해 만든 수집·검증·해석 스크립트입니다. **금액과 지갑 주소는 들어 있지 않습니다.** 손익 계산 계층은 포지션 규모가 드러나서 비공개입니다.
결론은 도구가 아니라 원칙입니다: 온체인으로 증명되지 않는 숫자는 주장하지 않는다.

**EN** — My day job is fund P&L: you do not report a number until opening + inflows − outflows + operating result = closing.
I audited my own Solana wallet (7 protocols, 12 concurrent positions) to that standard, and the official tooling was wrong in three places.

1. **Querying by wallet address misses deposits.** On Solana tokens live in separate token accounts, so three inbound transfers into existing accounts were invisible to the standard lookup. Capital in was understated and the return denominator was wrong.
2. **Staked balances leave no trail in the wallet.** Rewards go straight into a locked escrow without touching the wallet, so the balance had to be rebuilt from the vault's deposit history. That surfaced two unit-conversion errors and one omitted claim in an earlier analysis.
3. **Some values are exposed by no API at all.** Accrued interest on a loan in a deprecated program was one. I read the raw account bytes, reverse-engineered the layout, and pinned the value by cross-checking sibling positions on the same custody.

This repository is the collection, audit and decoding layer built for that audit. **No amounts and no wallet address are included**; the P&L layer stays private because it embeds position sizes.
The takeaway is a rule, not a tool: do not claim a number the chain cannot prove.

---

## Technical overview

Scripts for reconstructing a Solana wallet's complete economic position from raw chain data —
including the parts that RPC convenience methods and protocol APIs do not report.

Built while auditing one live wallet running 12 concurrent DeFi positions across 7 protocols.
Every number in the resulting report was produced by these scripts and verified against a balance identity.

> **Amounts are not in this repository.** The P&L layer is kept private because it embeds position sizes.
> What is published here is the collection, audit and decoding layer — the part that had to be figured out.

---

## Why this exists

Three problems came up that had no off-the-shelf answer.

### 1. Querying the wallet address misses deposits

On Solana, tokens live in separate token accounts; the wallet is only their *owner*. When someone transfers
into an **already-existing** token account, the transaction carries the sending and receiving token accounts
plus the sender's authority — the recipient's owner address need not appear at all.

So `getSignaturesForAddress(wallet)` silently omits those deposits. In the audited wallet this hid three
inbound transfers.

The fix is to enumerate every token account the wallet has *ever* controlled — current holdings **and
already-closed accounts**, derived across both Token and Token-2022 — and pull each one's full signature
history separately. `11_audit_all_token_accounts.mjs` does this and diffs the union against the
owner-history set.

### 2. Staked balances have no transaction trail in the wallet

Governance rewards can be claimed straight into a locked escrow without ever touching the wallet's token
account, so the wallet's own ledger under-reports the staked balance.

`15_rebuild_escrow_ledger.mjs` reconstructs the balance from the **escrow vault's** deposit history instead,
chronologically. On the audited wallet this reconciled to six decimal places and exposed two unit-conversion
errors and one omitted claim in a prior analysis.

### 3. Some values are exposed by no API at all

A loan sitting in a deprecated program had accrued interest that no endpoint reported. The position account
stores an interest-index snapshot taken at open, but the *current* index lives in a custody account whose
layout is undocumented.

The approach in `27`–`29`:

1. Reverse-engineer the position layout from raw bytes — walk aligned offsets looking for pubkey-shaped
   32-byte runs, plausible unix timestamps, and values already known from the opening transaction.
2. Scan the custody account for `u128` candidates in a plausible range above the snapshot.
3. Disambiguate by fetching **every sibling position on the same custody** via `getProgramAccounts` and
   reading the interest snapshot of the most recently updated one — a position updated seconds ago carries
   the current index by definition.

Cross-checking (2) against (3) pins the value exactly.

---

## Pipeline

Run in order; each stage writes JSON that later stages read.

| Stage | Script | Produces |
|---|---|---|
| Collect | `01_collect_transactions.mjs` | normalised transactions, token deltas, logs |
| | `02_summarize_transactions.mjs` | per-token / per-program rollups |
| Audit | `10_audit_usdc_ata.mjs` | single-account signature diff |
| | `11_audit_all_token_accounts.mjs` | exhaustive audit across every derived account |
| | `12_sweep_protocol_accounts.mjs` | protocol accounts holding wallet-owned value |
| | `13_trace_protocol_positions.mjs` | residual positions in minor protocols |
| | `14_audit_governance_escrow.mjs` | escrow discovery via `memcmp` on owner offset |
| | `15_rebuild_escrow_ledger.mjs` | staked balance rebuilt from vault deposits |
| Positions | `20`–`23` | lending position accounts, vault state, decoded collateral/debt, oracle prices |
| | `24`–`25` | obligation stats, farm stakes and unclaimed rewards |
| | `26` | CLMM position token amounts and accrued fees |
| | `27`–`29` | legacy borrow position, custody scan, interest-index back-solve |
| Snapshot | `30_revalue_snapshot.mjs` | single-slot balances + prices for valuation |
| Probes | `90`–`95` | exploratory one-offs kept for reference |

```bash
pnpm install
export WALLET=<base58 address of the wallet to audit>
node scripts/01_collect_transactions.mjs
node scripts/11_audit_all_token_accounts.mjs
# ... etc
```

Node 20+. The wallet under audit comes from the `WALLET` environment variable (`scripts/_wallet.mjs`);
the scripts refuse to run without it. The RPC endpoint is a constant at the top of each script and
defaults to the public `api.mainnet-beta.solana.com`, which is aggressively rate limited — point it at
a dedicated endpoint before running the collection stage over a busy wallet.

## Decoding notes

- **Lending position sizing** — collateral and debt are stored as *shares*, not token amounts. Debt shares
  are derived from a tick-indexed ratio (see the factor table in `22_lend_decode_positions.mjs`), then both
  are multiplied by the vault's exchange price. Vault accounting uses a protocol-wide fixed 9-decimal scale
  independent of the SPL mint's own decimals.
- **Oracle scale** — prices are fixed-point; divide by `1e15` regardless of the pair's decimals.
- **Stale vault state** — vault exchange prices update lazily on interaction. A vault untouched for days
  reports understated debt. Check `lastUpdateTimestamp` before trusting a derived balance.
- **Escrow layout** — `discriminator(8) | locker(32) | owner(32) | bump(1) | vault(32) | amount(u64) |
  startedAt(i64) | endsAt(i64) | voteDelegate(32) | isMaxLock(u8)`. Find escrows with a `memcmp` at offset 40.
- **LST yield** — SPL stake pool accounts store the previous epoch's total lamports and share supply.
  Dividing against the current ratio gives one epoch's realised gain. **Measure epoch length over RPC**
  rather than assuming it — the difference between a 2.0-day and 2.4-day assumption is a full point of APY,
  which was enough to flip the sign of a carry trade in the audited wallet.

## Verification discipline

- Every asset is checked against `opening + external in − external out + protocol delta = current`.
  Totals are not reported until each identity closes.
- Cost basis at transfer time is cross-checked against an independent price source, not the protocol's own.
- Final valuation fixes all oracles and price APIs to a **single slot** so unrelated assets are not
  compared across different moments.
- Where a value cannot be established — an illiquid token with no route, key custody of a shielded
  deposit — it is carried at cost and flagged rather than estimated.

## What is not here

The P&L, attribution, benchmark and scenario layer. Those scripts embed position sizes and cost bases, so
they are excluded. Their methodology is described above and in the audit report; only the arithmetic is missing.

No transaction-level double-entry ledger was built, so realised and unrealised P&L cannot be separated by
date. This does not affect balance-sheet totals, which are verified by the identity check above.

## License

MIT
