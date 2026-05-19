// VRF-powered random park events — runs on the Ephemeral Rollup
//
// Events triggered by randomness:
//   0–19   → Ride breakdown (venue.is_broken = true)
//   20–49  → Nothing happens
//   50–79  → Lucky guest prize (50–500 PARK tokens) — staged in venue.pending_prize
//   80–99  → Park bonus: guest gets +10 PARK — staged in venue.pending_prize
//
// IMPORTANT: consume_park_event does NOT write to guest directly. Prize/bonus
// results are staged in venue.pending_prize so that the guest account is never
// "externally modified" from the ER's perspective. Clients must call
// apply_vrf_result (also on the ER) to transfer the staged prize to the guest
// before calling exit_guest — this resets the ER's modification tracking so
// commit_and_undelegate succeeds.

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
            // guest is READ-ONLY — the VRF oracle must not write to it, otherwise
            // the ER flags it as externally-modified and blocks commit_and_undelegate.
            SerializableAccountMeta {
                pubkey: ctx.accounts.guest.key(),
                is_signer: false,
                is_writable: false,
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
            venue.pending_prize = prize;
            venue.pending_prize_guest_id = ctx.accounts.guest.guest_id;
            msg!(
                "RANDOM EVENT: Guest {} wins {} PARK! (roll={}) — staged in venue",
                ctx.accounts.guest.guest_id, prize, roll
            );
        }
        80..=99 => {
            venue.pending_prize = 10_000;
            venue.pending_prize_guest_id = ctx.accounts.guest.guest_id;
            msg!(
                "RANDOM EVENT: Park bonus! Guest {} gets 10 PARK. (roll={}) — staged in venue",
                ctx.accounts.guest.guest_id, roll
            );
        }
        _ => unreachable!(),
    }

    Ok(())
}

// Transfers any staged prize/bonus from venue → guest (ER instruction).
// Must be called by the client AFTER consume_park_event resolves and BEFORE
// exit_guest, so that the last write to guest comes from our program rather
// than the VRF oracle.
pub fn apply_vrf_result(ctx: Context<ApplyVrfResult>) -> Result<()> {
    let prize = ctx.accounts.venue.pending_prize;
    if prize > 0 {
        ctx.accounts.guest.pending_prize += prize;
        ctx.accounts.venue.pending_prize = 0;
        ctx.accounts.venue.pending_prize_guest_id = 0;
        msg!(
            "VRF prize applied: {} PARK → guest {}",
            prize,
            ctx.accounts.guest.guest_id
        );
    } else {
        msg!("apply_vrf_result: no pending prize in venue");
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
    // Read-only: we only need guest_id to record which guest gets the prize.
    pub guest: Account<'info, GuestAccount>,
    #[account(mut)]
    pub venue: Account<'info, VenueAccount>,
}

#[derive(Accounts)]
#[instruction(guest_id: u32, venue_id: u32)]
pub struct ApplyVrfResult<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"guest", guest_id.to_le_bytes().as_ref()], bump = guest.bump)]
    pub guest: Account<'info, GuestAccount>,
    #[account(
        mut,
        seeds = [b"venue", venue_id.to_le_bytes().as_ref()],
        bump = venue.bump,
        constraint = venue.pending_prize_guest_id == guest_id || venue.pending_prize == 0,
    )]
    pub venue: Account<'info, VenueAccount>,
}
