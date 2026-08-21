import { ORCA_WHIRLPOOL_PROGRAM_ID, ParsableWhirlpool, PriceMath } from "@orca-so/whirlpools-sdk";
import { Connection, PublicKey } from "@solana/web3.js";

const [, , mintAText, mintBText, decimalsAText, decimalsBText] = process.argv;
if (!mintAText || !mintBText || decimalsAText === undefined || decimalsBText === undefined) {
  throw new Error("Usage: node query_orca_pair.mjs mintA mintB decimalsA decimalsB");
}
const mintA = new PublicKey(mintAText);
const mintB = new PublicKey(mintBText);
const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const accounts = await connection.getProgramAccounts(ORCA_WHIRLPOOL_PROGRAM_ID, { filters: [
  { memcmp: { offset: 101, bytes: mintA.toBase58() } },
  { memcmp: { offset: 181, bytes: mintB.toBase58() } },
] });
const rows = accounts.map(({ pubkey, account }) => {
  const pool = ParsableWhirlpool.parse(pubkey, account);
  return {
    address: pubkey.toBase58(),
    liquidity: pool.liquidity.toString(),
    feeRate: pool.feeRate,
    tickSpacing: pool.tickSpacing,
    tickCurrentIndex: pool.tickCurrentIndex,
    priceBPerA: PriceMath.sqrtPriceX64ToPrice(pool.sqrtPrice, Number(decimalsAText), Number(decimalsBText)).toString(),
    tokenVaultA: pool.tokenVaultA.toBase58(),
    tokenVaultB: pool.tokenVaultB.toBase58(),
  };
}).sort((a, b) => BigInt(a.liquidity) > BigInt(b.liquidity) ? -1 : 1);
console.log(JSON.stringify(rows, null, 2));
