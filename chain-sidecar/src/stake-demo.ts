// One-shot CLI demonstrating the on-chain staking flow.
//
// Usage:
//   npm run stake-demo            # default: setup + stake 0.05 SOL on venue 999
//   npm run stake-demo -- status  # show position + vault state
//   npm run stake-demo -- claim   # mint accumulated TYCOON rewards (will be 0
//                                   on a phantom venue with no revenue)
//   npm run stake-demo -- unstake # withdraw all staked SOL + claim rewards
//
// The phantom venue (id=999) is registered on base and never delegated to the
// ER. That keeps the Anchor venue constraint happy (staking ixs require the
// venue PDA to be program-owned, not delegation-owned) while not disturbing
// any real ride/shop the player has placed.

import "dotenv/config";
import * as path from "path";
import * as fs from "fs";
import { BN, Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { baseProvider, signer } from "./solana/clients";
import { cityPda, parkMintPda, venuePda, PARK_ID, PROGRAM_ID } from "./solana/accounts";

const DEMO_VENUE_ID = parseInt(process.env.STAKE_DEMO_VENUE_ID ?? "999", 10);
const DEMO_VENUE_NAME = "Stake Demo Venue";
const DEFAULT_STAKE_LAMPORTS = Math.floor(0.05 * LAMPORTS_PER_SOL);

function vaultPda(venueId: number): [PublicKey, number] {
  const pBuf = Buffer.alloc(4); pBuf.writeUInt32LE(PARK_ID);
  const vBuf = Buffer.alloc(4); vBuf.writeUInt32LE(venueId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), pBuf, vBuf],
    PROGRAM_ID,
  );
}

function stakePositionPda(venueId: number, staker: PublicKey): [PublicKey, number] {
  const pBuf = Buffer.alloc(4); pBuf.writeUInt32LE(PARK_ID);
  const vBuf = Buffer.alloc(4); vBuf.writeUInt32LE(venueId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("stake"), pBuf, vBuf, staker.toBuffer()],
    PROGRAM_ID,
  );
}

async function ensureVenue(program: Program): Promise<PublicKey> {
  const [venue] = venuePda(DEMO_VENUE_ID);
  const info = await baseProvider.connection.getAccountInfo(venue);
  if (info !== null) {
    console.log(`[stake-demo] venue ${DEMO_VENUE_ID} already exists (${venue.toBase58()})`);
    return venue;
  }
  console.log(`[stake-demo] Registering phantom venue ${DEMO_VENUE_ID}…`);
  await program.methods
    .registerVenue(PARK_ID, DEMO_VENUE_ID, 0, DEMO_VENUE_NAME)
    .accounts({ payer: signer.publicKey })
    .rpc({ commitment: "confirmed" });
  console.log(`[stake-demo] Phantom venue created: ${venue.toBase58()}`);
  return venue;
}

async function ensureVault(program: Program): Promise<PublicKey> {
  const [vault] = vaultPda(DEMO_VENUE_ID);
  const info = await baseProvider.connection.getAccountInfo(vault);
  if (info !== null) {
    console.log(`[stake-demo] vault for venue ${DEMO_VENUE_ID} already exists (${vault.toBase58()})`);
    return vault;
  }
  console.log("[stake-demo] Creating stake vault…");
  await program.methods
    .createStakeVault(PARK_ID, DEMO_VENUE_ID)
    .accounts({ payer: signer.publicKey })
    .rpc({ commitment: "confirmed" });
  console.log(`[stake-demo] Vault created: ${vault.toBase58()}`);
  return vault;
}

