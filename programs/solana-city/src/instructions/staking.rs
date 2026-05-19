use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};
use crate::errors::CityError;
use crate::state::{StakePosition, VenueAccount, VenueStakeVault};

const SCALE: u128 = 1_000_000_000;

fn sync_vault(vault: &mut VenueStakeVault, current_revenue: u64) {
    if vault.total_staked == 0 {
        vault.last_synced_revenue = current_revenue;
        return;
    }
    let delta = current_revenue.saturating_sub(vault.last_synced_revenue);
    if delta > 0 {
        vault.acc_reward_per_token = vault.acc_reward_per_token.saturating_add(
            (delta as u128) * SCALE / (vault.total_staked as u128),
        );
        vault.last_synced_revenue = current_revenue;
    }
}

fn harvest(vault: &VenueStakeVault, pos: &mut StakePosition) {
    let delta = vault.acc_reward_per_token.saturating_sub(pos.reward_debt);
    let reward = ((delta * pos.amount as u128) / SCALE) as u64;
    pos.unclaimed = pos.unclaimed.saturating_add(reward);
    pos.reward_debt = vault.acc_reward_per_token;
}

pub fn create_stake_vault(ctx: Context<CreateStakeVault>, venue_id: u32) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    vault.venue_id = venue_id;
    vault.total_staked = 0;
    vault.acc_reward_per_token = 0;
    vault.last_synced_revenue = ctx.accounts.venue.total_revenue;
    vault.bump = ctx.bumps.vault;
    msg!("Stake vault created for venue {}", venue_id);
    Ok(())
}

pub fn stake(ctx: Context<Stake>, venue_id: u32, amount: u64) -> Result<()> {
    require!(amount > 0, CityError::ZeroStakeAmount);

    // Phase 1: sync vault and harvest existing position — drop borrows before CPI
    let is_new_position = ctx.accounts.position.amount == 0
        && ctx.accounts.position.staker == Pubkey::default();
    {
        let current_revenue = ctx.accounts.venue.total_revenue;
        let vault = &mut ctx.accounts.vault;
        sync_vault(vault, current_revenue);

        let pos = &mut ctx.accounts.position;
        if !is_new_position {
            harvest(vault, pos);
        } else {
            pos.staker = ctx.accounts.staker.key();
            pos.venue_id = venue_id;
            pos.reward_debt = vault.acc_reward_per_token;
            pos.unclaimed = 0;
            pos.bump = ctx.bumps.position;
        }
    }

    // Phase 2: CPI transfer — requires fresh (non-mutable) borrows of vault
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.staker.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        amount,
    )?;

    // Phase 3: update counters
    ctx.accounts.position.amount = ctx.accounts.position.amount.saturating_add(amount);
    ctx.accounts.vault.total_staked = ctx.accounts.vault.total_staked.saturating_add(amount);

    msg!("Staked {} lamports on venue {}", amount, venue_id);
    Ok(())
}

pub fn unstake(ctx: Context<Unstake>, _venue_id: u32) -> Result<()> {
    // Phase 1: sync and harvest — drop borrows before lamport manipulation
    {
        let current_revenue = ctx.accounts.venue.total_revenue;
        let vault = &mut ctx.accounts.vault;
        sync_vault(vault, current_revenue);
        let pos = &mut ctx.accounts.position;
        harvest(vault, pos);
    }

    let sol_to_return = ctx.accounts.position.amount;
    let park_to_mint = ctx.accounts.position.unclaimed;
    require!(sol_to_return > 0, CityError::NoStakeToWithdraw);

    // Phase 2: return SOL — direct lamport manipulation (vault is our PDA)
    **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= sol_to_return;
    **ctx.accounts.staker.to_account_info().try_borrow_mut_lamports()? += sol_to_return;

    // Phase 3: update state
    let new_total = ctx.accounts.vault.total_staked.saturating_sub(sol_to_return);
    ctx.accounts.vault.total_staked = new_total;
    let acc = ctx.accounts.vault.acc_reward_per_token;
    ctx.accounts.position.amount = 0;
    ctx.accounts.position.unclaimed = 0;
    ctx.accounts.position.reward_debt = acc;

    // Phase 4: mint any pending $PARK rewards
    if park_to_mint > 0 {
        mint_park(
            park_to_mint,
            ctx.bumps.park_mint,
            &ctx.accounts.park_mint,
            &ctx.accounts.staker_ata,
            &ctx.accounts.token_program,
        )?;
        msg!("Minted {} $PARK rewards on unstake", park_to_mint);
    }

    msg!("Unstaked {} lamports from venue", sol_to_return);
    Ok(())
}

