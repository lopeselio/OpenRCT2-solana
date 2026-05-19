use anchor_lang::prelude::*;

// Park-wide singleton — lives on base layer, never delegated
#[account]
pub struct CityState {
    pub park_id: u32,
    pub authority: Pubkey,
    pub name: [u8; 32],
    pub total_guests_ever: u64,
    pub active_guests: u32,
    pub total_revenue: u64,
    pub venue_count: u32,
    pub park_score: u32,   // updated by crank (0–1000)
    pub bump: u8,
}

impl CityState {
    pub const LEN: usize = 8 + 4 + 32 + 32 + 8 + 4 + 8 + 4 + 4 + 1; // 105
}

// Per-guest account — delegated to ER when guest is in the park
#[account]
pub struct GuestAccount {
    pub guest_id: u32,
    pub balance: u64,       // in PARK units (1 PARK = 1_000_000)
    pub total_spent: u64,
    pub entry_time: i64,
    pub is_active: bool,
    // VRF random event results
    pub pending_prize: u64,
    pub bump: u8,
}

impl GuestAccount {
    pub const LEN: usize = 8 + 4 + 8 + 8 + 8 + 1 + 8 + 1;
}

// Per-venue account — delegated to ER while active
#[account]
pub struct VenueAccount {
    pub venue_id: u32,
    pub venue_kind: u8,     // 0=ride 1=shop 2=food 3=atm 4=facility
    pub name: [u8; 32],
    pub total_revenue: u64,
    pub is_active: bool,
    pub is_broken: bool,    // set by VRF breakdown event
    pub bump: u8,
    // VRF prize staging: consume_park_event writes here (venue is writable),
    // client calls apply_vrf_result to transfer to guest (direct write by our program).
    // This prevents guest from being flagged as externally-modified, which would
    // otherwise block commit_and_undelegate on the ER.
    pub pending_prize: u64,
    pub pending_prize_guest_id: u32,
}

impl VenueAccount {
    pub const LEN: usize = 8 + 4 + 1 + 32 + 8 + 1 + 1 + 1 + 8 + 4;
}

// SOL vault holding staked lamports for a venue — base layer only
#[account]
pub struct VenueStakeVault {
    pub venue_id: u32,
    pub total_staked: u64,           // total SOL staked (lamports)
    pub acc_reward_per_token: u128,  // accumulated PARK per staked lamport (scaled 1e9)
    pub last_synced_revenue: u64,    // venue.total_revenue at last sync
    pub bump: u8,
}

impl VenueStakeVault {
    pub const LEN: usize = 8 + 4 + 8 + 16 + 8 + 1; // 45
}

// Per-staker position for a venue — base layer only
#[account]
pub struct StakePosition {
    pub staker: Pubkey,
    pub venue_id: u32,
    pub amount: u64,       // SOL staked (lamports)
    pub reward_debt: u128, // acc_reward_per_token at last checkpoint
    pub unclaimed: u64,    // accumulated PARK rewards not yet minted
    pub bump: u8,
}

impl StakePosition {
    pub const LEN: usize = 8 + 32 + 4 + 8 + 16 + 8 + 1; // 77
}

// Milestone badge — one PDA per city per tier (base layer)
#[account]
pub struct BadgeAccount {
    pub city: Pubkey,
    pub tier: u8,           // 0=Bronze 1=Silver 2=Gold 3=Diamond
    pub awarded_at: i64,    // unix timestamp
    pub bump: u8,
}

impl BadgeAccount {
    pub const LEN: usize = 8 + 32 + 1 + 8 + 1; // 50
}

// Leaderboard — top 10 parks by revenue (optional, base layer)
#[account]
pub struct Leaderboard {
    pub entries: [LeaderboardEntry; 10],
    pub bump: u8,
}

impl Leaderboard {
    pub const LEN: usize = 8 + (LeaderboardEntry::SIZE * 10) + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct LeaderboardEntry {
    pub park: Pubkey,
    pub name: [u8; 32],
    pub revenue: u64,
}

impl LeaderboardEntry {
    pub const SIZE: usize = 32 + 32 + 8;
}
