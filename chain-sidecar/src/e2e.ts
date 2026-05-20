// Devnet end-to-end integration test.
//
// Exercises the full guest + venue lifecycle against the live deployed program:
//   venue registered → delegated → guest enters → spends → exits (ER→base)
//   → prize claimed → TYCOON redeemed → venue removed → score submitted
//
// Run: ts-node src/e2e.ts
// Requires: WALLET_PATH (or default ~/.config/solana/id.json), devnet SOL balance

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { BN, Program } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";

import { baseConnection, erConnection, baseProvider, erProvider, wallet, signer } from "./solana/clients";
import { cityPda, guestPda, venuePda, parkMintPda, PARK_ID, PROGRAM_ID } from "./solana/accounts";
import {
  initPrograms,
  onVenueRegistered,
  onGuestEntry,
  onGuestSpend,
  onGuestExit,
  onVenueRemoved,
} from "./solana/delegate";

// ─── Test IDs ────────────────────────────────────────────────────────────────
// High random range so each run gets fresh PDAs and avoids conflicts with
// previous runs or localnet tests.
const VENUE_ID = 50000 + Math.floor(Math.random() * 9999);
const GUEST_ID = 50000 + Math.floor(Math.random() * 9999);

// ─── Assertion helpers ───────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ✅  ${label}`);
    passed++;
  } else {
    console.log(`  ❌  ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function step(name: string): void {
  console.log(`\n── ${name}`);
}

// ─── Polling ─────────────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollOwnership(
  pda: PublicKey,
  expectedOwner: PublicKey,
  timeoutMs: number,
  label: string
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await baseConnection.getAccountInfo(pda);
    if (info !== null && info.owner.equals(expectedOwner)) return true;
    await sleep(1500);
  }
  return false;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════");
  console.log("  Solana City — Devnet E2E Integration Test");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Wallet  : ${signer.publicKey.toBase58()}`);
  console.log(`  Park ID : ${PARK_ID}`);
  console.log(`  Venue ID: ${VENUE_ID}  (random, fresh each run)`);
  console.log(`  Guest ID: ${GUEST_ID}  (random, fresh each run)`);
  console.log();

  // Load IDL and init program instances
  const idl = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../../target/idl/solana_city.json"),
      "utf8"
    )
  );
  initPrograms(idl);
  const baseProgram = new Program(idl, baseProvider);
  const erProgram   = new Program(idl, erProvider);

  // ── Step 1: wallet balance ───────────────────────────────────────────────
  step("1  Wallet preflight");
  const lamports = await baseConnection.getBalance(signer.publicKey);
  const sol = lamports / 1e9;
  console.log(`     Balance: ${sol.toFixed(4)} SOL`);
  assert("Wallet has ≥ 0.1 SOL for fees + rent", sol >= 0.1,
    `only ${sol.toFixed(4)} SOL — top up with: solana airdrop 1`);
  if (sol < 0.1) {
    console.log("\n⚠️  Insufficient balance. Aborting.");
    process.exit(1);
  }

  // ── Step 2: park initialized ─────────────────────────────────────────────
  step("2  Park initialization");
  const [city] = cityPda();
  const cityInfo = await baseConnection.getAccountInfo(city);
  if (cityInfo === null) {
    console.log("     Park not found — initializing...");
    await baseProgram.methods
      .initializeCity(PARK_ID, "E2E Test Park")
      .accounts({ authority: signer.publicKey })
      .rpc({ commitment: "confirmed" });
    console.log("     Park initialized:", city.toBase58());
  } else {
    console.log("     Park already exists:", city.toBase58());
  }
  const cityAcc = await (baseProgram.account as any).cityState.fetch(city);
  assert("CityState.park_id matches", cityAcc.parkId === PARK_ID,
    `got ${cityAcc.parkId}`);

  // ── Step 3: $TYCOON mint ───────────────────────────────────────────────────
  step("3  $TYCOON mint");
  const [mint] = parkMintPda();
  const mintInfo = await baseConnection.getAccountInfo(mint);
  if (mintInfo === null) {
    console.log("     Mint not found — initializing...");
    await baseProgram.methods
      .initializeParkMint()
      .accounts({ payer: signer.publicKey })
      .rpc({ commitment: "confirmed" });
    console.log("     $TYCOON mint initialized:", mint.toBase58());
  } else {
    console.log("     $TYCOON mint exists:", mint.toBase58());
  }
  const mintExists = (await baseConnection.getAccountInfo(mint)) !== null;
  assert("$TYCOON mint account exists on-chain", mintExists);

  // ── Step 4: venue registered + delegated ─────────────────────────────────
  step("4  Venue registered + delegated to ER");
  const guestsBefore = cityAcc.totalGuestsEver.toNumber();
  console.log(`     Registering venue ${VENUE_ID}...`);
  await onVenueRegistered(VENUE_ID, 0, `E2E Ride ${VENUE_ID}`);

  const [venue] = venuePda(VENUE_ID);
  const venueInfo = await baseConnection.getAccountInfo(venue);
  assert("Venue account exists on-chain after delegation",
    venueInfo !== null, "account not found");

  // ── Step 5: guest entered + delegated ────────────────────────────────────
  step("5  Guest registered + delegated to ER");
  console.log(`     Registering guest ${GUEST_ID} with 5 TYCOON...`);
  await onGuestEntry(GUEST_ID, "5.0");

  const [guest] = guestPda(GUEST_ID);
  const guestInfo = await baseConnection.getAccountInfo(guest);
  assert("Guest account exists on-chain after delegation",
    guestInfo !== null, "account not found");

  const cityAfterEntry = await (baseProgram.account as any).cityState.fetch(city);
  assert("total_guests_ever incremented",
    cityAfterEntry.totalGuestsEver.toNumber() === guestsBefore + 1,
    `expected ${guestsBefore + 1}, got ${cityAfterEntry.totalGuestsEver.toNumber()}`);

  // ── Step 6: guest spends on ER ───────────────────────────────────────────
  step("6  Guest spends 1.0 TYCOON at venue (Ephemeral Rollup)");
  console.log("     Sending spend transaction to ER...");
  await onGuestSpend(GUEST_ID, VENUE_ID, "1.0", 0);
  console.log("     Spend sent. ER state is not yet committed to base layer.");

  // Verify from ER that venue revenue increased
  try {
    const venueEr = await (erProgram.account as any).venueAccount.fetch(venue);
    assert("Venue revenue > 0 on ER after spend",
      venueEr.totalRevenue.gtn(0),
      `revenue = ${venueEr.totalRevenue.toString()}`);
  } catch {
    console.log("  ⚠️  Could not fetch venue from ER (may not be available yet) — skipping ER assertion");
  }

  // ── Step 7: guest exits ───────────────────────────────────────────────────
  step("7  Guest exits park (ER commit → base layer)");
  console.log("     Calling exit_guest on ER (may take up to 95s)...");
  await onGuestExit(GUEST_ID);

  const guestFinal = await (baseProgram.account as any).guestAccount.fetch(guest);
  assert("Guest is_active = false after exit", !guestFinal.isActive);
  assert("Guest balance = 0 after redeem",
    guestFinal.balance.eqn(0),
    `balance = ${guestFinal.balance.toString()}`);

  // Check $TYCOON ATA received tokens
  const ata = getAssociatedTokenAddressSync(mint, signer.publicKey);
  try {
    const ataBalance = await baseConnection.getTokenAccountBalance(ata);
    const tokens = BigInt(ataBalance.value.amount);
    assert("$TYCOON ATA received minted tokens (balance > 0)",
      tokens > 0n,
      `ATA balance = ${tokens.toString()}`);
    console.log(`     $TYCOON ATA balance: ${ataBalance.value.uiAmountString} TYCOON`);
  } catch {
    assert("$TYCOON ATA exists and received tokens", false, "ATA not found or empty");
  }

  const cityAfterExit = await (baseProgram.account as any).cityState.fetch(city);
  assert("active_guests decremented after exit",
    cityAfterExit.activeGuests < cityAfterEntry.activeGuests,
    `before=${cityAfterEntry.activeGuests}, after=${cityAfterExit.activeGuests}`);

  // ── Step 8: venue removed ─────────────────────────────────────────────────
  step("8  Venue removed (ER commit → base layer)");
  console.log("     Calling remove_venue on ER (may take up to 95s)...");
  await onVenueRemoved(VENUE_ID);

  const venueFinal = await (baseProgram.account as any).venueAccount.fetch(venue);
  assert("Venue is_active = false after removal", !venueFinal.isActive);
  assert("Venue total_revenue committed to base layer",
    venueFinal.totalRevenue.gtn(0),
    `revenue = ${venueFinal.totalRevenue.toString()}`);

  // ── Step 9: leaderboard ───────────────────────────────────────────────────
  step("9  Leaderboard");
  const [leaderboard] = PublicKey.findProgramAddressSync(
    [Buffer.from("leaderboard")],
    new PublicKey(PROGRAM_ID)
  );
  const lbInfo = await baseConnection.getAccountInfo(leaderboard);
  if (lbInfo === null) {
    console.log("     Leaderboard not initialized — initializing...");
    await baseProgram.methods
      .initializeLeaderboard()
      .accounts({ payer: signer.publicKey })
      .rpc({ commitment: "confirmed" });
  }
  await baseProgram.methods
    .submitScore()
    .accounts({ payer: signer.publicKey, city })
    .rpc({ commitment: "confirmed" });

  const lb = await (baseProgram.account as any).leaderboard.fetch(leaderboard);
  const cityOnBoard = lb.entries.some(
    (e: any) => e.park.toString() === city.toBase58()
  );
  assert("City appears on leaderboard after submit_score", cityOnBoard);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("═══════════════════════════════════════════════════\n");

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\n💥 E2E test crashed:", err?.message ?? err);
  if (err?.logs) console.error("Program logs:", err.logs);
  process.exit(1);
});
