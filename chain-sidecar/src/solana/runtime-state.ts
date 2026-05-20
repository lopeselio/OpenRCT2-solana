// Shared in-memory state for things the outbox doesn't tell us on demand:
// which guests are currently in the park, which venues exist, and which
// guests have a VRF request outstanding (so we can apply the staged prize
// before they exit).

import { Program } from "@coral-xyz/anchor";
import { guestPda, venuePda } from "./accounts";

const activeGuests = new Set<number>();
const knownVenues = new Set<number>();
const pendingVrf = new Map<number, number>(); // guestId -> venueId

export function markGuestActive(guestId: number): void {
  activeGuests.add(guestId);
}

export function markGuestInactive(guestId: number): void {
  activeGuests.delete(guestId);
  pendingVrf.delete(guestId);
}

export function pickRandomActiveGuest(): number | undefined {
  if (activeGuests.size === 0) return undefined;
  const idx = Math.floor(Math.random() * activeGuests.size);
  let i = 0;
  for (const id of activeGuests) {
    if (i === idx) return id;
    i++;
  }
  return undefined;
}

export function activeGuestCount(): number {
  return activeGuests.size;
}

export function markVenueKnown(venueId: number): void {
  knownVenues.add(venueId);
}

export function pickRandomKnownVenue(): number | undefined {
  if (knownVenues.size === 0) return undefined;
  const idx = Math.floor(Math.random() * knownVenues.size);
  let i = 0;
  for (const id of knownVenues) {
    if (i === idx) return id;
    i++;
  }
  return undefined;
}

export function setPendingVrf(guestId: number, venueId: number): void {
  pendingVrf.set(guestId, venueId);
}

export function takePendingVrf(guestId: number): number | undefined {
  const venueId = pendingVrf.get(guestId);
  if (venueId !== undefined) pendingVrf.delete(guestId);
  return venueId;
}

// Hydrate active-guest + known-venue sets from on-chain state at startup.
// Without this, the lottery has nothing to pick from until new entry events
// arrive — which is bad if guests are already in the park (and delegated)
// from a previous session.
export async function hydrateFromChain(
  baseProgram: Program,
  opts: { maxGuestId?: number; maxVenueId?: number } = {}
): Promise<{ guests: number; venues: number }> {
  const maxGuestId = opts.maxGuestId ?? 300;
  const maxVenueId = opts.maxVenueId ?? 200;

  const fetchMultiple = async (kind: "guestAccount" | "venueAccount", keys: any[]) => {
    const BATCH = 100;
    const out: any[] = [];
    for (let i = 0; i < keys.length; i += BATCH) {
      const slice = keys.slice(i, i + BATCH);
      const accs: any[] = await (baseProgram.account as any)[kind].fetchMultiple(slice);
      out.push(...accs);
    }
    return out;
  };

  const guestKeys = Array.from({ length: maxGuestId }, (_, i) => guestPda(i)[0]);
  const guestAccs = await fetchMultiple("guestAccount", guestKeys);
  for (let i = 0; i < guestAccs.length; i++) {
    const g = guestAccs[i];
    if (g?.isActive) activeGuests.add(i);
  }

  const venueKeys = Array.from({ length: maxVenueId }, (_, i) => venuePda(i)[0]);
  const venueAccs = await fetchMultiple("venueAccount", venueKeys);
  for (let i = 0; i < venueAccs.length; i++) {
    if (venueAccs[i] !== null) knownVenues.add(i);
  }

  return { guests: activeGuests.size, venues: knownVenues.size };
}
