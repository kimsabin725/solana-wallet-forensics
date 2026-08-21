import { Connection, PublicKey } from "@solana/web3.js";
import { readFile, writeFile } from "node:fs/promises";

const raw = JSON.parse(await readFile(new URL("./jupiter_vault_raw_snapshot.json", import.meta.url), "utf8"));
const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const mints = [...new Set(raw.flatMap((x) => [x.vaultConfig.supplyToken, x.vaultConfig.borrowToken]))];
const mintAccounts = await connection.getMultipleAccountsInfo(mints.map((mint) => new PublicKey(mint)));
const decimals = Object.fromEntries(mints.map((mint, index) => [mint, mintAccounts[index]?.data?.[44] ?? null]));

const FACTORS = [
  18446744073709551616n, 18419115400608638658n, 18391528108445969703n, 18336477419114433396n,
  18226869890870665593n, 18009616477100071088n, 17582847377087825313n, 16759408633341240198n,
  15226414841393184936n, 12568272644527235157n, 8563108841104354677n, 3975055583337633975n,
  856577552520149366n, 39775317560084773n, 85764505686420n, 398745188n,
];
function ratioAtTick(tick) {
  const absTick = Math.abs(tick);
  let factor = FACTORS[0];
  if (absTick & 1) factor = FACTORS[1];
  for (let bit = 2, index = 2; index < FACTORS.length; bit <<= 1, index += 1) {
    if (absTick & bit) factor = (factor * FACTORS[index]) >> 64n;
  }
  let precision = 0n;
  if (tick > 0) {
    factor = ((2n ** 128n) - 1n) / factor;
    if (factor % 65536n !== 0n) precision = 1n;
  }
  return (factor >> 16n) + precision;
}
function fromHex(value) { return BigInt(`0x${value}`); }
function decimalString(rawAmount, tokenDecimals, precision = 9) {
  const scale = 10n ** BigInt(tokenDecimals);
  const whole = rawAmount / scale;
  const fraction = (rawAmount % scale).toString().padStart(tokenDecimals, "0").slice(0, precision).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

const positions = raw.map((entry) => {
  const supplyShares = fromHex(entry.position.supplyAmount);
  const dustBorrowShares = fromHex(entry.position.dustDebtAmount);
  const grossBorrowShares = (ratioAtTick(entry.position.tick) * supplyShares) >> 48n;
  const borrowShares = grossBorrowShares > dustBorrowShares ? grossBorrowShares - dustBorrowShares : 0n;
  const supplyRaw = (supplyShares * fromHex(entry.vaultState.vaultSupplyExchangePrice)) / 1_000_000_000_000n;
  const borrowRaw = (borrowShares * fromHex(entry.vaultState.vaultBorrowExchangePrice)) / 1_000_000_000_000n;
  const supplyDecimals = decimals[entry.vaultConfig.supplyToken];
  const borrowDecimals = decimals[entry.vaultConfig.borrowToken];
  return {
    nftMint: entry.nftMint,
    vaultId: entry.position.vaultId,
    nftId: entry.position.nftId,
    supplyMint: entry.vaultConfig.supplyToken,
    borrowMint: entry.vaultConfig.borrowToken,
    supplyDecimals,
    borrowDecimals,
    supplyRaw: supplyRaw.toString(),
    borrowRaw: borrowRaw.toString(),
    // Jupiter's vault accounting amounts use a protocol-wide fixed 9-decimal
    // scale, independent of the SPL mint decimals.
    supplyAmount: decimalString(supplyRaw, 9),
    borrowAmount: decimalString(borrowRaw, 9),
    collateralFactor: entry.vaultConfig.collateralFactor / 1000,
    liquidationThreshold: entry.vaultConfig.liquidationThreshold / 1000,
    tick: entry.position.tick,
    liquidated: entry.tickData?.isLiquidated === 1,
    lastUpdateTimestamp: Number(fromHex(entry.vaultState.lastUpdateTimestamp)),
  };
});

await writeFile(new URL("./jupiter_positions_calculated.json", import.meta.url), JSON.stringify({ decimals, positions }, null, 2));
console.log(JSON.stringify({ decimals, positions }, null, 2));
