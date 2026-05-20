use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("2ce1z7iFfMB6BHzaWvT5jqhsDsS6jeEjvymGYwrb8wDn");

#[ephemeral_rollups_sdk::anchor::ephemeral]
#[program]
pub mod solana_city {
    use super::*;

    // ── City lifecycle ────────────────────────────────────────────────────
    pub fn initialize_city(ctx: Context<InitializeCity>, park_id: u32, name: String) -> Result<()> {
        city::initialize_city(ctx, park_id, name)
    }

    pub fn update_park_score(
        ctx: Context<UpdateParkScore>,
        park_id: u32,
        new_total_revenue: u64,
    ) -> Result<()> {
        city::update_park_score(ctx, park_id, new_total_revenue)
    }

    // ── Guest lifecycle ───────────────────────────────────────────────────
    pub fn register_guest(ctx: Context<RegisterGuest>, park_id: u32, guest_id: u32, initial_balance: u64) -> Result<()> {
        guest::register_guest(ctx, park_id, guest_id, initial_balance)
    }

    pub fn delegate_guest(ctx: Context<DelegateGuest>, park_id: u32, guest_id: u32) -> Result<()> {
        guest::delegate_guest(ctx, park_id, guest_id)
    }

    // Re-entry on an existing guest PDA — base layer
    pub fn reactivate_guest(
        ctx: Context<ReactivateGuest>,
        park_id: u32,
        guest_id: u32,
        new_balance: u64,
    ) -> Result<()> {
        guest::reactivate_guest(ctx, park_id, guest_id, new_balance)
    }

    // ER: guest pays at a venue
    pub fn spend(ctx: Context<Spend>, park_id: u32, guest_id: u32, venue_id: u32, amount: u64, category: u8) -> Result<()> {
        guest::spend(ctx, park_id, guest_id, venue_id, amount, category)
    }

    // ER: collect pending VRF prize
    pub fn claim_prize(ctx: Context<ClaimPrize>, park_id: u32, guest_id: u32) -> Result<()> {
        guest::claim_prize(ctx, park_id, guest_id)
    }

    // ER: sync state to base layer without undelegating
    pub fn commit_guest(ctx: Context<CommitGuest>) -> Result<()> {
        guest::commit_guest(ctx)
    }

    // ER: guest leaves — final commit + undelegate
    pub fn exit_guest(ctx: Context<ExitGuest>) -> Result<()> {
        guest::exit_guest(ctx)
    }

    // ── Venue lifecycle ───────────────────────────────────────────────────
    pub fn register_venue(ctx: Context<RegisterVenue>, park_id: u32, venue_id: u32, venue_kind: u8, name: String) -> Result<()> {
        venue::register_venue(ctx, park_id, venue_id, venue_kind, name)
    }

    pub fn delegate_venue(ctx: Context<DelegateVenue>, park_id: u32, venue_id: u32) -> Result<()> {
        venue::delegate_venue(ctx, park_id, venue_id)
    }

    // ER: rename a live venue
    pub fn rename_venue(ctx: Context<RenameVenue>, park_id: u32, venue_id: u32, new_name: String) -> Result<()> {
        venue::rename_venue(ctx, park_id, venue_id, new_name)
    }

    // ER: repair a broken ride (after VRF breakdown)
    pub fn repair_venue(ctx: Context<RepairVenue>, park_id: u32, venue_id: u32) -> Result<()> {
        venue::repair_venue(ctx, park_id, venue_id)
    }

    // ER: remove a venue — commit + undelegate
    pub fn remove_venue(ctx: Context<RemoveVenue>, park_id: u32) -> Result<()> {
        venue::remove_venue(ctx, park_id)
    }

    // Base layer: finalise venue removal after account returns from ER
    pub fn deactivate_venue(ctx: Context<DeactivateVenue>, park_id: u32, venue_id: u32) -> Result<()> {
        venue::deactivate_venue(ctx, park_id, venue_id)
    }

    // ── $PARK SPL Token ───────────────────────────────────────────────────
    pub fn initialize_park_mint(ctx: Context<InitializeParkMint>) -> Result<()> {
        token::initialize_park_mint(ctx)
    }

    pub fn redeem_balance(ctx: Context<RedeemBalance>, guest_id: u32) -> Result<()> {
        token::redeem_balance(ctx, guest_id)
    }

    // One-shot: attach Metaplex Token Metadata to the park mint
    pub fn create_park_metadata(ctx: Context<CreateParkMetadata>, name: String, symbol: String, uri: String) -> Result<()> {
        token::create_park_metadata(ctx, name, symbol, uri)
    }

    // ── Ride Revenue Staking ──────────────────────────────────────────────
    pub fn create_stake_vault(ctx: Context<CreateStakeVault>, park_id: u32, venue_id: u32) -> Result<()> {
        staking::create_stake_vault(ctx, park_id, venue_id)
    }

    pub fn stake(ctx: Context<Stake>, park_id: u32, venue_id: u32, amount: u64) -> Result<()> {
        staking::stake(ctx, park_id, venue_id, amount)
    }

    pub fn unstake(ctx: Context<Unstake>, park_id: u32, venue_id: u32) -> Result<()> {
        staking::unstake(ctx, park_id, venue_id)
    }

    pub fn claim_stake_rewards(ctx: Context<ClaimStakeRewards>, park_id: u32, venue_id: u32) -> Result<()> {
        staking::claim_stake_rewards(ctx, park_id, venue_id)
    }

    // ── Leaderboard ───────────────────────────────────────────────────────
    pub fn initialize_leaderboard(ctx: Context<InitializeLeaderboard>) -> Result<()> {
        leaderboard::initialize_leaderboard(ctx)
    }

    pub fn submit_score(ctx: Context<SubmitScore>) -> Result<()> {
        leaderboard::submit_score(ctx)
    }

    // ── VRF random events (ER) ────────────────────────────────────────────
    pub fn request_park_event(ctx: Context<RequestParkEvent>, park_id: u32, guest_id: u32, client_seed: u8) -> Result<()> {
        vrf::request_park_event(ctx, guest_id, client_seed)
    }

    // VRF oracle callback — do not call directly
    pub fn consume_park_event(ctx: Context<ConsumeParkEvent>, randomness: [u8; 32]) -> Result<()> {
        vrf::consume_park_event(ctx, randomness)
    }

    // ER: transfer staged VRF prize from venue → guest (call before exit_guest)
    pub fn apply_vrf_result(ctx: Context<ApplyVrfResult>, park_id: u32, guest_id: u32, venue_id: u32) -> Result<()> {
        vrf::apply_vrf_result(ctx)
    }

    // ── Milestone Badges ─────────────────────────────────────────────────
    pub fn claim_badge(ctx: Context<ClaimBadge>, park_id: u32, tier: u8) -> Result<()> {
        badges::claim_badge(ctx, park_id, tier)
    }

    // ── Crank (ER automated task) ─────────────────────────────────────────
    pub fn schedule_park_crank(ctx: Context<ScheduleParkCrank>, park_id: u32, args: ScheduleCrankArgs) -> Result<()> {
        crank::schedule_park_crank(ctx, park_id, args)
    }

    // Called automatically every 30s by the ER — do not call manually
    pub fn auto_park_tick(ctx: Context<AutoParkTick>) -> Result<()> {
        crank::auto_park_tick(ctx)
    }
}
