import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { erProvider } from "./clients";
import { guestPda, venuePda, PARK_ID } from "./accounts";
import {
  activeGuestCount,
  pickRandomActiveGuest,
  pickRandomKnownVenue,
  setPendingVrf,
} from "./runtime-state";

// Hardcoded in the ephemeral-vrf-sdk consts. Pinned here to avoid pulling
// the SDK into the sidecar just for one pubkey.
const DEFAULT_EPHEMERAL_QUEUE = new PublicKey(
  "5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc"
);

// Periodic "park lottery": pick a random in-park guest, pick a random venue,
// fire a VRF request. The on-chain callback (consume_park_event) writes the
// outcome onto venue.pending_prize — the sidecar later calls apply_vrf_result
// during the guest's exit to transfer the staged prize to guest.pending_prize
// before commit_and_undelegate.
export async function tickLottery(erProgram: Program): Promise<void> {
  const guestId = pickRandomActiveGuest();
  const venueId = pickRandomKnownVenue();
  if (guestId === undefined || venueId === undefined) {
    return; // No active guests or no known venues yet — wait for next tick.
  }

  const [guest] = guestPda(guestId);
  const [venue] = venuePda(venueId);

  // Don't fire if the chosen venue already has an unclaimed prize. Each venue
  // has a single pending_prize slot — a new roll would overwrite whatever the
  // previous lucky guest already won. Skip rather than displace.
  try {
    const venueAcc: any = await (erProgram.account as any).venueAccount.fetchNullable(venue);
    if (venueAcc?.pendingPrize && BigInt(venueAcc.pendingPrize.toString()) > 0n) {
      console.log(
        `[lottery] venue ${venueId} busy (prize ${venueAcc.pendingPrize.toString()} ` +
          `staged for guest ${venueAcc.pendingPrizeGuestId}) — skip`
      );
      return;
    }
  } catch {
    // If the fetch fails, fall through and let the request proceed.
  }

  const seed = Math.floor(Math.random() * 256);

  try {
    await erProgram.methods
      .requestParkEvent(PARK_ID, guestId, seed)
      .accounts({
        payer: erProvider.wallet.publicKey,
        guest,
        venue,
        oracleQueue: DEFAULT_EPHEMERAL_QUEUE,
      })
      .rpc({ skipPreflight: true });

    setPendingVrf(guestId, venueId);
    console.log(
      `[lottery] VRF requested: guest=${guestId} venue=${venueId} seed=${seed} ` +
        `(active=${activeGuestCount()})`
    );
  } catch (err: any) {
    console.warn(
      `[lottery] request failed (guest=${guestId} venue=${venueId}): ${err?.message ?? err}`
    );
  }
}
