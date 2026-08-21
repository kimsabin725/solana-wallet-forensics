import { Client } from "@jup-ag/lend-read";
import { Connection } from "@solana/web3.js";

const [, , vaultIdText, nftIdText, endpoint = "https://api.mainnet-beta.solana.com"] = process.argv;
if (!vaultIdText || !nftIdText) throw new Error("Usage: node query_jupiter_one_position.mjs <vaultId> <nftId> [rpc]");
const connection = new Connection(endpoint, "confirmed");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const originalRpcRequest = connection._rpcRequest.bind(connection);
let rpcQueue = Promise.resolve();
connection._rpcRequest = (method, args) => {
  const request = rpcQueue.then(() => sleep(900)).then(() => originalRpcRequest(method, args));
  rpcQueue = request.catch(() => undefined);
  return request;
};
const client = new Client(connection);
function replacer(_key, value) {
  if (typeof value === "bigint") return value.toString();
  if (value && typeof value.toBase58 === "function") return value.toBase58();
  if (value && value.constructor?.name === "BN") return value.toString();
  return value;
}
const result = await client.vault.getPositionByVaultId(Number(vaultIdText), Number(nftIdText));
console.log(JSON.stringify(result, replacer, 2));
