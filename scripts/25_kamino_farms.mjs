import { createSolanaRpc, address } from '@solana/kit';
import { Farms } from '@kamino-finance/farms-sdk';
import { Kamino } from '@kamino-finance/kliquidity-sdk';
import Decimal from 'decimal.js';
import { writeFile } from 'node:fs/promises';
import { WALLET } from "./_wallet.mjs";

const rpc = createSolanaRpc('https://api.mainnet-beta.solana.com');
const farms = new Farms(rpc);
const kamino = new Kamino('mainnet-beta', rpc);
const wallet = address(WALLET);

const states = await farms.getAllUserStatesForUser(wallet);
const farmStates = await farms.getFarmStatesFromUserStates(states);
const liveUserFarms = await farms.getAllFarmsForUserMultiState(
  wallet,
  new Decimal(Math.floor(Date.now() / 1000)),
);

function clean(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (value && typeof value === 'object') {
    if (Array.isArray(value)) return value.map(clean);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]));
  }
  return value;
}

const farmByKey = new Map(farmStates.map((farm) => [farm.key, farm]));
const positions = [];
for (const user of states) {
  const farm = farmByKey.get(user.userState.farmState);
  if (!farm) continue;
  const decimals = Number(farm.farmState.token.decimals);
  const stake = await farms.getUserTokensInUndelegatedFarm(wallet, farm.key, decimals).catch(() => null);
  let sharePrice = null;
  if (farm.farmState.strategyId !== '11111111111111111111111111111111') {
    sharePrice = await kamino.getStrategySharePrice(farm.farmState.strategyId).catch(() => null);
  }
  positions.push({
    userState: user.key,
    farm: farm.key,
    delegated: user.userState.isFarmDelegated,
    stakeMint: farm.farmState.token.mint,
    decimals,
    strategyId: farm.farmState.strategyId,
    activeStakeScaled: user.userState.activeStakeScaled.toString(),
    stakeTokens: stake?.toString() ?? null,
    sharePriceUsd: sharePrice?.toString() ?? null,
    valueUsd: stake && sharePrice ? stake.mul(sharePrice).toString() : null,
    unclaimedRewardsRaw: user.userState.rewardsIssuedUnclaimed.map((amount) => amount.toString()),
    rewardMints: farm.farmState.rewardInfos.slice(0, Number(farm.farmState.numRewardTokens)).map((reward) => ({
      mint: reward.token.mint,
      decimals: reward.token.decimals.toString(),
    })),
  });
}

const result = { positions };
result.liveRewards = [...liveUserFarms.entries()].flatMap(([farmAddress, userFarms]) =>
  userFarms.map((userFarm) => ({
    farm: farmAddress,
    userState: userFarm.userStateAddress,
    rewards: userFarm.pendingRewards.map((reward) => ({
      mint: reward.rewardTokenMint,
      amount: reward.cumulatedPendingRewards.toString(),
    })),
  })),
);

await writeFile(new URL('./kamino_farms_snapshot.json', import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
