// Transaction builders for all on-chain operations.
// Handlers are routed to either the Solana base layer or MagicBlock Ephemeral Rollup.
// The game is never blocked — events queue up if the sidecar is slow.

import {
  PublicKey,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import { BN, Program } from "@coral-xyz/anchor";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  baseProvider,
  erProvider,
  baseConnection,
  erConnection,
  wallet,
} from "./clients";
import { cityPda, guestPda, venuePda, PROGRAM_ID, PARK_ID } from "./accounts";
import {
  markGuestActive,
  markGuestInactive,
  markVenueKnown,
  takePendingVrf,
} from "./runtime-state";

// State of a PDA between base layer and the ER, used to make entry/exit
// reconcile against on-chain reality instead of replaying blindly.
type PdaState = "missing" | "base" | "delegated" | "foreign";

async function getPdaState(pda: PublicKey): Promise<PdaState> {
  const info = await baseConnection.getAccountInfo(pda);
  if (info === null) return "missing";
  if (info.owner.equals(PROGRAM_ID)) return "base";
  if (info.owner.equals(DELEGATION_PROGRAM_ID)) return "delegated";
  return "foreign";
}

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

  const state = await getPdaState(guest);
  switch (state) {
    case "delegated":
      console.log(`[chain] Guest ${guestId} already delegated to ER — skip`);
      markGuestActive(guestId);
      return;

    case "base": {
      // Guest PDA already exists on base from a prior session.
      // Reactivate (resets balance to fresh pocket cash, bumps active_guests if
      // newly active, idempotent if already active) then re-delegate.
      // total_spent carries over from previous visits.
      console.log(`[chain] Guest ${guestId} exists on base — reactivating + re-delegating...`);
      await baseProgram.methods
        .reactivateGuest(PARK_ID, guestId, new BN(initialBalance.toString()))
        .accounts({ payer: baseProvider.wallet.publicKey })
        .rpc({ skipPreflight: false, commitment: "confirmed" });
      await baseProgram.methods
        .delegateGuest(PARK_ID, guestId)
        .accounts({ payer: baseProvider.wallet.publicKey })
        .rpc({ skipPreflight: false, commitment: "confirmed" });
      await sleep(3000);
      console.log(`[chain] Guest ${guestId} reactivated + delegated to ER`);
      markGuestActive(guestId);
      return;
    }

    case "missing": {
      console.log(`[chain] Registering guest ${guestId} in park ${PARK_ID} (${cash} TYCOON)...`);
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
      markGuestActive(guestId);
      return;
    }

    case "foreign":
      throw new Error(
        `[chain] Guest ${guestId} PDA ${guest.toBase58()} owned by unexpected program — refusing to touch`
      );
  }
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

  try {
    await erProgram.methods
      .spend(PARK_ID, guestId, venueId, new BN(amountUnits.toString()), category)
      .accounts({ payer: erProvider.wallet.publicKey, guest, venue })
      .rpc({ skipPreflight: true });
  } catch (err: any) {
    // ER's "Unknown action 'undefined'" hides the underlying anchor error.
    // Probe on-chain state to classify the failure.
    const erGuest = await (erProgram as any).account.guestAccount
      .fetchNullable(guest)
      .catch(() => null);

    // Known-benign cases: skip with a single-line warning, don't pollute the log.
    if (erGuest === null) {
      // Guest was never registered (pre-replay save data) or got swept away.
      console.warn(
        `[chain] spend skipped: guest ${guestId} not on ER (likely pre-migration); seq will retry on next entry`
      );
      return;
    }
    const bal = BigInt(erGuest.balance?.toString?.() ?? "0");
    if (bal < amountUnits) {
      // Game-side cash > on-chain balance (stale state from before the
      // reactivate-with-balance fix, or guest drained in a busy session).
      // Heals on next exit+re-entry. Don't throw.
      console.warn(
        `[chain] spend skipped: guest ${guestId} balance=${bal} < amount=${amountUnits} (venue=${venueId}); heals on re-entry`
      );
      return;
    }
    if (!erGuest.isActive) {
      console.warn(
        `[chain] spend skipped: guest ${guestId} is_active=false on ER (venue=${venueId})`
      );
      return;
    }

    // Unknown failure — keep the full diagnostic + rethrow so it surfaces.
    const logs: string[] | undefined = err?.logs ?? err?.transactionLogs;
    console.error(
      `[chain] spend failed (guest=${guestId} venue=${venueId} amount=${amount} category=${category})`
    );
    if (logs?.length) {
      console.error("[chain]   logs:");
      for (const line of logs) console.error("[chain]    ", line);
    } else {
      console.error("[chain]   err:", err?.message ?? err);
      console.error(
        `[chain]   guest(ER): is_active=${erGuest.isActive} balance=${erGuest.balance?.toString?.()}`
      );
      const v = await (erProgram as any).account.venueAccount
        .fetchNullable(venue)
        .catch(() => null);
      console.error(
        `[chain]   venue(ER): ${
          v ? `is_broken=${v.isBroken} revenue=${v.totalRevenue?.toString?.()}` : "MISSING"
        }`
      );
    }
    throw err;
  }
}

