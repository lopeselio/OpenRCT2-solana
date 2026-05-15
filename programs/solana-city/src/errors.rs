use anchor_lang::prelude::*;

#[error_code]
pub enum CityError {
    #[msg("Guest is not active in the park")]
    GuestNotActive,
    #[msg("Guest has insufficient balance")]
    InsufficientBalance,
    #[msg("Venue is not active")]
    VenueNotActive,
    #[msg("Ride is broken down — guests cannot use it")]
    VenueBroken,
    #[msg("Name too long (max 32 bytes)")]
    NameTooLong,
}
