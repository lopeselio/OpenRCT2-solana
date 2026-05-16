use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};
use crate::state::{CityState, GuestAccount, VenueAccount};
use crate::errors::CityError;

// Called when a guest buys a park ticket — base layer
pub fn register_guest(
    ctx: Context<RegisterGuest>,
    guest_id: u32,
    initial_balance: u64,
) -> Result<()> {
    let guest = &mut ctx.accounts.guest;
    guest.guest_id = guest_id;
    guest.balance = initial_balance;
    guest.total_spent = 0;
    guest.entry_time = Clock::get()?.unix_timestamp;
    guest.is_active = true;
    guest.pending_prize = 0;
    guest.bump = ctx.bumps.guest;

    let city = &mut ctx.accounts.city;
    city.total_guests_ever += 1;
    city.active_guests += 1;

    msg!("Guest {} entered with {} PARK", guest_id, initial_balance);
    Ok(())
}

// Delegate guest PDA to ER — base layer (then all operations go to ER)
pub fn delegate_guest(ctx: Context<DelegateGuest>, guest_id: u32) -> Result<()> {
    let id_bytes = guest_id.to_le_bytes();
    ctx.accounts.delegate_guest(
        &ctx.accounts.payer,
        &[b"guest", id_bytes.as_ref()],
        DelegateConfig::default(),
    )?;
    Ok(())
}

// Guest spends at a venue — ephemeral rollup (~10-50ms)
pub fn spend(
    ctx: Context<Spend>,
    _guest_id: u32,
    _venue_id: u32,
    amount: u64,
    _category: u8,
) -> Result<()> {
    let guest = &mut ctx.accounts.guest;
    let venue = &mut ctx.accounts.venue;

    require!(guest.is_active, CityError::GuestNotActive);
    require!(!venue.is_broken, CityError::VenueBroken);
    require!(guest.balance >= amount, CityError::InsufficientBalance);

    guest.balance -= amount;
    guest.total_spent += amount;
    venue.total_revenue += amount;

    Ok(())
}

// Claim any pending VRF prize — ephemeral rollup
// (Prize was set by consume_randomness callback)
pub fn claim_prize(ctx: Context<ClaimPrize>, _guest_id: u32) -> Result<()> {
    let guest = &mut ctx.accounts.guest;
    let city = &mut ctx.accounts.city;

    if guest.pending_prize > 0 {
        let prize = guest.pending_prize;
        guest.balance += prize;
        guest.pending_prize = 0;
        city.total_revenue = city.total_revenue.saturating_sub(prize); // funded by park
        msg!("Guest {} claimed prize: {} PARK", guest.guest_id, prize);
    }
    Ok(())
}

// Periodic mid-session commit — keeps base layer in sync — ephemeral rollup
pub fn commit_guest(ctx: Context<CommitGuest>) -> Result<()> {
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit(&[ctx.accounts.guest.to_account_info()])
    .build_and_invoke()?;
    Ok(())
}

// Guest exits — final commit + undelegate — ephemeral rollup
pub fn exit_guest(ctx: Context<ExitGuest>) -> Result<()> {
    ctx.accounts.guest.is_active = false;

    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.guest.to_account_info()])
    .build_and_invoke()?;

    msg!(
        "Guest {} exited. Spent: {} PARK. Remaining: {} PARK",
        ctx.accounts.guest.guest_id,
        ctx.accounts.guest.total_spent,
        ctx.accounts.guest.balance,
    );
    Ok(())
}

// ─── Contexts ──────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(guest_id: u32)]
pub struct RegisterGuest<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"city"], bump = city.bump)]
    pub city: Account<'info, CityState>,
    #[account(
        init,
        payer = payer,
        space = GuestAccount::LEN,
        seeds = [b"guest", guest_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub guest: Account<'info, GuestAccount>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(guest_id: u32)]
pub struct DelegateGuest<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: PDA to delegate to ER
    #[account(mut, del, seeds = [b"guest", guest_id.to_le_bytes().as_ref()], bump)]
    pub guest: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(guest_id: u32, venue_id: u32)]
pub struct Spend<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"guest", guest_id.to_le_bytes().as_ref()], bump = guest.bump)]
    pub guest: Account<'info, GuestAccount>,
    #[account(mut, seeds = [b"venue", venue_id.to_le_bytes().as_ref()], bump = venue.bump)]
    pub venue: Account<'info, VenueAccount>,
}

#[derive(Accounts)]
#[instruction(guest_id: u32)]
pub struct ClaimPrize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"guest", guest_id.to_le_bytes().as_ref()], bump = guest.bump)]
    pub guest: Account<'info, GuestAccount>,
    #[account(mut, seeds = [b"city"], bump = city.bump)]
    pub city: Account<'info, CityState>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitGuest<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub guest: Account<'info, GuestAccount>,
}

#[commit]
#[derive(Accounts)]
pub struct ExitGuest<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub guest: Account<'info, GuestAccount>,
}
