// The audited wallet address. Supplied at run time so the scripts are not
// bound to one wallet -- set WALLET before running anything under scripts/.
//
//   WALLET=<base58 address> node scripts/01_collect_transactions.mjs

const value = process.env.WALLET;

if (!value) {
  throw new Error(
    "WALLET is not set. Export the base58 address of the wallet to audit, e.g.\n" +
      "  export WALLET=<base58 address>"
  );
}

export const WALLET = value;
