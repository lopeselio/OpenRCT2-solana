use anchor_lang::prelude::*;

// Park-wide singleton — lives on base layer, never delegated
#[account]
pub struct CityState {
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
    pub const LEN: usize = 8 + 32 + 32 + 8 + 4 + 8 + 4 + 4 + 1;
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
}

impl VenueAccount {
    pub const LEN: usize = 8 + 4 + 1 + 32 + 8 + 1 + 1 + 1;
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
