use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};
use crate::errors::CityError;
use crate::state::GuestAccount;

pub const METAPLEX_TOKEN_METADATA_PROGRAM_ID: Pubkey =
    anchor_lang::pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

pub fn initialize_park_mint(_ctx: Context<InitializeParkMint>) -> Result<()> {
    msg!("$PARK mint initialized");
    Ok(())
}

// Attaches Metaplex Token Metadata (CreateMetadataAccountV3) to the park mint.
// The mint PDA signs as mint authority via invoke_signed. Idempotent at the
// instruction layer in the sense that the Metaplex program will reject a
// double-create.
pub fn create_park_metadata(
    ctx: Context<CreateParkMetadata>,
    name: String,
    symbol: String,
    uri: String,
) -> Result<()> {
    // Hand-rolled Borsh for CreateMetadataAccountArgsV3 to avoid pulling
    // the full mpl-token-metadata crate as a dependency.
    //
    // Layout:
    //   u8  discriminator (33 = CreateMetadataAccountV3)
    //   String name, String symbol, String uri  (each: u32 len + bytes)
    //   u16 seller_fee_basis_points
    //   Option<Vec<Creator>>    -> 0 (None)
    //   Option<Collection>      -> 0 (None)
    //   Option<Uses>            -> 0 (None)
    //   bool is_mutable
    //   Option<CollectionDetails> -> 0 (None)
    let mut data: Vec<u8> = Vec::with_capacity(64 + name.len() + symbol.len() + uri.len());
    data.push(33);
    for s in [&name, &symbol, &uri] {
        data.extend_from_slice(&(s.len() as u32).to_le_bytes());
        data.extend_from_slice(s.as_bytes());
    }
    data.extend_from_slice(&0u16.to_le_bytes()); // seller_fee_basis_points
    data.push(0); // creators = None
    data.push(0); // collection = None
    data.push(0); // uses = None
    data.push(1); // is_mutable = true
    data.push(0); // collection_details = None

    let mint_key = ctx.accounts.park_mint.key();
    let accounts = vec![
        AccountMeta::new(ctx.accounts.metadata.key(), false),
        AccountMeta::new_readonly(mint_key, false),
        AccountMeta::new_readonly(mint_key, true),                  // mint_authority (PDA signs)
        AccountMeta::new(ctx.accounts.payer.key(), true),           // payer
        AccountMeta::new_readonly(mint_key, false),                 // update_authority (not signer in V3)
        AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
    ];

    let ix = Instruction {
        program_id: METAPLEX_TOKEN_METADATA_PROGRAM_ID,
        accounts,
        data,
    };

    let bump = ctx.bumps.park_mint;
    let signer_seeds: &[&[&[u8]]] = &[&[b"park_mint", &[bump]]];

    invoke_signed(
        &ix,
        &[
            ctx.accounts.metadata.to_account_info(),
            ctx.accounts.park_mint.to_account_info(),
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.metaplex_program.to_account_info(),
        ],
        signer_seeds,
    )?;

    msg!("Token metadata created: {} ({})", name, symbol);
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
pub struct CreateParkMetadata<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Metaplex metadata PDA — validated by the Token Metadata program via PDA derivation
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"park_mint"], bump)]
    pub park_mint: Account<'info, Mint>,
    /// CHECK: pinned to the Metaplex Token Metadata program by address
    #[account(address = METAPLEX_TOKEN_METADATA_PROGRAM_ID)]
    pub metaplex_program: UncheckedAccount<'info>,
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