export async function onGuestExit(guestId: number): Promise<void> {
  const [guest] = guestPda(guestId);

  const state = await getPdaState(guest);

  if (state === "missing") {
    console.log(`[chain] Guest ${guestId} has no on-chain PDA — exit no-op`);
    return;
  }

  if (state === "foreign") {
    throw new Error(
      `[chain] Guest ${guestId} PDA ${guest.toBase58()} owned by unexpected program`
    );
  }

  if (state === "delegated") {
    // If a VRF event was requested for this guest, settle the staged prize
    // BEFORE commit_and_undelegate — otherwise venue.pending_prize stays
    // stranded on the ER and the prize is effectively lost.
    const vrfVenueId = takePendingVrf(guestId);
    if (vrfVenueId !== undefined) {
      const [venue] = venuePda(vrfVenueId);
      // Pre-check: each venue has a single prize slot. If another guest's roll
      // has overwritten ours, the on-chain constraint will reject the call —
      // skip cleanly so the log isn't full of masked errors.
      let canApply = false;
      try {
        const venueAcc: any = await (erProgram.account as any).venueAccount.fetchNullable(venue);
        if (venueAcc) {
          const pending = BigInt(venueAcc.pendingPrize?.toString?.() ?? "0");
          if (pending === 0n) {
            console.log(`[chain] no VRF prize staged for guest ${guestId} (venue ${vrfVenueId} — roll was quiet or breakdown)`);
          } else if (venueAcc.pendingPrizeGuestId !== guestId) {
            console.log(
              `[chain] VRF prize on venue ${vrfVenueId} displaced — currently held for guest ${venueAcc.pendingPrizeGuestId}, not ${guestId}`
            );
          } else {
            canApply = true;
          }
        }
      } catch {
        canApply = true; // fall through and let the on-chain call surface the real error
      }

      if (canApply) {
        try {
          await erProgram.methods
            .applyVrfResult(PARK_ID, guestId, vrfVenueId)
            .accounts({ payer: erProvider.wallet.publicKey, guest, venue })
            .rpc({ skipPreflight: true });
          console.log(`[chain] VRF result applied for guest ${guestId} (venue=${vrfVenueId})`);
        } catch (err: any) {
          console.warn(
            `[chain] apply_vrf_result failed for guest ${guestId}: ${err?.message ?? err}`
          );
        }
      }
    }

    console.log(`[chain] Guest ${guestId} exiting park ${PARK_ID} — committing + undelegating...`);
    const tx = await erProgram.methods
      .exitGuest()
      .accounts({ payer: erProvider.wallet.publicKey, guest })
      .transaction();
    await sendErRaw(tx);
    await pollOwnership(guest, PROGRAM_ID, 95_000, `guest ${guestId}`);
    console.log(`[chain] Guest ${guestId} returned to base layer`);
  } else {
    // state === "base" — already on base, nothing to undelegate.
    console.log(`[chain] Guest ${guestId} already on base — finalizing only`);
  }

  // Finalize: clear is_active, decrement active_guests, credit any staged VRF prize.
  // claim_prize is a no-op if pending_prize == 0 and already-inactive, so safe to call.
  await baseProgram.methods
    .claimPrize(PARK_ID, guestId)
    .accounts({ payer: baseProvider.wallet.publicKey })
    .rpc({ commitment: "confirmed" });

  // Mint any remaining internal TYCOON balance as real $TYCOON SPL tokens.
  const guestAcc = await (baseProgram.account as any).guestAccount.fetch(guest);
  if (guestAcc.balance.gtn(0)) {
    await baseProgram.methods
      .redeemBalance(guestId)
      .accounts({ payer: baseProvider.wallet.publicKey, guest })
      .rpc({ commitment: "confirmed" });
    console.log(`[chain] Guest ${guestId} redeemed ${guestAcc.balance.toString()} $TYCOON`);
  }

  console.log(`[chain] Guest ${guestId} fully exited park ${PARK_ID}`);
  markGuestInactive(guestId);
}

// ─── Venue Operations ───────────────────────────────────────────────────────

export async function onVenueRegistered(
  venueId: number,
  venueKind: number,
  name: string
): Promise<void> {
  const [venue] = venuePda(venueId);

  const state = await getPdaState(venue);
  switch (state) {
    case "delegated":
      console.log(`[chain] Venue ${venueId} already delegated to ER — skip`);
      markVenueKnown(venueId);
      return;

    case "base":
      console.log(`[chain] Venue ${venueId} exists on base — re-delegating to ER...`);
      await baseProgram.methods
        .delegateVenue(PARK_ID, venueId)
        .accounts({ payer: baseProvider.wallet.publicKey })
        .rpc({ commitment: "confirmed" });
      await sleep(3000);
      console.log(`[chain] Venue ${venueId} re-delegated to ER`);
      markVenueKnown(venueId);
      return;

    case "missing":
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
      markVenueKnown(venueId);
      return;

    case "foreign":
      throw new Error(
        `[chain] Venue ${venueId} PDA ${venue.toBase58()} owned by unexpected program`
      );
  }
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

  const state = await getPdaState(venue);

  if (state === "missing") {
    console.log(`[chain] Venue ${venueId} has no on-chain PDA — remove no-op`);
    return;
  }

  if (state === "foreign") {
    throw new Error(
      `[chain] Venue ${venueId} PDA ${venue.toBase58()} owned by unexpected program`
    );
  }

  if (state === "delegated") {
    console.log(`[chain] Removing venue ${venueId} from park ${PARK_ID}...`);
    const tx = await erProgram.methods
      .removeVenue(PARK_ID)
      .accounts({ payer: erProvider.wallet.publicKey, venue })
      .transaction();
    await sendErRaw(tx);
    await pollOwnership(venue, PROGRAM_ID, 95_000, `venue ${venueId}`);
    console.log(`[chain] Venue ${venueId} returned to base layer`);
  } else {
    console.log(`[chain] Venue ${venueId} already on base — finalizing only`);
  }

  await baseProgram.methods
    .deactivateVenue(PARK_ID, venueId)
    .accounts({ payer: baseProvider.wallet.publicKey })
    .rpc({ commitment: "confirmed" });

  console.log(`[chain] Venue ${venueId} fully removed from park ${PARK_ID}`);
}
