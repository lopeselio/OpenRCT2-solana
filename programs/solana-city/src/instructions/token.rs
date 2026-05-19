use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};
use crate::errors::CityError;
use crate::state::GuestAccount;

pub fn initialize_park_mint(_ctx: Context<InitializeParkMint>) -> Result<()> {
    msg!("$PARK mint initialized");
    Ok(())
}

// Converts a guest's internal PARK balance to real $PARK SPL tokens.
// Guest must be inactive (exited). Mints balance to the caller's ATA and zeroes the balance.
pub fn redeem_balance(ctx: Context<RedeemBalance>, _guest_id: u32) -> Result<()> {
    require!(!ctx.accounts.guest.is_active, CityError::GuestStillActive);

    let amount = ctx.accounts.guest.balance;
    if amount > 0 {
        let bump = ctx.bumps.park_mint;
        let signer_seeds: &[&[&[u8]]] = &[&[b"park_mint", &[bump]]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.park_mint.to_account_info(),
                    to: ctx.accounts.recipient_ata.to_account_info(),
                    authority: ctx.accounts.park_mint.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;
        ctx.accounts.guest.balance = 0;
        msg!("Redeemed {} $PARK for guest {}", amount, ctx.accounts.guest.guest_id);
    }
    Ok(())
}

// ─── Contexts ──────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeParkMint<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    // park_mint is its own mint authority — sign with PDA seeds when minting
    #[account(
        init,
        payer = payer,
        seeds = [b"park_mint"],
        bump,
        mint::decimals = 6,
        mint::authority = park_mint,
    )]
    pub park_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(guest_id: u32)]
pub struct RedeemBalance<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    // guest PDA — no seeds constraint; caller provides the correct park-scoped address.
    // Anchor validates discriminator (account type) only.
    #[account(mut)]
    pub guest: Account<'info, GuestAccount>,
    #[account(mut, seeds = [b"park_mint"], bump)]
    pub park_mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = park_mint,
        associated_token::authority = payer,
    )]
    pub recipient_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
