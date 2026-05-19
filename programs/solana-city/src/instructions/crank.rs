// MagicBlock crank — scheduled task that runs automatically on the Ephemeral Rollup
//
// schedule_park_crank schedules auto_park_tick to run every 30 seconds.
// auto_park_tick commits all city-level state and recalculates the park score.
// No external server needed — the ER runs this automatically.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
};
use ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID;
use magicblock_magic_program_api::{args::ScheduleTaskArgs, instruction::MagicBlockInstruction};
use crate::state::CityState;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct ScheduleCrankArgs {
    pub task_id: u64,
    pub interval_millis: u64, // 30_000 = 30 seconds
    pub iterations: u64,      // u64::MAX ≈ run forever
}

pub fn schedule_park_crank(ctx: Context<ScheduleParkCrank>, _park_id: u32, args: ScheduleCrankArgs) -> Result<()> {
    // Build the instruction the crank will call (auto_park_tick).
    // The city key is baked in at schedule-time so auto_park_tick knows which park to tick.
    let tick_ix = Instruction {
        program_id: crate::ID,
        accounts: vec![AccountMeta::new(ctx.accounts.city.key(), false)],
        data: anchor_lang::InstructionData::data(&crate::instruction::AutoParkTick {}),
    };

    let ix_data = bincode::serialize(&MagicBlockInstruction::ScheduleTask(ScheduleTaskArgs {
        task_id: args.task_id as i64,
        execution_interval_millis: args.interval_millis as i64,
        iterations: args.iterations as i64,
        instructions: vec![tick_ix],
    }))
    .map_err(|_| anchor_lang::error::Error::from(anchor_lang::error::AnchorError {
        error_name: "SerializationError".to_string(),
        error_code_number: 6000,
        error_msg: "Failed to serialize crank instruction".to_string(),
        error_origin: None,
        compared_values: None,
    }))?;

    let schedule_ix = Instruction::new_with_bytes(
        MAGIC_PROGRAM_ID,
        &ix_data,
        vec![
            AccountMeta::new(ctx.accounts.payer.key(), true),
            AccountMeta::new(ctx.accounts.city.key(), false),
        ],
    );

    invoke(
        &schedule_ix,
        &[
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.city.to_account_info(),
        ],
    )?;

    msg!("Park crank scheduled: every {}ms, {} iterations", args.interval_millis, args.iterations);
    Ok(())
}

// Called automatically every 30 seconds by the ER crank.
// The city key is baked into the crank schedule at schedule-time, so no seeds
// constraint is needed here — Anchor verifies the account is a CityState via discriminator.
pub fn auto_park_tick(ctx: Context<AutoParkTick>) -> Result<()> {
    let city = &mut ctx.accounts.city;

    // Recalculate park score
    let guest_bonus = (city.active_guests as u32).min(200);
    let revenue_bonus = ((city.total_revenue / 1_000_000) as u32).min(300);
    city.park_score = (500 + guest_bonus + revenue_bonus).min(1000);

    msg!(
        "Park tick — park_id: {}, guests: {}, revenue: {}, score: {}",
        city.park_id,
        city.active_guests,
        city.total_revenue,
        city.park_score,
    );
    Ok(())
}

// ─── Contexts ──────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(park_id: u32)]
pub struct ScheduleParkCrank<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"city", park_id.to_le_bytes().as_ref()], bump = city.bump)]
    pub city: Account<'info, CityState>,
    /// CHECK: Magic program for scheduling
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct AutoParkTick<'info> {
    // No seeds constraint — the specific city key was baked in at schedule_park_crank time.
    // Anchor validates this is a CityState via account discriminator.
    #[account(mut)]
    pub city: Account<'info, CityState>,
}
