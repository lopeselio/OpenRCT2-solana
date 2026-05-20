// Periodically exports a JSON snapshot of on-chain state to a file the game
// can read. The game's wallet panels (guest, venue, ride income, etc.) tail
// this file rather than making RPC calls themselves — keeps the C++ side
// stupid-simple, no crypto or HTTP needed.

import * as fs from "fs";
import * as path from "path";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { signer } from "./clients";
import {
  cityPda,
  guestPda,
  leaderboardPda,
  venuePda,
  PARK_ID,
} from "./accounts";

const SNAPSHOT_PATH =
  process.env.SNAPSHOT_PATH ??
  path.join(
    process.env.HOME ?? "",
    "Library/Application Support/OpenRCT2/chain-state.json"
  );

const MAX_GUEST_ID = parseInt(process.env.MAX_GUEST_ID ?? "300", 10);
const MAX_VENUE_ID = parseInt(process.env.MAX_VENUE_ID ?? "200", 10);
const ZERO_PUBKEY = new PublicKey(new Uint8Array(32));

async function fetchBatch(
  baseProgram: Program,
  kind: "guestAccount" | "venueAccount",
  keys: PublicKey[]
): Promise<any[]> {
  const BATCH = 100;
  const out: any[] = [];
  for (let i = 0; i < keys.length; i += BATCH) {
    const slice = keys.slice(i, i + BATCH);
    const accs: any[] = await (baseProgram.account as any)[kind].fetchMultiple(slice);
    out.push(...accs);
  }
  return out;
}

export async function writeSnapshot(baseProgram: Program): Promise<void> {
  try {
    const [city] = cityPda();
    const [lb] = leaderboardPda();

    const cityAcc: any = await (baseProgram.account as any).cityState.fetchNullable(city);
    const lbAcc: any = await (baseProgram.account as any).leaderboard.fetchNullable(lb);

    const guestKeys = Array.from({ length: MAX_GUEST_ID }, (_, i) => guestPda(i)[0]);
    const venueKeys = Array.from({ length: MAX_VENUE_ID }, (_, i) => venuePda(i)[0]);
    const [guestAccs, venueAccs] = await Promise.all([
      fetchBatch(baseProgram, "guestAccount", guestKeys),
      fetchBatch(baseProgram, "venueAccount", venueKeys),
    ]);

    const guests = guestAccs.flatMap((g, i) =>
      g
        ? [
            {
              id: i,
              address: guestKeys[i].toBase58(),
              balance: g.balance?.toString?.() ?? "0",
              total_spent: g.totalSpent?.toString?.() ?? "0",
              pending_prize: g.pendingPrize?.toString?.() ?? "0",
              is_active: !!g.isActive,
            },
          ]
        : []
    );

    const venues = venueAccs.flatMap((v, i) =>
      v
        ? [
            {
              id: i,
              address: venueKeys[i].toBase58(),
              total_revenue: v.totalRevenue?.toString?.() ?? "0",
              pending_prize: v.pendingPrize?.toString?.() ?? "0",
              pending_prize_guest_id: v.pendingPrizeGuestId ?? 0,
              is_broken: !!v.isBroken,
              is_active: !!v.isActive,
            },
          ]
        : []
    );

    const leaderboard = lbAcc
      ? lbAcc.entries
          .filter((e: any) => !e.park.equals(ZERO_PUBKEY))
          .map((e: any) => ({
            park: e.park.toBase58(),
            name: Buffer.from(e.name).toString("utf8").replace(/\0+$/, ""),
            revenue: e.revenue?.toString?.() ?? "0",
          }))
      : [];

    const snapshot = {
      updated_at: new Date().toISOString(),
      operator: signer.publicKey.toBase58(),
      park_id: PARK_ID,
      city: cityAcc
        ? {
            address: city.toBase58(),
            name: Buffer.from(cityAcc.name).toString("utf8").replace(/\0+$/, ""),
            park_score: cityAcc.parkScore,
            active_guests: cityAcc.activeGuests,
            total_revenue: cityAcc.totalRevenue?.toString?.() ?? "0",
            total_guests_ever: cityAcc.totalGuestsEver?.toString?.() ?? "0",
            venue_count: cityAcc.venueCount,
          }
        : null,
      leaderboard,
      guests,
      venues,
    };

    // Write atomically: tmp file + rename.
    const tmp = `${SNAPSHOT_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    fs.renameSync(tmp, SNAPSHOT_PATH);
  } catch (err: any) {
    console.warn("[snapshot] write failed:", err?.message ?? err);
  }
}
