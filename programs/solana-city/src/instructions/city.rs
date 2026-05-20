use anchor_lang::prelude::*;
use crate::state::CityState;
use crate::errors::CityError;

pub fn initialize_city(ctx: Context<InitializeCity>, park_id: u32, name: String) -> Result<()> {
    require!(name.len() <= 32, CityError::NameTooLong);

    let city = &mut ctx.accounts.city;
    city.park_id = park_id;
    city.authority = ctx.accounts.authority.key();
    city.bump = ctx.bumps.city;
    city.total_guests_ever = 0;
    city.active_guests = 0;
    city.total_revenue = 0;
    city.venue_count = 0;
    city.park_score = 500;

    let mut name_bytes = [0u8; 32];
    name_bytes[..name.len()].copy_from_slice(name.as_bytes());
    city.name = name_bytes;

    msg!("Solana City '{}' (park_id={}) initialized on-chain", name, park_id);
    Ok(())
}

// Called periodically to recalculate park score from active state.
// The caller (sidecar) precomputes total_revenue by summing all ER-side venue
// PDAs and passes it here, since spend() writes to venue.total_revenue on the
// ER and never bubbles up to city.total_revenue on the base layer.
pub fn update_park_score(
    ctx: Context<UpdateParkScore>,
    _park_id: u32,
    new_total_revenue: u64,
) -> Result<()> {
    let city = &mut ctx.accounts.city;
    city.total_revenue = new_total_revenue;

    let guest_bonus = (city.active_guests as u32).min(200);
    let revenue_bonus = ((city.total_revenue / 1_000_000) as u32).min(300);
    city.park_score = (500 + guest_bonus + revenue_bonus).min(1000);

    msg!(
        "Park score updated to {} (guests={}, revenue={})",
        city.park_score,
        city.active_guests,
        city.total_revenue
    );
    Ok(())
}

// ─── Contexts ──────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(park_id: u32)]
pub struct InitializeCity<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = CityState::LEN,
        seeds = [b"city", park_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub city: Account<'info, CityState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(park_id: u32)]
pub struct UpdateParkScore<'info> {
    #[account(mut, seeds = [b"city", park_id.to_le_bytes().as_ref()], bump = city.bump)]
    pub city: Account<'info, CityState>,
}
