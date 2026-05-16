use anchor_lang::prelude::*;
use crate::state::CityState;
use crate::errors::CityError;

pub fn initialize_city(ctx: Context<InitializeCity>, name: String) -> Result<()> {
    require!(name.len() <= 32, CityError::NameTooLong);

    let city = &mut ctx.accounts.city;
    city.authority = ctx.accounts.authority.key();
    city.bump = ctx.bumps.city;
    city.total_guests_ever = 0;
    city.active_guests = 0;
    city.total_revenue = 0;
    city.venue_count = 0;
    city.park_score = 500; // start at neutral score

    let mut name_bytes = [0u8; 32];
    name_bytes[..name.len()].copy_from_slice(name.as_bytes());
    city.name = name_bytes;

    msg!("Solana City '{}' initialized on-chain", name);
    Ok(())
}

// Called by the crank every 30s to recalculate park score from active state
pub fn update_park_score(ctx: Context<UpdateParkScore>) -> Result<()> {
    let city = &mut ctx.accounts.city;

    // Score formula: base 500 + guests bonus + revenue bonus, capped at 1000
    let guest_bonus = (city.active_guests as u32).min(200);
    let revenue_bonus = ((city.total_revenue / 1_000_000) as u32).min(300);
    city.park_score = (500 + guest_bonus + revenue_bonus).min(1000);

    msg!("Park score updated to {}", city.park_score);
    Ok(())
}

// ─── Contexts ──────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeCity<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = CityState::LEN,
        seeds = [b"city"],
        bump,
    )]
    pub city: Account<'info, CityState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateParkScore<'info> {
    #[account(mut, seeds = [b"city"], bump = city.bump)]
    pub city: Account<'info, CityState>,
}
