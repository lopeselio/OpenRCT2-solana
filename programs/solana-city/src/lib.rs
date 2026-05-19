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
    pub fn initialize_city(ctx: Context<InitializeCity>, name: String) -> Result<()> {
        city::initialize_city(ctx, name)
    }

    pub fn update_park_score(ctx: Context<UpdateParkScore>) -> Result<()> {
        city::update_park_score(ctx)
    }

    // ── Guest lifecycle ───────────────────────────────────────────────────
    pub fn register_guest(ctx: Context<RegisterGuest>, guest_id: u32, initial_balance: u64) -> Result<()> {
        guest::register_guest(ctx, guest_id, initial_balance)
    }

    pub fn delegate_guest(ctx: Context<DelegateGuest>, guest_id: u32) -> Result<()> {
        guest::delegate_guest(ctx, guest_id)
    }

    // ER: guest pays at a venue
    pub fn spend(ctx: Context<Spend>, guest_id: u32, venue_id: u32, amount: u64, category: u8) -> Result<()> {
        guest::spend(ctx, guest_id, venue_id, amount, category)
    }

    // ER: collect pending VRF prize
    pub fn claim_prize(ctx: Context<ClaimPrize>, guest_id: u32) -> Result<()> {
        guest::claim_prize(ctx, guest_id)
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
    pub fn register_venue(ctx: Context<RegisterVenue>, venue_id: u32, venue_kind: u8, name: String) -> Result<()> {
        venue::register_venue(ctx, venue_id, venue_kind, name)
    }

    pub fn delegate_venue(ctx: Context<DelegateVenue>, venue_id: u32) -> Result<()> {
        venue::delegate_venue(ctx, venue_id)
    }

    // ER: rename a live venue
    pub fn rename_venue(ctx: Context<RenameVenue>, venue_id: u32, new_name: String) -> Result<()> {
        venue::rename_venue(ctx, venue_id, new_name)
    }

    // ER: repair a broken ride (after VRF breakdown)
    pub fn repair_venue(ctx: Context<RepairVenue>, venue_id: u32) -> Result<()> {
        venue::repair_venue(ctx, venue_id)
    }

    // ER: remove a venue — commit + undelegate
    pub fn remove_venue(ctx: Context<RemoveVenue>) -> Result<()> {
        venue::remove_venue(ctx)
    }

    // Base layer: finalise venue removal after account returns from ER
    pub fn deactivate_venue(ctx: Context<DeactivateVenue>, venue_id: u32) -> Result<()> {
        venue::deactivate_venue(ctx, venue_id)
    }

    // ── VRF random events (ER) ────────────────────────────────────────────
    pub fn request_park_event(ctx: Context<RequestParkEvent>, guest_id: u32, client_seed: u8) -> Result<()> {
        vrf::request_park_event(ctx, guest_id, client_seed)
    }

    // VRF oracle callback — do not call directly
    pub fn consume_park_event(ctx: Context<ConsumeParkEvent>, randomness: [u8; 32]) -> Result<()> {
        vrf::consume_park_event(ctx, randomness)
    }

    // ER: transfer staged VRF prize from venue → guest (call before exit_guest)
    pub fn apply_vrf_result(ctx: Context<ApplyVrfResult>, _guest_id: u32, _venue_id: u32) -> Result<()> {
        vrf::apply_vrf_result(ctx)
    }

    // ── Crank (ER automated task) ─────────────────────────────────────────
    pub fn schedule_park_crank(ctx: Context<ScheduleParkCrank>, args: ScheduleCrankArgs) -> Result<()> {
        crank::schedule_park_crank(ctx, args)
    }

    // Called automatically every 30s by the ER — do not call manually
    pub fn auto_park_tick(ctx: Context<AutoParkTick>) -> Result<()> {
        crank::auto_park_tick(ctx)
    }
}
