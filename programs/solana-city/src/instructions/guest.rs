use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};
use crate::state::{CityState, GuestAccount, VenueAccount};
use crate::errors::CityError;

// Called when a guest buys a park ticket — base layer
pub fn register_guest(
    ctx: Context<RegisterGuest>,
    _park_id: u32,
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

    msg!("Guest {} entered park {} with {} PARK", guest_id, _park_id, initial_balance);
    Ok(())
}

// Delegate guest PDA to ER — base layer (then all operations go to ER)
pub fn delegate_guest(ctx: Context<DelegateGuest>, park_id: u32, guest_id: u32) -> Result<()> {
    let park_bytes = park_id.to_le_bytes();
    let id_bytes = guest_id.to_le_bytes();
    ctx.accounts.delegate_guest(
        &ctx.accounts.payer,
        &[b"guest", park_bytes.as_ref(), id_bytes.as_ref()],
        DelegateConfig::default(),
    )?;
    Ok(())
}

// Guest spends at a venue — ephemeral rollup (~10-50ms)
pub fn spend(
    ctx: Context<Spend>,
    _park_id: u32,
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

// Claim any pending VRF prize and finalize guest exit — base layer
// Called after exit_guest returns the account to the base layer.
// Sets is_active = false (exit_guest cannot do this — see its docs).
pub fn claim_prize(ctx: Context<ClaimPrize>, _park_id: u32, _guest_id: u32) -> Result<()> {
    let guest = &mut ctx.accounts.guest;
    let city = &mut ctx.accounts.city;

    if guest.pending_prize > 0 {
        let prize = guest.pending_prize;
        guest.balance += prize;
        guest.pending_prize = 0;
        city.total_revenue = city.total_revenue.saturating_sub(prize);
        msg!("Guest {} claimed prize: {} PARK", guest.guest_id, prize);
    }

    // Finalize exit: mark guest inactive and update city headcount.
    // Guard against double-calling claim_prize on the same guest.
    if guest.is_active {
        guest.is_active = false;
        city.active_guests = city.active_guests.saturating_sub(1);
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
//
// IMPORTANT: do NOT write to the guest account here.  The ER magic program
// calls set_account_owner_to_delegation_program during commit_and_undelegate,
// which revokes the original-program write permission for this instruction.
// Any account data modification in the same instruction as commit_and_undelegate
// will fail with ExternalAccountDataModified at end-of-instruction validation.
// is_active is cleared by claim_prize on the base layer after the account returns.
pub fn exit_guest(ctx: Context<ExitGuest>) -> Result<()> {
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.guest.to_account_info()])
    .build_and_invoke()?;

    msg!("Guest exit scheduled — account will return to base layer");
    Ok(())
}

// ─── Contexts ──────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(park_id: u32, guest_id: u32)]
pub struct RegisterGuest<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"city", park_id.to_le_bytes().as_ref()], bump = city.bump)]
    pub city: Account<'info, CityState>,
    #[account(
        init,
        payer = payer,
        space = GuestAccount::LEN,
        seeds = [b"guest", park_id.to_le_bytes().as_ref(), guest_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub guest: Account<'info, GuestAccount>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(park_id: u32, guest_id: u32)]
pub struct DelegateGuest<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: PDA to delegate to ER
    #[account(mut, del, seeds = [b"guest", park_id.to_le_bytes().as_ref(), guest_id.to_le_bytes().as_ref()], bump)]
    pub guest: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(park_id: u32, guest_id: u32, venue_id: u32)]
pub struct Spend<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"guest", park_id.to_le_bytes().as_ref(), guest_id.to_le_bytes().as_ref()], bump = guest.bump)]
    pub guest: Account<'info, GuestAccount>,
    #[account(mut, seeds = [b"venue", park_id.to_le_bytes().as_ref(), venue_id.to_le_bytes().as_ref()], bump = venue.bump)]
    pub venue: Account<'info, VenueAccount>,
}

#[derive(Accounts)]
#[instruction(park_id: u32, guest_id: u32)]
pub struct ClaimPrize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"guest", park_id.to_le_bytes().as_ref(), guest_id.to_le_bytes().as_ref()], bump = guest.bump)]
    pub guest: Account<'info, GuestAccount>,
    #[account(mut, seeds = [b"city", park_id.to_le_bytes().as_ref()], bump = city.bump)]
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
    // AccountInfo (not Account<T>) so Anchor never serializes this account on exit.
    // Any write here would fail with ExternalAccountDataModified — see exit_guest docs.
    /// CHECK: delegated guest PDA; verified by the caller via PDA derivation
    #[account(mut)]
    pub guest: AccountInfo<'info>,
}
