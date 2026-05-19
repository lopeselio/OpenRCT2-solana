import { PublicKey } from "@solana/web3.js";

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? "2ce1z7iFfMB6BHzaWvT5jqhsDsS6jeEjvymGYwrb8wDn"
);

export function cityPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("city")], PROGRAM_ID);
}

export function guestPda(guestId: number): [PublicKey, number] {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(guestId, 0);
  return PublicKey.findProgramAddressSync([Buffer.from("guest"), buf], PROGRAM_ID);
}

export function venuePda(venueId: number): [PublicKey, number] {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(venueId, 0);
  return PublicKey.findProgramAddressSync([Buffer.from("venue"), buf], PROGRAM_ID);
}

export { PROGRAM_ID };
