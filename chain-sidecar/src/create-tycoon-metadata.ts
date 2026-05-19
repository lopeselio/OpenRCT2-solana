// One-shot: invoke create_park_metadata on the deployed program to attach
// Metaplex Token Metadata (name=Tycoon, symbol=TYCOON, uri=<pinned JSON>)
// to the existing $PARK mint at 7vBp2RpMtfpjexC8z7sWV4nUFHNNskQQBxGrRkfSUYN1.
//
// Usage:
//   cd chain-sidecar
//   npx ts-node src/create-tycoon-metadata.ts
//
// Idempotent at the Metaplex layer: re-running once metadata exists fails with
// "account already in use" — that's expected.

import "dotenv/config";
import * as path from "path";
import * as fs from "fs";
import { PublicKey } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import { baseProvider, signer } from "./solana/clients";
import { parkMintPda, PROGRAM_ID } from "./solana/accounts";

const METAPLEX_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

const NAME = "Tycoon";
const SYMBOL = "TYCOON";
const URI =
  "https://bronze-disabled-tyrannosaurus-480.mypinata.cloud/ipfs/bafkreibf2dkunoazcxn6btb5z6r5p5v64qcoy7rhf5evkiqwmpzsdzgbfe";

function metadataPda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METAPLEX_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METAPLEX_PROGRAM_ID
  );
}

async function main() {
  const idl = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../../target/idl/solana_city.json"),
      "utf8"
    )
  );
  const program = new Program(idl, baseProvider);

  const [mint] = parkMintPda();
  const [metadata] = metadataPda(mint);

  console.log("Program:", PROGRAM_ID.toBase58());
  console.log("Wallet :", signer.publicKey.toBase58());
  console.log("Mint   :", mint.toBase58());
  console.log("Meta   :", metadata.toBase58());
  console.log(`Setting metadata: name=${NAME} symbol=${SYMBOL}`);
  console.log(`URI    : ${URI}\n`);

  const existing = await baseProvider.connection.getAccountInfo(metadata);
  if (existing !== null) {
    console.log("Metadata account already exists — nothing to do.");
    console.log(
      `View: https://explorer.solana.com/address/${mint.toBase58()}?cluster=devnet`
    );
    return;
  }

  const sig = await program.methods
    .createParkMetadata(NAME, SYMBOL, URI)
    .accounts({
      payer: signer.publicKey,
      metadata,
      metaplexProgram: METAPLEX_PROGRAM_ID,
    })
    .rpc({ commitment: "confirmed" });

  console.log("Tx signature:", sig);
  console.log(
    `View: https://explorer.solana.com/tx/${sig}?cluster=devnet`
  );
  console.log(
    `Mint: https://explorer.solana.com/address/${mint.toBase58()}?cluster=devnet`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
