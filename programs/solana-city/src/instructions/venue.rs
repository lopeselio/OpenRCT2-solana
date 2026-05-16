use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};
use crate::state::{CityState, VenueAccount};
use crate::errors::CityError;

pub fn register_venue(
    ctx: Context<RegisterVenue>,
    venue_id: u32,
    venue_kind: u8,
    name: String,
) -> Result<()> {
    require!(name.len() <= 32, CityError::NameTooLong);

    let venue = &mut ctx.accounts.venue;
    venue.venue_id = venue_id;
    venue.venue_kind = venue_kind;
    venue.total_revenue = 0;
    venue.is_active = true;
    venue.is_broken = false;
    venue.bump = ctx.bumps.venue;

    let mut name_bytes = [0u8; 32];
    name_bytes[..name.len()].copy_from_slice(name.as_bytes());
    venue.name = name_bytes;

    ctx.accounts.city.venue_count += 1;
    msg!("Venue {} '{}' registered (kind={})", venue_id, name, venue_kind);
    Ok(())
}

pub fn delegate_venue(ctx: Context<DelegateVenue>, venue_id: u32) -> Result<()> {
    let id_bytes = venue_id.to_le_bytes();
    ctx.accounts.delegate_venue(
        &ctx.accounts.payer,
        &[b"venue", id_bytes.as_ref()],
        DelegateConfig::default(),
    )?;
    Ok(())
}

// Rename a venue while it is delegated — ephemeral rollup
pub fn rename_venue(ctx: Context<RenameVenue>, _venue_id: u32, new_name: String) -> Result<()> {
    require!(new_name.len() <= 32, CityError::NameTooLong);

    let mut name_bytes = [0u8; 32];
    name_bytes[..new_name.len()].copy_from_slice(new_name.as_bytes());
    ctx.accounts.venue.name = name_bytes;
    Ok(())
}

// Repair a broken ride (after VRF breakdown event) — ephemeral rollup
pub fn repair_venue(ctx: Context<RepairVenue>, _venue_id: u32) -> Result<()> {
    ctx.accounts.venue.is_broken = false;
    msg!("Venue {} repaired", ctx.accounts.venue.venue_id);
    Ok(())
}

// Remove a venue — commit final revenue + undelegate — ephemeral rollup
pub fn remove_venue(ctx: Context<RemoveVenue>) -> Result<()> {
    ctx.accounts.venue.is_active = false;

    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.venue.to_account_info()])
    .build_and_invoke()?;

    ctx.accounts.city.venue_count = ctx.accounts.city.venue_count.saturating_sub(1);
    msg!("Venue {} removed", ctx.accounts.venue.venue_id);
    Ok(())
}

// ─── Contexts ──────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(venue_id: u32)]
pub struct RegisterVenue<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"city"], bump = city.bump)]
    pub city: Account<'info, CityState>,
    #[account(
        init,
        payer = payer,
        space = VenueAccount::LEN,
        seeds = [b"venue", venue_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub venue: Account<'info, VenueAccount>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(venue_id: u32)]
pub struct DelegateVenue<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: PDA to delegate to ER
    #[account(mut, del, seeds = [b"venue", venue_id.to_le_bytes().as_ref()], bump)]
    pub venue: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(venue_id: u32)]
pub struct RenameVenue<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"venue", venue_id.to_le_bytes().as_ref()], bump = venue.bump)]
    pub venue: Account<'info, VenueAccount>,
}

#[derive(Accounts)]
#[instruction(venue_id: u32)]
pub struct RepairVenue<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"venue", venue_id.to_le_bytes().as_ref()], bump = venue.bump)]
    pub venue: Account<'info, VenueAccount>,
}

#[commit]
#[derive(Accounts)]
pub struct RemoveVenue<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub venue: Account<'info, VenueAccount>,
    #[account(mut, seeds = [b"city"], bump = city.bump)]
    pub city: Account<'info, CityState>,
}
