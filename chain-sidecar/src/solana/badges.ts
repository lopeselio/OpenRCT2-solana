import { Program } from "@coral-xyz/anchor";
import { baseProvider, signer } from "./clients";
import {
  badgePda,
  cityPda,
  BADGE_TIER_THRESHOLDS,
  BADGE_TIER_NAMES,
  PARK_ID,
} from "./accounts";

// In-memory cache of which tiers we've already claimed this session. Avoids
// re-fetching the badge PDAs every score tick once we know they're claimed.
const claimedTiers = new Set<number>();

/**
 * Returns the list of tier indices currently claimed on-chain.
 * Reads PDAs from base; once a tier is observed claimed it stays cached.
 */
export async function getClaimedBadges(baseProgram: Program): Promise<number[]> {
  const [city] = cityPda();
  for (let tier = 0; tier < BADGE_TIER_THRESHOLDS.length; tier++) {
    if (claimedTiers.has(tier)) continue;
    const [pda] = badgePda(city, tier);
    const info = await baseProvider.connection.getAccountInfo(pda);
    if (info !== null) claimedTiers.add(tier);
  }
  return Array.from(claimedTiers).sort((a, b) => a - b);
}

/**
 * Inspect city.total_guests_ever and call claim_badge for every tier whose
 * threshold has been met but whose PDA doesn't yet exist on-chain. Idempotent.
 */
export async function tickBadgeClaims(baseProgram: Program): Promise<void> {
  const [city] = cityPda();
  let cityAcc: any;
  try {
    cityAcc = await (baseProgram.account as any).cityState.fetch(city);
  } catch {
    return; // No city yet — skip silently.
  }
  const totalGuests = BigInt(cityAcc.totalGuestsEver?.toString?.() ?? "0");

  for (let tier = 0; tier < BADGE_TIER_THRESHOLDS.length; tier++) {
    if (claimedTiers.has(tier)) continue;
    if (totalGuests < BigInt(BADGE_TIER_THRESHOLDS[tier])) continue;

    const [pda] = badgePda(city, tier);
    const info = await baseProvider.connection.getAccountInfo(pda);
    if (info !== null) {
      claimedTiers.add(tier);
      continue;
    }

    try {
      await baseProgram.methods
        .claimBadge(PARK_ID, tier)
        .accounts({ payer: signer.publicKey, badge: pda })
        .rpc({ commitment: "confirmed" });
      claimedTiers.add(tier);
      console.log(
        `[badge] Claimed tier ${tier} (${BADGE_TIER_NAMES[tier]}) — ${totalGuests} total guests`
      );
    } catch (err: any) {
      console.warn(
        `[badge] claim tier ${tier} failed: ${err?.message ?? err}`
      );
    }
  }
}
