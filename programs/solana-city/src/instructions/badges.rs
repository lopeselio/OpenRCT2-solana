use anchor_lang::prelude::*;
use crate::errors::CityError;
use crate::state::{BadgeAccount, CityState};

// Tier thresholds: min total_guests_ever to unlock each badge
const TIER_GUEST_MIN: [u64; 4] = [
    5,     // Bronze
    25,    // Silver
    100,   // Gold
    500,   // Diamond
];

pub fn claim_badge(ctx: Context<ClaimBadge>, _park_id: u32, tier: u8) -> Result<()> {
    require!(tier < 4, CityError::InvalidBadgeTier);

    let city = &ctx.accounts.city;
    require!(
        city.total_guests_ever >= TIER_GUEST_MIN[tier as usize],
        CityError::BadgeThresholdNotMet
    );

    let badge = &mut ctx.accounts.badge;
    badge.city = ctx.accounts.city.key();
    badge.tier = tier;
    badge.awarded_at = Clock::get()?.unix_timestamp;
    badge.bump = ctx.bumps.badge;

    msg!("Badge tier {} awarded to park {}", tier, _park_id);
    Ok(())
}

// ─── Context ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(park_id: u32, tier: u8)]
pub struct ClaimBadge<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"city", park_id.to_le_bytes().as_ref()], bump = city.bump)]
    pub city: Account<'info, CityState>,
    #[account(
        init,
        payer = payer,
        space = BadgeAccount::LEN,
        seeds = [b"badge", city.key().as_ref(), &[tier]],
        bump,
    )]
    pub badge: Account<'info, BadgeAccount>,
    pub system_program: Program<'info, System>,
}