async function showStatus(program: Program): Promise<void> {
  const [vault] = vaultPda(DEMO_VENUE_ID);
  const [position] = stakePositionPda(DEMO_VENUE_ID, signer.publicKey);
  const [venue] = venuePda(DEMO_VENUE_ID);

  const vaultInfo = await baseProvider.connection.getAccountInfo(vault);
  const positionInfo = await baseProvider.connection.getAccountInfo(position);
  const venueAcc: any = await (program.account as any).venueAccount.fetchNullable(venue);

  console.log("──────── Stake demo state ────────");
  console.log("Operator       :", signer.publicKey.toBase58());
  console.log("Venue PDA      :", venue.toBase58(), venueAcc ? "(exists)" : "(missing)");
  if (venueAcc) {
    console.log("  total_revenue:", venueAcc.totalRevenue.toString());
  }
  console.log("Vault PDA      :", vault.toBase58(), vaultInfo ? "(exists)" : "(missing)");
  if (vaultInfo) {
    const v: any = await (program.account as any).venueStakeVault.fetch(vault);
    console.log("  total_staked          :", v.totalStaked.toString(), "lamports");
    console.log("  acc_reward_per_token  :", v.accRewardPerToken.toString());
    console.log("  last_synced_revenue   :", v.lastSyncedRevenue.toString());
    console.log("  lamports (incl. stake):", vaultInfo.lamports);
  }
  console.log("Position PDA   :", position.toBase58(), positionInfo ? "(exists)" : "(missing)");
  if (positionInfo) {
    const p: any = await (program.account as any).stakePosition.fetch(position);
    console.log("  amount       :", p.amount.toString(), "lamports");
    console.log("  unclaimed    :", p.unclaimed.toString(), "TYCOON micro-units");
    console.log("  reward_debt  :", p.rewardDebt.toString());
  }
}

async function doStake(program: Program, amount: number): Promise<void> {
  const [vault] = vaultPda(DEMO_VENUE_ID);
  const [position] = stakePositionPda(DEMO_VENUE_ID, signer.publicKey);
  const [venue] = venuePda(DEMO_VENUE_ID);
  console.log(`[stake-demo] Staking ${amount} lamports (${amount / LAMPORTS_PER_SOL} SOL)…`);
  await program.methods
    .stake(PARK_ID, DEMO_VENUE_ID, new BN(amount))
    .accounts({
      staker: signer.publicKey,
      vault,
      position,
      venue,
      systemProgram: SystemProgram.programId,
    })
    .rpc({ commitment: "confirmed" });
  console.log("[stake-demo] Stake confirmed");
}

async function doClaim(program: Program): Promise<void> {
  const [vault] = vaultPda(DEMO_VENUE_ID);
  const [position] = stakePositionPda(DEMO_VENUE_ID, signer.publicKey);
  const [venue] = venuePda(DEMO_VENUE_ID);
  const [mint] = parkMintPda();
  const ata = getAssociatedTokenAddressSync(mint, signer.publicKey);
  console.log("[stake-demo] Claiming rewards…");
  await program.methods
    .claimStakeRewards(PARK_ID, DEMO_VENUE_ID)
    .accounts({
      staker: signer.publicKey,
      vault,
      position,
      venue,
      parkMint: mint,
      stakerAta: ata,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc({ commitment: "confirmed" });
  console.log("[stake-demo] Claim confirmed");
}

async function doUnstake(program: Program): Promise<void> {
  const [vault] = vaultPda(DEMO_VENUE_ID);
  const [position] = stakePositionPda(DEMO_VENUE_ID, signer.publicKey);
  const [venue] = venuePda(DEMO_VENUE_ID);
  const [mint] = parkMintPda();
  const ata = getAssociatedTokenAddressSync(mint, signer.publicKey);
  console.log("[stake-demo] Unstaking (returns SOL + claims any rewards)…");
  await program.methods
    .unstake(PARK_ID, DEMO_VENUE_ID)
    .accounts({
      staker: signer.publicKey,
      vault,
      position,
      venue,
      parkMint: mint,
      stakerAta: ata,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc({ commitment: "confirmed" });
  console.log("[stake-demo] Unstake confirmed");
}

async function main() {
  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../target/idl/solana_city.json"), "utf8"),
  );
  const program = new Program(idl, baseProvider);

  const cmd = process.argv[2] ?? "stake";

  switch (cmd) {
    case "stake":
      await ensureVenue(program);
      await ensureVault(program);
      await doStake(program, DEFAULT_STAKE_LAMPORTS);
      await showStatus(program);
      break;
    case "status":
      await showStatus(program);
      break;
    case "claim":
      await doClaim(program);
      await showStatus(program);
      break;
    case "unstake":
      await doUnstake(program);
      await showStatus(program);
      break;
    default:
      console.error(`Unknown command: ${cmd}. Usage: stake | status | claim | unstake`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