pub fn claim_stake_rewards(ctx: Context<ClaimStakeRewards>, _venue_id: u32) -> Result<()> {
    {
        let current_revenue = ctx.accounts.venue.total_revenue;
        let vault = &mut ctx.accounts.vault;
        sync_vault(vault, current_revenue);
        let pos = &mut ctx.accounts.position;
        harvest(vault, pos);
    }

    let park_to_mint = ctx.accounts.position.unclaimed;
    ctx.accounts.position.unclaimed = 0;

    if park_to_mint > 0 {
        mint_park(
            park_to_mint,
            ctx.bumps.park_mint,
            &ctx.accounts.park_mint,
            &ctx.accounts.staker_ata,
            &ctx.accounts.token_program,
        )?;
        msg!("Claimed {} $PARK staking rewards", park_to_mint);
    }
    Ok(())
}

fn mint_park<'info>(
    amount: u64,
    mint_bump: u8,
    park_mint: &Account<'info, Mint>,
    dest_ata: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
) -> Result<()> {
    let signer_seeds: &[&[&[u8]]] = &[&[b"park_mint", &[mint_bump]]];
    token::mint_to(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            MintTo {
                mint: park_mint.to_account_info(),
                to: dest_ata.to_account_info(),
                authority: park_mint.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )
}

// ─── Contexts ──────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(venue_id: u32)]
pub struct CreateStakeVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = VenueStakeVault::LEN,
        seeds = [b"vault", venue_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub vault: Account<'info, VenueStakeVault>,
    #[account(seeds = [b"venue", venue_id.to_le_bytes().as_ref()], bump = venue.bump)]
    pub venue: Account<'info, VenueAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(venue_id: u32)]
pub struct Stake<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,
    #[account(mut, seeds = [b"vault", venue_id.to_le_bytes().as_ref()], bump = vault.bump)]
    pub vault: Account<'info, VenueStakeVault>,
    #[account(
        init_if_needed,
        payer = staker,
        space = StakePosition::LEN,
        seeds = [b"stake", venue_id.to_le_bytes().as_ref(), staker.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, StakePosition>,
    #[account(seeds = [b"venue", venue_id.to_le_bytes().as_ref()], bump = venue.bump)]
    pub venue: Account<'info, VenueAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(venue_id: u32)]
pub struct Unstake<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,
    #[account(mut, seeds = [b"vault", venue_id.to_le_bytes().as_ref()], bump = vault.bump)]
    pub vault: Account<'info, VenueStakeVault>,
    #[account(mut, seeds = [b"stake", venue_id.to_le_bytes().as_ref(), staker.key().as_ref()], bump = position.bump)]
    pub position: Account<'info, StakePosition>,
    #[account(seeds = [b"venue", venue_id.to_le_bytes().as_ref()], bump = venue.bump)]
    pub venue: Account<'info, VenueAccount>,
    #[account(mut, seeds = [b"park_mint"], bump)]
    pub park_mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = staker,
        associated_token::mint = park_mint,
        associated_token::authority = staker,
    )]
    pub staker_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(venue_id: u32)]
pub struct ClaimStakeRewards<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,
    #[account(mut, seeds = [b"vault", venue_id.to_le_bytes().as_ref()], bump = vault.bump)]
    pub vault: Account<'info, VenueStakeVault>,
    #[account(mut, seeds = [b"stake", venue_id.to_le_bytes().as_ref(), staker.key().as_ref()], bump = position.bump)]
    pub position: Account<'info, StakePosition>,
    #[account(seeds = [b"venue", venue_id.to_le_bytes().as_ref()], bump = venue.bump)]
    pub venue: Account<'info, VenueAccount>,
    #[account(mut, seeds = [b"park_mint"], bump)]
    pub park_mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = staker,
        associated_token::mint = park_mint,
        associated_token::authority = staker,
    )]
    pub staker_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
