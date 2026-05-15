// Transaction builders for all on-chain operations.
// Each function returns a signed, sendable transaction routed to the correct endpoint.

import {
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { BN, Program } from "@coral-xyz/anchor";
import {
  baseProvider,
  erProvider,
  baseConnection,
  erConnection,
  isDelegated,
} from "./clients";
import { cityPda, guestPda, venuePda, PROGRAM_ID } from "./accounts";

// Converts PARK string ("1234.56") to u64 integer (1234_560_000)
const PARK_UNIT = 1_000_000n;
function parkToUnits(s: string): bigint {
  return BigInt(Math.round(parseFloat(s) * Number(PARK_UNIT)));
}

// ─── Guest Operations ───────────────────────────────────────────────────────

export async function onGuestEntry(
  program: Program,
  guestId: number,
  cash: string
): Promise<void> {
  const initialBalance = parkToUnits(cash);
  const [city] = cityPda();
  const [guest] = guestPda(guestId);

  console.log(`[chain] Registering guest ${guestId} (${cash} PARK)...`);

  // 1. Register on base layer
  await program.methods
    .registerGuest(guestId, new BN(initialBalance.toString()))
    .accounts({ payer: baseProvider.wallet.publicKey, city, guest, systemProgram: SystemProgram.programId })
    .provider(baseProvider)
    .rpc({ skipPreflight: false, commitment: "confirmed" });

  // 2. Delegate to ER (base layer tx)
  await program.methods
    .delegateGuest(guestId)
    .accounts({ payer: baseProvider.wallet.publicKey, guest })
    .provider(baseProvider)
    .rpc({ skipPreflight: false, commitment: "confirmed" });

  // Small wait for ER to recognise the delegation
  await sleep(3000);
  console.log(`[chain] Guest ${guestId} delegated to ER`);
}

export async function onGuestSpend(
  program: Program,
  guestId: number,
  venueId: number,
  amount: string,
  category: number
): Promise<void> {
  const amountUnits = parkToUnits(amount);
  const [guest] = guestPda(guestId);
  const [venue] = venuePda(venueId);

  // Spend goes to ER for ~10-50ms finality
  await program.methods
    .spend(guestId, venueId, new BN(amountUnits.toString()), category)
    .accounts({ payer: erProvider.wallet.publicKey, guest, venue })
    .provider(erProvider)
    .rpc({ skipPreflight: true });
}

export async function onGuestExit(
  program: Program,
  guestId: number
): Promise<void> {
  const [guest] = guestPda(guestId);

  console.log(`[chain] Guest ${guestId} exiting — committing + undelegating...`);

  await program.methods
    .exitGuest()
    .accounts({ payer: erProvider.wallet.publicKey, guest })
    .provider(erProvider)
    .rpc({ skipPreflight: true });

  await sleep(3000); // wait for base layer to receive the undelegation
  console.log(`[chain] Guest ${guestId} fully exited`);
}

// ─── Venue Operations ───────────────────────────────────────────────────────

export async function onVenueRegistered(
  program: Program,
  venueId: number,
  venueKind: number,
  name: string
): Promise<void> {
  const [city] = cityPda();
  const [venue] = venuePda(venueId);

  console.log(`[chain] Registering venue ${venueId} '${name}'...`);

  // Register on base layer
  await program.methods
    .registerVenue(venueId, venueKind, name)
    .accounts({ payer: baseProvider.wallet.publicKey, city, venue, systemProgram: SystemProgram.programId })
    .provider(baseProvider)
    .rpc({ commitment: "confirmed" });

  // Delegate to ER
  await program.methods
    .delegateVenue(venueId)
    .accounts({ payer: baseProvider.wallet.publicKey, venue })
    .provider(baseProvider)
    .rpc({ commitment: "confirmed" });

  await sleep(3000);
  console.log(`[chain] Venue ${venueId} delegated to ER`);
}

export async function onVenueRenamed(
  program: Program,
  venueId: number,
  newName: string
): Promise<void> {
  const [venue] = venuePda(venueId);
  await program.methods
    .renameVenue(venueId, newName)
    .accounts({ payer: erProvider.wallet.publicKey, venue })
    .provider(erProvider)
    .rpc({ skipPreflight: true });
}

export async function onVenueRemoved(
  program: Program,
  venueId: number
): Promise<void> {
  const [city] = cityPda();
  const [venue] = venuePda(venueId);

  console.log(`[chain] Removing venue ${venueId}...`);
  await program.methods
    .removeVenue()
    .accounts({ payer: erProvider.wallet.publicKey, venue, city })
    .provider(erProvider)
    .rpc({ skipPreflight: true });

  await sleep(3000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
