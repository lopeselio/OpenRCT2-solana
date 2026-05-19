// Scans recent transactions on the MagicBlock ER for the solana-city program
// and prints any that errored, with the tail of each tx's program logs.
//
// Usage:
//   npx ts-node src/check-er-failures.ts            # last 100 txs on ER
//   npx ts-node src/check-er-failures.ts base       # check base layer instead
//   npx ts-node src/check-er-failures.ts er 500     # last 500 txs

import "dotenv/config";
import { erConnection, baseConnection } from "./solana/clients";
import { PROGRAM_ID } from "./solana/accounts";

async function main() {
  const layerArg = (process.argv[2] ?? "er").toLowerCase();
  const limit = parseInt(process.argv[3] ?? "100", 10);
  const conn = layerArg === "base" ? baseConnection : erConnection;
  const layer = layerArg === "base" ? "BASE (devnet)" : "ER (MagicBlock devnet)";

  console.log(`Scanning ${limit} recent txs on ${layer} for program ${PROGRAM_ID.toBase58()}\n`);

  const sigs = await conn.getSignaturesForAddress(PROGRAM_ID, { limit });
  const failed = sigs.filter((s) => s.err !== null);

  console.log(`Found ${failed.length} failed of ${sigs.length} total\n`);
  if (failed.length === 0) return;

  for (const f of failed) {
    const tx = await conn.getTransaction(f.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    const logs = tx?.meta?.logMessages ?? [];
    const errLines = logs.filter((l) => /err|fail|panic/i.test(l));
    const instrLine = logs.find((l) => l.includes("Instruction:"));

    console.log(`${f.signature}`);
    console.log(`  slot=${f.slot}  blockTime=${f.blockTime}  err=${JSON.stringify(f.err)}`);
    if (instrLine) console.log(`  ${instrLine}`);
    for (const line of errLines.slice(0, 4)) console.log(`  ${line}`);
    console.log();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
