import { BN, Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { baseProvider, signer } from "./clients";
import { cityPda, leaderboardPda, PARK_ID, venuePda } from "./accounts";

// Maximum venue id we scan when summing revenue. OpenRCT2 caps rides per park
// well under this; venue ids beyond the registered range will fetch as null.
const MAX_VENUE_ID = parseInt(process.env.MAX_VENUE_ID ?? "200", 10);

// Pubkey::default() in the Rust program — all-zero bytes — marks an empty
// leaderboard slot. Pre-compute once.
const ZERO_PUBKEY = new PublicKey(new Uint8Array(32));

export async function ensureLeaderboardInitialized(baseProgram: Program): Promise<void> {
  const [lb] = leaderboardPda();
  const info = await baseProvider.connection.getAccountInfo(lb);
  if (info !== null) {
    console.log("[chain] Leaderboard already initialized:", lb.toBase58());
    return;
  }
  console.log("[chain] Initializing leaderboard PDA...");
  await baseProgram.methods
    .initializeLeaderboard()
    .accounts({ payer: signer.publicKey })
    .rpc({ commitment: "confirmed" });
  console.log("[chain] Leaderboard initialized:", lb.toBase58());
}

// Sum total_revenue across every venue PDA on the ER. spend() writes to the
// ER-side venue, so this is the only place the real per-park revenue lives.
// We batch fetches via fetchMultiple to keep RPC load to ~2 calls (200/100).
async function sumErVenueRevenues(erProgram: Program): Promise<bigint> {
  const pubkeys = Array.from({ length: MAX_VENUE_ID }, (_, i) => venuePda(i)[0]);
  let total = 0n;
  const BATCH = 100;
  for (let i = 0; i < pubkeys.length; i += BATCH) {
    const batch = pubkeys.slice(i, i + BATCH);
    const accs: any[] = await (erProgram.account as any).venueAccount.fetchMultiple(batch);
    for (const a of accs) {
      if (a?.totalRevenue) total += BigInt(a.totalRevenue.toString());
    }
  }
  return total;
}

export async function tickScoreLoop(
  baseProgram: Program,
  erProgram: Program
): Promise<void> {
  try {
    const totalRevenue = await sumErVenueRevenues(erProgram);

    // Recompute park_score on-chain. We pass the precomputed venue-revenue sum
    // because spend() writes to ER venues only — base-layer city.total_revenue
    // would otherwise stay 0.
    await baseProgram.methods
      .updateParkScore(PARK_ID, new BN(totalRevenue.toString()))
      .accounts({})
      .rpc({ commitment: "confirmed" });

    // Push the updated city to the leaderboard.
    await baseProgram.methods
      .submitScore()
      .accounts({ payer: signer.publicKey, city: cityPda()[0] })
      .rpc({ commitment: "confirmed" });

    // Read back state so the log is meaningful.
    const [city] = cityPda();
    const cityAcc: any = await (baseProgram.account as any).cityState.fetch(city);
    const lbAcc: any = await (baseProgram.account as any).leaderboard.fetch(leaderboardPda()[0]);

    const ourEntry = lbAcc.entries.findIndex((e: any) => e.park.equals(city));
    const rankStr = ourEntry === -1 ? "off-board" : `#${ourEntry + 1}`;
    const populated = lbAcc.entries.filter((e: any) => !e.park.equals(ZERO_PUBKEY)).length;

    console.log(
      `[score] park_score=${cityAcc.parkScore} active_guests=${cityAcc.activeGuests} ` +
        `revenue=${cityAcc.totalRevenue.toString()} rank=${rankStr}/${populated}`
    );
  } catch (err: any) {
    console.warn("[score] tick failed:", err?.message ?? err);
  }
}
