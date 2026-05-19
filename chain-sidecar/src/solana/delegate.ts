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
import { cityPda, guestPda, venuePda, PROGRAM_ID, PARK_ID } from "./accounts";

// Module-level program instances — initialized once via initPrograms().
let baseProgram: Program;
let erProgram: Program;

// Call once after loading the IDL. In Anchor 0.32, Program takes (idl, provider)
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
//
// We poll getSignatureStatuses (HTTP) for confirmation rather than the WS
// subscription. If the tx reverts, we throw immediately so the caller doesn't
// fall into a 95s pollOwnership wait for an undelegation that never happens.
async function sendErRaw(tx: Transaction): Promise<string> {
  const { blockhash } = await erConnection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  const signed = await wallet.signTransaction(tx);
  const signature = await erConnection.sendRawTransaction(signed.serialize(), {
    skipPreflight: true,
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { value } = await erConnection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status) {
      if (status.err) {
        // Pull logs for a useful error message.
        let logs: string[] | null = null;
        try {
          const tx = await erConnection.getTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed",
          });
          logs = tx?.meta?.logMessages ?? null;
        } catch {
          /* best-effort */
        }
        const errStr = JSON.stringify(status.err);
        const logTail = logs ? "\n  " + logs.slice(-6).join("\n  ") : "";
        throw new Error(`[chain] ER tx ${signature} failed: ${errStr}${logTail}`);
      }
      if (
        status.confirmationStatus === "confirmed" ||
        status.confirmationStatus === "finalized"
      ) {
        return signature;
      }
    }
    await sleep(500);
  }
  throw new Error(`[chain] ER tx ${signature} not confirmed within 30s`);
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
  const [guest] = guestPda(guestId);

  console.log(`[chain] Registering guest ${guestId} in park ${PARK_ID} (${cash} PARK)...`);

  await baseProgram.methods
    .registerGuest(PARK_ID, guestId, new BN(initialBalance.toString()))
    .accounts({ payer: baseProvider.wallet.publicKey })
    .rpc({ skipPreflight: false, commitment: "confirmed" });

  await baseProgram.methods
    .delegateGuest(PARK_ID, guestId)
    .accounts({ payer: baseProvider.wallet.publicKey })
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
    .spend(PARK_ID, guestId, venueId, new BN(amountUnits.toString()), category)
    .accounts({ payer: erProvider.wallet.publicKey, guest, venue })
    .rpc({ skipPreflight: true });
}

export async function onGuestExit(guestId: number): Promise<void> {
  const [guest] = guestPda(guestId);

  console.log(`[chain] Guest ${guestId} exiting park ${PARK_ID} — committing + undelegating...`);

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
    .claimPrize(PARK_ID, guestId)
    .accounts({ payer: baseProvider.wallet.publicKey })
    .rpc({ commitment: "confirmed" });

  // Mint any remaining internal PARK balance as real $PARK SPL tokens.
  const guestAcc = await (baseProgram.account as any).guestAccount.fetch(guest);
  if (guestAcc.balance.gtn(0)) {
    await baseProgram.methods
      .redeemBalance(guestId)
      .accounts({ payer: baseProvider.wallet.publicKey, guest })
      .rpc({ commitment: "confirmed" });
    console.log(`[chain] Guest ${guestId} redeemed ${guestAcc.balance.toString()} PARK tokens`);
  }

  console.log(`[chain] Guest ${guestId} fully exited park ${PARK_ID}`);
}

// ─── Venue Operations ───────────────────────────────────────────────────────

export async function onVenueRegistered(
  venueId: number,
  venueKind: number,
  name: string
): Promise<void> {
  const [venue] = venuePda(venueId);

  console.log(`[chain] Registering venue ${venueId} '${name}' in park ${PARK_ID}...`);

  await baseProgram.methods
    .registerVenue(PARK_ID, venueId, venueKind, name)
    .accounts({ payer: baseProvider.wallet.publicKey })
    .rpc({ commitment: "confirmed" });

  await baseProgram.methods
    .delegateVenue(PARK_ID, venueId)
    .accounts({ payer: baseProvider.wallet.publicKey })
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
    .renameVenue(PARK_ID, venueId, newName)
    .accounts({ payer: erProvider.wallet.publicKey, venue })
    .rpc({ skipPreflight: true });
}

export async function onVenueRemoved(venueId: number): Promise<void> {
  const [venue] = venuePda(venueId);

  console.log(`[chain] Removing venue ${venueId} from park ${PARK_ID}...`);

  // removeVenue calls commit_and_undelegate — use sendRawTransaction (see comment above).
  const tx = await erProgram.methods
    .removeVenue(PARK_ID)
    .accounts({ payer: erProvider.wallet.publicKey, venue })
    .transaction();
  await sendErRaw(tx);

  // Poll until venue account returns to base layer (max 95s)
  await pollOwnership(venue, PROGRAM_ID, 95_000, `venue ${venueId}`);
  console.log(`[chain] Venue ${venueId} returned to base layer`);

  // Finalize: set is_active = false. removeVenue can't do this (ExternalAccountDataModified).
  await baseProgram.methods
    .deactivateVenue(PARK_ID, venueId)
    .accounts({ payer: baseProvider.wallet.publicKey })
    .rpc({ commitment: "confirmed" });

  console.log(`[chain] Venue ${venueId} fully removed from park ${PARK_ID}`);
}
