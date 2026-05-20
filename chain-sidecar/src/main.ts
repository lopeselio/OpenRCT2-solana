// Solana City chain-sidecar
//
// Watches the NDJSON outbox written by OpenRCT2-solana, classifies each event,
// and routes it to either the Solana base layer or MagicBlock Ephemeral Rollup.
// The game is never blocked — events queue up if the sidecar is slow.

import "dotenv/config";
import * as path from "path";
import * as fs from "fs";
import { Program } from "@coral-xyz/anchor";
import { followOutbox } from "./outbox/reader";
import { OutboxEvent, EventKind } from "./outbox/types";
import { baseProvider, erProvider, signer } from "./solana/clients";
import {
  initPrograms,
  onGuestEntry,
  onGuestSpend,
  onGuestExit,
  onVenueRegistered,
  onVenueRenamed,
  onVenueRemoved,
} from "./solana/delegate";
import { cityPda, parkMintPda, PARK_ID } from "./solana/accounts";
import { ensureLeaderboardInitialized, tickScoreLoop } from "./solana/score";
import { tickLottery } from "./solana/lottery";
import { hydrateFromChain } from "./solana/runtime-state";
import { writeSnapshot } from "./solana/snapshot";

const SCORE_TICK_MS = parseInt(process.env.SCORE_TICK_MS ?? "30000", 10);
const LOTTERY_TICK_MS = parseInt(process.env.LOTTERY_TICK_MS ?? "60000", 10);

const OUTBOX_PATH =
  process.env.OUTBOX_PATH ??
  path.join(process.env.HOME ?? "", "Library/Application Support/OpenRCT2/chain-outbox.ndjson");

const CITY_NAME = process.env.CITY_NAME ?? "Solana City";

async function ensureCityInitialized(baseProgram: Program): Promise<void> {
  const [city] = cityPda();
  const info = await baseProvider.connection.getAccountInfo(city);
  if (info !== null) {
    console.log(`[chain] Park ${PARK_ID} already initialized on-chain`);
    return;
  }

  console.log(`[chain] Initializing '${CITY_NAME}' (park_id=${PARK_ID}) on Solana...`);
  await baseProgram.methods
    .initializeCity(PARK_ID, CITY_NAME)
    .accounts({ authority: signer.publicKey })
    .rpc({ commitment: "confirmed" });
  console.log(`[chain] Park ${PARK_ID} initialized:`, city.toBase58());
}

async function ensureParkMintInitialized(baseProgram: Program): Promise<void> {
  const [mint] = parkMintPda();
  const info = await baseProvider.connection.getAccountInfo(mint);
  if (info !== null) {
    console.log("[chain] $TYCOON mint already initialized");
    return;
  }
  console.log("[chain] Initializing $TYCOON mint...");
  await baseProgram.methods
    .initializeParkMint()
    .accounts({ payer: signer.publicKey })
    .rpc({ commitment: "confirmed" });
  console.log("[chain] $TYCOON mint initialized:", mint.toBase58());
}

async function main() {
  console.log("=== Solana City Chain Sidecar ===");
  console.log("Wallet:", signer.publicKey.toBase58());
  console.log("Park ID:", PARK_ID);
  console.log("Outbox:", OUTBOX_PATH);

  // Load IDL and initialize both base + ER program instances
  const idl = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../../target/idl/solana_city.json"),
      "utf8"
    )
  );
  initPrograms(idl);

  // baseProgram for setup checks only — delegate.ts owns the program instances
  const baseProgram = new Program(idl, baseProvider);
  const erProgram = new Program(idl, erProvider);
  await ensureCityInitialized(baseProgram);
  await ensureParkMintInitialized(baseProgram);
  await ensureLeaderboardInitialized(baseProgram);

  // Hydrate the in-memory active-guest + known-venue sets from on-chain state
  // so the lottery has something to pick from immediately (existing guests
  // delegated to ER won't emit new GUEST_ENTRY events through the outbox).
  const hydrated = await hydrateFromChain(baseProgram);
  console.log(
    `[chain] Hydrated runtime state: ${hydrated.guests} active guests, ${hydrated.venues} venues`
  );

  // Periodic park-score recompute + leaderboard submit. The sidecar sums
  // ER-side venue revenues each tick and passes the total to update_park_score
  // so city.park_score reflects real spending.
  setInterval(() => void tickScoreLoop(baseProgram, erProgram), SCORE_TICK_MS);
  console.log(`[chain] Score loop running every ${SCORE_TICK_MS}ms`);

  // Periodically write a chain-state.json snapshot the game's wallet panels
  // tail. Same cadence as the score tick. Venues + guests are read from the
  // ER (where spend() actually writes); city + leaderboard from base.
  setInterval(() => void writeSnapshot(baseProgram, erProgram), SCORE_TICK_MS);
  // Also write once immediately so the file exists by the time the user
  // opens a guest/venue window.
  void writeSnapshot(baseProgram, erProgram);
  console.log("[chain] Snapshot writer attached");

  // Park lottery: every LOTTERY_TICK_MS pick a random active guest + venue,
  // fire a VRF request on the ER. consume_park_event stakes the result on the
  // venue; apply_vrf_result is called during that guest's eventual exit.
  setInterval(() => void tickLottery(erProgram), LOTTERY_TICK_MS);
  console.log(`[chain] Lottery loop running every ${LOTTERY_TICK_MS}ms`);

  // Queue for sequential processing — prevents race conditions on the same PDA
  const eventQueue: OutboxEvent[] = [];
  let processing = false;

  const processNext = async () => {
    if (processing || eventQueue.length === 0) return;
    processing = true;
    const event = eventQueue.shift()!;

    try {
      await dispatch(event);
    } catch (err) {
      console.error(`[chain] Error processing seq=${event.seq}:`, err);
    }

    processing = false;
    setImmediate(processNext);
  };

  const enqueue = (event: OutboxEvent) => {
    eventQueue.push(event);
    setImmediate(processNext);
  };

  console.log("[chain] Watching outbox...\n");
  await followOutbox(OUTBOX_PATH, enqueue);
}

async function dispatch(event: OutboxEvent): Promise<void> {
  switch (event.kind) {
    case EventKind.GUEST_ENTRY:
      await onGuestEntry(event.guestId, event.cash);
      break;
    case EventKind.GUEST_SPEND:
      await onGuestSpend(event.guestId, event.venueId, event.amount, event.category);
      break;
    case EventKind.GUEST_EXIT:
      await onGuestExit(event.guestId);
      break;
    case EventKind.VENUE_REGISTERED:
      await onVenueRegistered(event.venueId, event.venueKind, event.name);
      break;
    case EventKind.VENUE_RENAMED:
      await onVenueRenamed(event.venueId, event.newName);
      break;
    case EventKind.VENUE_REMOVED:
      await onVenueRemoved(event.venueId);
      break;
  }
}

main().catch((err) => {
  console.error("Fatal sidecar error:", err);
  process.exit(1);
});
