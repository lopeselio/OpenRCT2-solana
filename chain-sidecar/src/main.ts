// Solana City chain-sidecar
//
// Watches the NDJSON outbox written by OpenRCT2-solana, classifies each event,
// and routes it to either the Solana base layer or MagicBlock Ephemeral Rollup.
// The game is never blocked — events queue up if the sidecar is slow.

import "dotenv/config";
import * as path from "path";
import * as fs from "fs";
import { Program } from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { followOutbox } from "./outbox/reader";
import { OutboxEvent, EventKind } from "./outbox/types";
import { baseProvider, signer } from "./solana/clients";
import {
  initPrograms,
  onGuestEntry,
  onGuestSpend,
  onGuestExit,
  onVenueRegistered,
  onVenueRenamed,
  onVenueRemoved,
} from "./solana/delegate";
import { cityPda } from "./solana/accounts";

const OUTBOX_PATH =
  process.env.OUTBOX_PATH ??
  path.join(process.env.HOME ?? "", "Library/Application Support/OpenRCT2/chain-outbox.ndjson");

const CITY_NAME = process.env.CITY_NAME ?? "Solana City";

async function ensureCityInitialized(baseProgram: Program): Promise<void> {
  const [city] = cityPda();
  const info = await baseProvider.connection.getAccountInfo(city);
  if (info !== null) {
    console.log("[chain] City already initialized on-chain");
    return;
  }

  console.log(`[chain] Initializing '${CITY_NAME}' on Solana...`);
  await baseProgram.methods
    .initializeCity(CITY_NAME)
    .accounts({
      authority: signer.publicKey,
      city,
      systemProgram: SystemProgram.programId,
    })
    .rpc({ commitment: "confirmed" });
  console.log("[chain] City initialized:", city.toBase58());
}

async function main() {
  console.log("=== Solana City Chain Sidecar ===");
  console.log("Wallet:", signer.publicKey.toBase58());
  console.log("Outbox:", OUTBOX_PATH);

  // Load IDL and initialize both base + ER program instances
  const idl = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../../target/idl/solana_city.json"),
      "utf8"
    )
  );
  initPrograms(idl);

  // baseProgram for city init check only — delegate.ts owns the program instances
  const baseProgram = new Program(idl, baseProvider);
  await ensureCityInitialized(baseProgram);

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
