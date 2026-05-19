use anchor_lang::prelude::*;
use crate::state::{CityState, Leaderboard, LeaderboardEntry};

pub fn initialize_leaderboard(ctx: Context<InitializeLeaderboard>) -> Result<()> {
    ctx.accounts.leaderboard.bump = ctx.bumps.leaderboard;
    Ok(())
}

pub fn submit_score(ctx: Context<SubmitScore>) -> Result<()> {
    let city = &ctx.accounts.city;
    let leaderboard = &mut ctx.accounts.leaderboard;
    let city_key = ctx.accounts.city.key();

    // Update existing entry if this city is already on the board
    if let Some(idx) = leaderboard.entries.iter().position(|e| e.park == city_key) {
        leaderboard.entries[idx].revenue = city.total_revenue;
        leaderboard.entries[idx].name = city.name;
    } else {
        // Find the lowest-revenue slot (empty slots have revenue = 0 and park = default)
        let (min_idx, min_entry) = leaderboard
            .entries
            .iter()
            .enumerate()
            .min_by_key(|(_, e)| e.revenue)
            .unwrap();

        if min_entry.park == Pubkey::default() || city.total_revenue > min_entry.revenue {
            leaderboard.entries[min_idx] = LeaderboardEntry {
                park: city_key,
                name: city.name,
                revenue: city.total_revenue,
            };
        }
    }

    // Keep entries sorted descending so index 0 is the top-ranked park
    leaderboard.entries.sort_unstable_by(|a, b| b.revenue.cmp(&a.revenue));
    Ok(())
}

// ─── Contexts ──────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeLeaderboard<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = Leaderboard::LEN,
        seeds = [b"leaderboard"],
        bump,
    )]
    pub leaderboard: Account<'info, Leaderboard>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitScore<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"leaderboard"], bump = leaderboard.bump)]
    pub leaderboard: Account<'info, Leaderboard>,
    pub city: Account<'info, CityState>,
}
