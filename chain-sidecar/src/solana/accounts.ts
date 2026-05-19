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

export { PROGRAM_ID };
