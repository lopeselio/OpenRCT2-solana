// VRF-powered random park events — runs on the Ephemeral Rollup
//
// Events triggered by randomness:
//   0–19   → Ride breakdown (venue.is_broken = true)
//   20–49  → Nothing happens
//   50–79  → Lucky guest prize (50–500 PARK tokens)
//   80–99  → Park bonus: guest gets +10 PARK
//
// Each call to request_park_event triggers one random roll per guest visit.
// The VRF oracle calls consume_park_event asynchronously.

use anchor_lang::prelude::*;
use ephemeral_vrf_sdk::anchor::vrf;
use ephemeral_vrf_sdk::instructions::{create_request_randomness_ix, RequestRandomnessParams};
use ephemeral_vrf_sdk::types::SerializableAccountMeta;
use crate::state::{GuestAccount, VenueAccount};

pub fn request_park_event(
    ctx: Context<RequestParkEvent>,
    guest_id: u32,
    client_seed: u8,
) -> Result<()> {
    let ix = create_request_randomness_ix(RequestRandomnessParams {
        payer: ctx.accounts.payer.key(),
        oracle_queue: ctx.accounts.oracle_queue.key(),
        callback_program_id: crate::ID,
        callback_discriminator: crate::instruction::ConsumeParkEvent::DISCRIMINATOR.to_vec(),
        caller_seed: [client_seed; 32],
        accounts_metas: Some(vec![
            SerializableAccountMeta {
                pubkey: ctx.accounts.guest.key(),
                is_signer: false,
                is_writable: true,
            },
            SerializableAccountMeta {
                pubkey: ctx.accounts.venue.key(),
                is_signer: false,
                is_writable: true,
            },
        ]),
        ..Default::default()
    });

    ctx.accounts.invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;

    msg!("VRF event requested for guest {}", guest_id);
    Ok(())
}

pub fn consume_park_event(
    ctx: Context<ConsumeParkEvent>,
    randomness: [u8; 32],
) -> Result<()> {
    let roll = ephemeral_vrf_sdk::rnd::random_u8_with_range(&randomness, 0, 99);

    let guest = &mut ctx.accounts.guest;
    let venue = &mut ctx.accounts.venue;

    match roll {
        0..=19 => {
            venue.is_broken = true;
            msg!("RANDOM EVENT: Venue {} broke down! (roll={})", venue.venue_id, roll);
        }
        20..=49 => {
            msg!("RANDOM EVENT: Quiet moment. (roll={})", roll);
        }
        50..=79 => {
            let prize = 50_000 + ephemeral_vrf_sdk::rnd::random_u64(&randomness) % 450_001;
            guest.pending_prize += prize;
            msg!(
                "RANDOM EVENT: Guest {} wins {} PARK! (roll={})",
                guest.guest_id, prize, roll
            );
        }
        80..=99 => {
            guest.balance += 10_000;
            msg!("RANDOM EVENT: Park bonus! Guest {} gets 10 PARK. (roll={})", guest.guest_id, roll);
        }
        _ => unreachable!(),
    }

    Ok(())
}

// ─── Contexts ──────────────────────────────────────────────────────────────

#[vrf]
#[derive(Accounts)]
#[instruction(guest_id: u32)]
pub struct RequestParkEvent<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"guest", guest_id.to_le_bytes().as_ref()], bump = guest.bump)]
    pub guest: Account<'info, GuestAccount>,
    #[account(mut)]
    pub venue: Account<'info, VenueAccount>,
    /// CHECK: VRF oracle queue
    #[account(mut, address = ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct ConsumeParkEvent<'info> {
    /// SECURITY: Only VRF program can call this callback
    #[account(address = ephemeral_vrf_sdk::consts::VRF_PROGRAM_IDENTITY)]
    pub vrf_program_identity: Signer<'info>,
    #[account(mut)]
    pub guest: Account<'info, GuestAccount>,
    #[account(mut)]
    pub venue: Account<'info, VenueAccount>,
}
