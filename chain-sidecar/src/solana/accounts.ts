import { PublicKey } from "@solana/web3.js";

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? "2ce1z7iFfMB6BHzaWvT5jqhsDsS6jeEjvymGYwrb8wDn"
);

export const PARK_ID: number = parseInt(process.env.PARK_ID ?? "1", 10);

function parkIdBuf(parkId: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(parkId);
  return buf;
}

export function cityPda(parkId = PARK_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("city"), parkIdBuf(parkId)],
    PROGRAM_ID
  );
}

export function guestPda(guestId: number, parkId = PARK_ID): [PublicKey, number] {
  const gBuf = Buffer.alloc(4);
  gBuf.writeUInt32LE(guestId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("guest"), parkIdBuf(parkId), gBuf],
    PROGRAM_ID
  );
}

export function venuePda(venueId: number, parkId = PARK_ID): [PublicKey, number] {
  const vBuf = Buffer.alloc(4);
  vBuf.writeUInt32LE(venueId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("venue"), parkIdBuf(parkId), vBuf],
    PROGRAM_ID
  );
}

export function parkMintPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("park_mint")], PROGRAM_ID);
}

export function leaderboardPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("leaderboard")], PROGRAM_ID);
}

export function badgePda(cityPubkey: PublicKey, tier: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("badge"), cityPubkey.toBuffer(), Buffer.from([tier])],
    PROGRAM_ID
  );
}

// Tier thresholds mirror programs/solana-city/src/instructions/badges.rs.
// Index = tier; value = min total_guests_ever required to claim.
export const BADGE_TIER_THRESHOLDS: number[] = [5, 25, 100, 500];
export const BADGE_TIER_NAMES: string[] = ["Bronze", "Silver", "Gold", "Diamond"];

export { PROGRAM_ID };
