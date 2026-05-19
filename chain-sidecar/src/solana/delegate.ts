// Transaction builders for all on-chain operations.
// Handlers are routed to either the Solana base layer or MagicBlock Ephemeral Rollup.
// The game is never blocked — events queue up if the sidecar is slow.

import {
  PublicKey,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import { BN, Program } from "@coral-xyz/anchor";
import {
  baseProvider,
  erProvider,
  baseConnection,
  erConnection,
  wallet,
} from "./clients";
import { cityPda, guestPda, venuePda, PROGRAM_ID } from "./accounts";

// Module-level program instances — initialized once via initPrograms().
let baseProgram: Program;
let erProgram: Program;

// Call once after loading the IDL. In Anchor 0.30+, Program takes (idl, provider)
// and reads the program ID from the IDL — the old 3-arg form is gone.
export function initPrograms(idl: any): void {
  baseProgram = new Program(idl, baseProvider);
  erProgram = new Program(idl, erProvider);
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// exitGuest and removeVenue call commit_and_undelegate via MagicIntentBundleBuilder.
// The ER returns a non-standard response ("Unknown action") that Anchor's WebSocket
// confirmation path can't parse — build + sign + send manually instead.
async function sendErRaw(tx: Transaction): Promise<string> {
  const { blockhash } = await erConnection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  const signed = await wallet.signTransaction(tx);
  return erConnection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
}

// Poll the base layer until the account's owner matches expectedOwner.
async function pollOwnership(
  pda: PublicKey,
  expectedOwner: PublicKey,
  timeoutMs: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const info = await baseConnection.getAccountInfo(pda);
    if (info !== null && info.owner.equals(expectedOwner)) return;
    if (Date.now() >= deadline) {
      throw new Error(`[chain] Timed out waiting for ${label} to return to base layer after ${timeoutMs}ms`);
    }
    await sleep(1500);
  }
}

// ─── Guest Operations ───────────────────────────────────────────────────────

const PARK_UNIT = 1_000_000n;
function parkToUnits(s: string): bigint {
  return BigInt(Math.round(parseFloat(s) * Number(PARK_UNIT)));
}

export async function onGuestEntry(
  guestId: number,
  cash: string
): Promise<void> {
  const initialBalance = parkToUnits(cash);
  const [city] = cityPda();
  const [guest] = guestPda(guestId);

  console.log(`[chain] Registering guest ${guestId} (${cash} PARK)...`);

  await baseProgram.methods
    .registerGuest(guestId, new BN(initialBalance.toString()))
    .accounts({ payer: baseProvider.wallet.publicKey, city, guest, systemProgram: SystemProgram.programId })
    .rpc({ skipPreflight: false, commitment: "confirmed" });

  await baseProgram.methods
    .delegateGuest(guestId)
    .accounts({ payer: baseProvider.wallet.publicKey, guest })
    .rpc({ skipPreflight: false, commitment: "confirmed" });

  await sleep(3000);
  console.log(`[chain] Guest ${guestId} delegated to ER`);
}

export async function onGuestSpend(
  guestId: number,
  venueId: number,
  amount: string,
  category: number
): Promise<void> {
  const amountUnits = parkToUnits(amount);
  const [guest] = guestPda(guestId);
  const [venue] = venuePda(venueId);

  await erProgram.methods
    .spend(guestId, venueId, new BN(amountUnits.toString()), category)
    .accounts({ payer: erProvider.wallet.publicKey, guest, venue })
    .rpc({ skipPreflight: true });
}

export async function onGuestExit(guestId: number): Promise<void> {
  const [guest] = guestPda(guestId);
  const [city] = cityPda();

  console.log(`[chain] Guest ${guestId} exiting — committing + undelegating...`);

  // exitGuest calls commit_and_undelegate — use sendRawTransaction (see comment above).
  const tx = await erProgram.methods
    .exitGuest()
    .accounts({ payer: erProvider.wallet.publicKey, guest })
    .transaction();
  await sendErRaw(tx);

  // Poll until the account's owner returns to the program (max 95s)
  await pollOwnership(guest, PROGRAM_ID, 95_000, `guest ${guestId}`);
  console.log(`[chain] Guest ${guestId} returned to base layer`);

  // Finalize: clear is_active, decrement active_guests, credit any staged VRF prize.
  // claim_prize is a no-op if pending_prize == 0, so always safe to call.
  await baseProgram.methods
    .claimPrize(guestId)
    .accounts({ payer: baseProvider.wallet.publicKey, guest, city })
    .rpc({ commitment: "confirmed" });

  console.log(`[chain] Guest ${guestId} fully exited`);
}

// ─── Venue Operations ───────────────────────────────────────────────────────

export async function onVenueRegistered(
  venueId: number,
  venueKind: number,
  name: string
): Promise<void> {
  const [city] = cityPda();
  const [venue] = venuePda(venueId);

  console.log(`[chain] Registering venue ${venueId} '${name}'...`);

  await baseProgram.methods
    .registerVenue(venueId, venueKind, name)
    .accounts({ payer: baseProvider.wallet.publicKey, city, venue, systemProgram: SystemProgram.programId })
    .rpc({ commitment: "confirmed" });

  await baseProgram.methods
    .delegateVenue(venueId)
    .accounts({ payer: baseProvider.wallet.publicKey, venue })
    .rpc({ commitment: "confirmed" });

  await sleep(3000);
  console.log(`[chain] Venue ${venueId} delegated to ER`);
}

export async function onVenueRenamed(
  venueId: number,
  newName: string
): Promise<void> {
  const [venue] = venuePda(venueId);
  await erProgram.methods
    .renameVenue(venueId, newName)
    .accounts({ payer: erProvider.wallet.publicKey, venue })
    .rpc({ skipPreflight: true });
}

export async function onVenueRemoved(venueId: number): Promise<void> {
  const [city] = cityPda();
  const [venue] = venuePda(venueId);

  console.log(`[chain] Removing venue ${venueId}...`);

  // removeVenue calls commit_and_undelegate — use sendRawTransaction (see comment above).
  const tx = await erProgram.methods
    .removeVenue()
    .accounts({ payer: erProvider.wallet.publicKey, venue, city })
    .transaction();
  await sendErRaw(tx);

  // Poll until venue account returns to base layer (max 95s)
  await pollOwnership(venue, PROGRAM_ID, 95_000, `venue ${venueId}`);
  console.log(`[chain] Venue ${venueId} returned to base layer`);

  // Finalize: set is_active = false. removeVenue can't do this (ExternalAccountDataModified).
  await baseProgram.methods
    .deactivateVenue(venueId)
    .accounts({ payer: baseProvider.wallet.publicKey, venue })
    .rpc({ commitment: "confirmed" });

  console.log(`[chain] Venue ${venueId} fully removed`);
}
