import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import * as fs from "fs";
import * as path from "path";

// ─── Connections ────────────────────────────────────────────────────────────

export const baseConnection = new Connection(
  process.env.BASE_RPC ?? "https://api.devnet.solana.com",
  "confirmed"
);

export const erConnection = new Connection(
  process.env.EPHEMERAL_PROVIDER_ENDPOINT ?? "https://devnet.magicblock.app/",
  {
    wsEndpoint: process.env.EPHEMERAL_WS_ENDPOINT ?? "wss://devnet.magicblock.app/",
    commitment: "confirmed",
  }
);

// ─── Wallet ─────────────────────────────────────────────────────────────────

function loadKeypair(): Keypair {
  const keyPath =
    process.env.WALLET_PATH ??
    path.join(process.env.HOME ?? "", ".config/solana/id.json");
  const raw = JSON.parse(fs.readFileSync(keyPath, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export const signer = loadKeypair();
export const wallet = new Wallet(signer);

// ─── Providers ──────────────────────────────────────────────────────────────

export const baseProvider = new AnchorProvider(baseConnection, wallet, {
  commitment: "confirmed",
});

export const erProvider = new AnchorProvider(erConnection, wallet, {
  commitment: "confirmed",
  skipPreflight: true,
});

// ─── Helpers ────────────────────────────────────────────────────────────────

export async function isDelegated(pda: PublicKey): Promise<boolean> {
  const info = await baseConnection.getAccountInfo(pda);
  return info !== null && info.owner.equals(DELEGATION_PROGRAM_ID);
}
