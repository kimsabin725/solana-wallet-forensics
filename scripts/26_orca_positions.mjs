import {
  WhirlpoolContext,
  buildWhirlpoolClient,
  getAllPositionAccountsByOwner,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  PoolUtil,
  PriceMath,
  TokenExtensionUtil,
  collectFeesQuote,
} from "@orca-so/whirlpools-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import { writeFile } from "node:fs/promises";
import { WALLET } from "./_wallet.mjs";

const rpc = "https://api.mainnet-beta.solana.com";
const owner = new PublicKey(WALLET);
const connection = new Connection(rpc, "confirmed");
const readOnlyWallet = {
  publicKey: owner,
  async signTransaction() { throw new Error("read-only"); },
  async signAllTransactions() { throw new Error("read-only"); },
};
const ctx = WhirlpoolContext.from(connection, readOnlyWallet, undefined, undefined, undefined, ORCA_WHIRLPOOL_PROGRAM_ID);
const client = buildWhirlpoolClient(ctx);

async function mintInfo(mint) {
  const response = await connection.getParsedAccountInfo(mint, "confirmed");
  const parsed = response.value?.data?.parsed?.info;
  return { mint: mint.toBase58(), decimals: parsed?.decimals ?? null, supply: parsed?.supply ?? null };
}

const owned = await getAllPositionAccountsByOwner({
  ctx,
  owner,
  includesPositions: true,
  includesPositionsWithTokenExtensions: true,
  includesBundledPositions: true,
});
const entries = [...owned.positions.entries(), ...owned.positionsWithTokenExtensions.entries()];
const output = [];

for (const [address] of entries) {
  const position = await client.getPosition(address);
  const positionData = position.getData();
  const poolData = position.getWhirlpoolData();
  const mintA = await mintInfo(poolData.tokenMintA);
  const mintB = await mintInfo(poolData.tokenMintB);
  const amounts = PoolUtil.getTokenAmountsFromLiquidity(
    positionData.liquidity,
    poolData.sqrtPrice,
    PriceMath.tickIndexToSqrtPriceX64(positionData.tickLowerIndex),
    PriceMath.tickIndexToSqrtPriceX64(positionData.tickUpperIndex),
    false,
  );
  const tokenExtensionCtx = await TokenExtensionUtil.buildTokenExtensionContextForPool(
    ctx.fetcher,
    poolData.tokenMintA,
    poolData.tokenMintB,
  );
  const fees = collectFeesQuote({
    whirlpool: poolData,
    position: positionData,
    tickLower: position.getLowerTickData(),
    tickUpper: position.getUpperTickData(),
    tokenExtensionCtx,
  });
  output.push({
    positionAddress: address,
    positionMint: positionData.positionMint.toBase58(),
    whirlpool: positionData.whirlpool.toBase58(),
    tickCurrentIndex: poolData.tickCurrentIndex,
    tickLowerIndex: positionData.tickLowerIndex,
    tickUpperIndex: positionData.tickUpperIndex,
    status: poolData.tickCurrentIndex < positionData.tickLowerIndex ? "below" : poolData.tickCurrentIndex >= positionData.tickUpperIndex ? "above" : "in-range",
    liquidity: positionData.liquidity.toString(),
    tokenA: {
      ...mintA,
      amountRaw: amounts.tokenA.toString(),
      amount: Number(amounts.tokenA.toString()) / 10 ** mintA.decimals,
      feesRaw: fees.feeOwedA.toString(),
      fees: Number(fees.feeOwedA.toString()) / 10 ** mintA.decimals,
    },
    tokenB: {
      ...mintB,
      amountRaw: amounts.tokenB.toString(),
      amount: Number(amounts.tokenB.toString()) / 10 ** mintB.decimals,
      feesRaw: fees.feeOwedB.toString(),
      fees: Number(fees.feeOwedB.toString()) / 10 ** mintB.decimals,
    },
    priceBPerA: PriceMath.sqrtPriceX64ToPrice(poolData.sqrtPrice, mintA.decimals, mintB.decimals).toString(),
  });
}

await writeFile(new URL("./orca_positions_snapshot.json", import.meta.url), JSON.stringify(output, null, 2));
console.log(JSON.stringify({
  regularPositions: owned.positions.size,
  tokenExtensionPositions: owned.positionsWithTokenExtensions.size,
  bundles: owned.positionBundles.length,
  positions: output,
}, null, 2));
