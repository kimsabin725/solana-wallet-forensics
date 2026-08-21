import { Connection, PublicKey } from "@solana/web3.js";

const mints = process.argv.slice(2);
if (!mints.length) throw new Error("Pass one or more mint addresses");
const metadataProgram = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const pdas = mints.map((mint) => PublicKey.findProgramAddressSync([
  Buffer.from("metadata"), metadataProgram.toBuffer(), new PublicKey(mint).toBuffer(),
], metadataProgram)[0]);
const infos = await connection.getMultipleAccountsInfo(pdas);

function readRustString(buffer, offset) {
  const length = buffer.readUInt32LE(offset);
  const start = offset + 4;
  return { value: buffer.subarray(start, start + length).toString("utf8").replace(/\0+$/g, "").trim(), offset: start + length };
}
function decode(buffer) {
  let offset = 1 + 32 + 32;
  const name = readRustString(buffer, offset); offset = name.offset;
  const symbol = readRustString(buffer, offset); offset = symbol.offset;
  const uri = readRustString(buffer, offset);
  return { name: name.value, symbol: symbol.value, uri: uri.value };
}
const output = mints.map((mint, index) => ({ mint, metadataPda: pdas[index].toBase58(), ...(infos[index] ? decode(infos[index].data) : { metadata: null }) }));
console.log(JSON.stringify(output, null, 2));
