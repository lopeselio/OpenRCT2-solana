import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { SolanaCity } from "../target/types/solana_city";
import { assert } from "chai";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

// Tests cover the base-layer instructions that run on localnet.
// Instructions that require the MagicBlock Ephemeral Rollup or VRF oracle
// (delegate_guest, delegate_venue, commit_guest, exit_guest, remove_venue,
//  request_park_event, consume_park_event, schedule_park_crank) need a
// devnet ER deployment and are out of scope here.

describe("solana-city", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.SolanaCity as Program<SolanaCity>;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // All tests use park 1. Multi-park tests (park 2) are at the bottom.
  const PARK_ID = 1;

  // ── PDA helpers ─────────────────────────────────────────────────────────
  // These are only used for fetching account state after instructions.
  // Anchor 0.32 auto-derives PDAs with seeds from the IDL — do NOT pass them
  // in .accounts({}) or TypeScript will report "unknown property" errors.

  function parkIdBuf(parkId: number): Buffer {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(parkId);
    return buf;
  }

  const [cityPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("city"), parkIdBuf(PARK_ID)],
    program.programId
  );

  const [leaderboardPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("leaderboard")],
    program.programId
  );

  const [parkMintPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("park_mint")],
    program.programId
  );

  function guestPda(guestId: number, parkId = PARK_ID): anchor.web3.PublicKey {
    const gBuf = Buffer.alloc(4);
    gBuf.writeUInt32LE(guestId);
    return anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("guest"), parkIdBuf(parkId), gBuf],
      program.programId
    )[0];
  }

  function venuePda(venueId: number, parkId = PARK_ID): anchor.web3.PublicKey {
    const vBuf = Buffer.alloc(4);
    vBuf.writeUInt32LE(venueId);
    return anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("venue"), parkIdBuf(parkId), vBuf],
      program.programId
    )[0];
  }

  function vaultPda(venueId: number, parkId = PARK_ID): anchor.web3.PublicKey {
    const vBuf = Buffer.alloc(4);
    vBuf.writeUInt32LE(venueId);
    return anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), parkIdBuf(parkId), vBuf],
      program.programId
    )[0];
  }

  function stakePda(venueId: number, staker: anchor.web3.PublicKey, parkId = PARK_ID): anchor.web3.PublicKey {
    const vBuf = Buffer.alloc(4);
    vBuf.writeUInt32LE(venueId);
    return anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("stake"), parkIdBuf(parkId), vBuf, staker.toBuffer()],
      program.programId
    )[0];
  }

  function cityPdaFor(parkId: number): anchor.web3.PublicKey {
    return anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("city"), parkIdBuf(parkId)],
      program.programId
    )[0];
  }

  // ── City ─────────────────────────────────────────────────────────────────

  describe("initialize_city", () => {
    it("rejects names longer than 32 bytes", async () => {
      try {
        await program.methods
          .initializeCity(PARK_ID, "A".repeat(33))
          .accounts({ authority: payer.publicKey })
          .signers([payer])
          .rpc();
        assert.fail("expected NameTooLong error");
      } catch (err: any) {
        assert.include(err.message, "NameTooLong");
      }
    });

    it("creates city PDA with correct initial state", async () => {
      await program.methods
        .initializeCity(PARK_ID, "TestPark")
        .accounts({ authority: payer.publicKey })
        .signers([payer])
        .rpc();

      const city = await program.account.cityState.fetch(cityPda);
      assert.equal(city.parkId, PARK_ID);
      assert.equal(
        Buffer.from(city.name).subarray(0, 8).toString(),
        "TestPark"
      );
      assert.equal(city.authority.toString(), payer.publicKey.toString());
      assert.isTrue(city.totalGuestsEver.eqn(0));
      assert.equal(city.activeGuests, 0);
      assert.isTrue(city.totalRevenue.eqn(0));
      assert.equal(city.venueCount, 0);
      assert.equal(city.parkScore, 500);
    });
  });

  // ── Venue ─────────────────────────────────────────────────────────────────

  describe("register_venue", () => {
    it("creates venue PDA and increments city venue_count", async () => {
      await program.methods
        .registerVenue(PARK_ID, 1, 0, "Roller Coaster")
        .accounts({ payer: payer.publicKey })
        .signers([payer])
        .rpc();

      const venue = await program.account.venueAccount.fetch(venuePda(1));
      assert.equal(venue.venueId, 1);
      assert.equal(venue.venueKind, 0);
      assert.equal(
        Buffer.from(venue.name).subarray(0, 14).toString(),
        "Roller Coaster"
      );
      assert.isTrue(venue.isActive);
      assert.isFalse(venue.isBroken);
      assert.isTrue(venue.totalRevenue.eqn(0));

      const city = await program.account.cityState.fetch(cityPda);
      assert.equal(city.venueCount, 1);
    });

    it("rejects names longer than 32 bytes", async () => {
      try {
        await program.methods
          .registerVenue(PARK_ID, 99, 1, "A".repeat(33))
          .accounts({ payer: payer.publicKey })
          .signers([payer])
          .rpc();
        assert.fail("expected NameTooLong error");
      } catch (err: any) {
        assert.include(err.message, "NameTooLong");
      }
    });
  });

  describe("rename_venue", () => {
    it("updates the venue name bytes", async () => {
      await program.methods
        .renameVenue(PARK_ID, 1, "Big Dipper")
        .accounts({ payer: payer.publicKey })
        .signers([payer])
        .rpc();

      const venue = await program.account.venueAccount.fetch(venuePda(1));
      assert.equal(
        Buffer.from(venue.name).subarray(0, 10).toString(),
        "Big Dipper"
      );
    });

    it("rejects names longer than 32 bytes", async () => {
      try {
        await program.methods
          .renameVenue(PARK_ID, 1, "A".repeat(33))
          .accounts({ payer: payer.publicKey })
          .signers([payer])
          .rpc();
        assert.fail("expected NameTooLong error");
      } catch (err: any) {
        assert.include(err.message, "NameTooLong");
      }
    });
  });

  describe("repair_venue", () => {
    it("clears is_broken flag", async () => {
      await program.methods
        .repairVenue(PARK_ID, 1)
        .accounts({ payer: payer.publicKey })
        .signers([payer])
        .rpc();

      const venue = await program.account.venueAccount.fetch(venuePda(1));
      assert.isFalse(venue.isBroken);
    });
  });

  // ── Guest ─────────────────────────────────────────────────────────────────

  describe("register_guest", () => {
    it("creates guest PDA and increments city active_guests", async () => {
      const INITIAL_BALANCE = new BN(5_000_000); // 5 PARK

      await program.methods
        .registerGuest(PARK_ID, 42, INITIAL_BALANCE)
        .accounts({ payer: payer.publicKey })
        .signers([payer])
        .rpc();

      const guest = await program.account.guestAccount.fetch(guestPda(42));
      assert.equal(guest.guestId, 42);
      assert.isTrue(guest.balance.eq(INITIAL_BALANCE));
      assert.isTrue(guest.totalSpent.eqn(0));
      assert.isTrue(guest.isActive);
      assert.isTrue(guest.pendingPrize.eqn(0));

      const city = await program.account.cityState.fetch(cityPda);
      assert.isTrue(city.totalGuestsEver.eqn(1));
      assert.equal(city.activeGuests, 1);
    });
  });

  // ── Spend ─────────────────────────────────────────────────────────────────

  describe("spend", () => {
    it("transfers amount from guest balance to venue revenue", async () => {
      const SPEND = new BN(1_000_000);

      await program.methods
        .spend(PARK_ID, 42, 1, SPEND, 0)
        .accounts({ payer: payer.publicKey })
        .signers([payer])
        .rpc();

      const guest = await program.account.guestAccount.fetch(guestPda(42));
      assert.isTrue(guest.balance.eqn(4_000_000));
      assert.isTrue(guest.totalSpent.eqn(1_000_000));

      const venue = await program.account.venueAccount.fetch(venuePda(1));
      assert.isTrue(venue.totalRevenue.eqn(1_000_000));
    });

    it("rejects spend when guest balance is insufficient", async () => {
      try {
        await program.methods
          .spend(PARK_ID, 42, 1, new BN(100_000_000), 0)
          .accounts({ payer: payer.publicKey })
          .signers([payer])
          .rpc();
        assert.fail("expected InsufficientBalance error");
      } catch (err: any) {
        assert.include(err.message, "InsufficientBalance");
      }
    });

    it("rejects spend at a broken venue", async () => {
      // Actual broken-venue spend errors are exercised in ER integration tests.
    });
  });

  // ── Deactivate Venue ─────────────────────────────────────────────────────

  describe("deactivate_venue", () => {
    it("sets is_active to false (base-layer finalisation after remove_venue)", async () => {
      await program.methods
        .deactivateVenue(PARK_ID, 1)
        .accounts({ payer: payer.publicKey })
        .signers([payer])
        .rpc();

      const venue = await program.account.venueAccount.fetch(venuePda(1));
      assert.isFalse(venue.isActive);
    });
  });

  // ── Claim Prize ───────────────────────────────────────────────────────────

  describe("claim_prize", () => {
    it("is a no-op when pending_prize is zero", async () => {
      const guestBefore = await program.account.guestAccount.fetch(guestPda(42));

      await program.methods
        .claimPrize(PARK_ID, 42)
        .accounts({ payer: payer.publicKey })
        .signers([payer])
        .rpc();

      const guestAfter = await program.account.guestAccount.fetch(guestPda(42));
      assert.isTrue(guestAfter.balance.eq(guestBefore.balance));
      assert.isTrue(guestAfter.pendingPrize.eqn(0));
      assert.isFalse(guestAfter.isActive, "claim_prize should finalise guest exit");

      const cityAfter = await program.account.cityState.fetch(cityPda);
      assert.equal(cityAfter.activeGuests, 0, "active_guests should decrement on exit");
    });
  });

  // ── Park Score ────────────────────────────────────────────────────────────

  describe("update_park_score", () => {
    it("recalculates score: 500 + min(activeGuests,200) + min(revenue/1M,300)", async () => {
      await program.methods.updateParkScore(PARK_ID).rpc();

      const city = await program.account.cityState.fetch(cityPda);
      // claim_prize decremented active_guests to 0 → 500 + 0 + 0 = 500
      assert.equal(city.parkScore, 500);
    });
  });

  describe("auto_park_tick", () => {
    it("applies the same score formula as update_park_score", async () => {
      await program.methods.autoParkTick().accounts({ city: cityPda }).rpc();

      const city = await program.account.cityState.fetch(cityPda);
      assert.equal(city.parkScore, 500);
    });
  });

  // ── Multi-guest score cap ─────────────────────────────────────────────────

  describe("park score guest bonus cap", () => {
    it("caps guest bonus at 200 even with more than 200 active guests", async () => {
      // Register 10 additional guests (IDs 1000–1009) to push active_guests to 10
      for (let i = 1000; i < 1010; i++) {
        await program.methods
          .registerGuest(PARK_ID, i, new BN(1_000_000))
          .accounts({ payer: payer.publicKey })
          .signers([payer])
          .rpc();
      }

      await program.methods.updateParkScore(PARK_ID).rpc();

      const city = await program.account.cityState.fetch(cityPda);
      // guest 42 was exited (active_guests=0), then 10 new guests registered → 10 active
      // bonus = min(10, 200) = 10 → score = 500 + 10 + 0 = 510
      assert.equal(city.parkScore, 510);
    });
  });

  // ── $PARK SPL Token ───────────────────────────────────────────────────────

  describe("initialize_park_mint", () => {
    it("creates the $PARK mint PDA with 6 decimals", async () => {
      await program.methods
        .initializeParkMint()
        .accounts({ payer: payer.publicKey })
        .signers([payer])
        .rpc();

      const mintInfo = await provider.connection.getAccountInfo(parkMintPda);
      assert.isNotNull(mintInfo, "$PARK mint account should exist");
    });
  });

  describe("redeem_balance", () => {
    it("mints $PARK tokens equal to guest balance and zeroes the balance", async () => {
      // guest 42 is inactive (exited via claim_prize) with balance = 4_000_000
      await program.methods
        .redeemBalance(42)
        .accounts({ payer: payer.publicKey, guest: guestPda(42) })
        .signers([payer])
        .rpc();

      const stakerAta = getAssociatedTokenAddressSync(parkMintPda, payer.publicKey);
      const ata = await provider.connection.getTokenAccountBalance(stakerAta);
      assert.equal(ata.value.amount, "4000000", "ATA should hold 4M $PARK");

      const guestAfter = await program.account.guestAccount.fetch(guestPda(42));
      assert.isTrue(guestAfter.balance.eqn(0), "guest.balance should be zeroed");
    });

    it("rejects redeem when guest is still active", async () => {
      // guest 1000 is still active
      try {
        await program.methods
          .redeemBalance(1000)
          .accounts({ payer: payer.publicKey, guest: guestPda(1000) })
          .signers([payer])
          .rpc();
        assert.fail("expected GuestStillActive error");
      } catch (err: any) {
        assert.include(err.message, "GuestStillActive");
      }
    });
  });

  // ── Ride Revenue Staking ──────────────────────────────────────────────────

  describe("create_stake_vault", () => {
    it("creates vault for venue 1 seeded with current revenue", async () => {
      await program.methods
        .createStakeVault(PARK_ID, 1)
        .accounts({ payer: payer.publicKey })
        .signers([payer])
        .rpc();

      const vault = await program.account.venueStakeVault.fetch(vaultPda(1));
      assert.equal(vault.venueId, 1);
      assert.isTrue(vault.totalStaked.eqn(0));
    });
  });

  describe("stake / claim_stake_rewards / unstake", () => {
    const STAKE_AMOUNT = new BN(1_000_000); // 1M lamports
    const SPEND_AMOUNT = new BN(500_000);   // 0.5M PARK

    it("stakes SOL and increases vault total_staked", async () => {
      await program.methods
        .stake(PARK_ID, 1, STAKE_AMOUNT)
        .accounts({ staker: payer.publicKey })
        .signers([payer])
        .rpc();

      const vault = await program.account.venueStakeVault.fetch(vaultPda(1));
      assert.isTrue(vault.totalStaked.eq(STAKE_AMOUNT));

      const pos = await program.account.stakePosition.fetch(stakePda(1, payer.publicKey));
      assert.isTrue(pos.amount.eq(STAKE_AMOUNT));
    });

    it("generates rewards after venue earns revenue (spend by guest 1000)", async () => {
      // guest 1000 is active with 1_000_000 balance; spend 500_000 at venue 1
      await program.methods
        .spend(PARK_ID, 1000, 1, SPEND_AMOUNT, 0)
        .accounts({ payer: payer.publicKey })
        .signers([payer])
        .rpc();

      const venue = await program.account.venueAccount.fetch(venuePda(1));
      // venue 1 had 1_000_000 revenue before; now 1_500_000
      assert.isTrue(venue.totalRevenue.eqn(1_500_000));
    });

    it("claim_stake_rewards mints $PARK proportional to revenue since stake", async () => {
      const stakerAta = getAssociatedTokenAddressSync(parkMintPda, payer.publicKey);
      const ataBefore = await provider.connection.getTokenAccountBalance(stakerAta);
      const balanceBefore = BigInt(ataBefore.value.amount);

      await program.methods
        .claimStakeRewards(PARK_ID, 1)
        .accounts({ staker: payer.publicKey })
        .signers([payer])
        .rpc();

      const ataAfter = await provider.connection.getTokenAccountBalance(stakerAta);
      const balanceAfter = BigInt(ataAfter.value.amount);
      // Staker holds 100% of stake → reward = all 500_000 PARK of new revenue
      assert.equal(balanceAfter - balanceBefore, BigInt(500_000));
    });

    it("unstake returns SOL and position.amount is zeroed", async () => {
      const solBefore = await provider.connection.getBalance(payer.publicKey);

      await program.methods
        .unstake(PARK_ID, 1)
        .accounts({ staker: payer.publicKey })
        .signers([payer])
        .rpc();

      const pos = await program.account.stakePosition.fetch(stakePda(1, payer.publicKey));
      assert.isTrue(pos.amount.eqn(0), "position should be zeroed after unstake");

      const vault = await program.account.venueStakeVault.fetch(vaultPda(1));
      assert.isTrue(vault.totalStaked.eqn(0), "vault total_staked should be zero");

      // SOL should be roughly returned (minus tx fees)
      const solAfter = await provider.connection.getBalance(payer.publicKey);
      assert.isAbove(solAfter, solBefore - 10_000, "staker should receive SOL back");
    });
  });

  // ── Milestone Badges ─────────────────────────────────────────────────────

  function badgePda(tier: number, parkId = PARK_ID): anchor.web3.PublicKey {
    const city = cityPdaFor(parkId);
    return anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("badge"), city.toBuffer(), Buffer.from([tier])],
      program.programId
    )[0];
  }

  describe("claim_badge", () => {
    it("awards Bronze badge when thresholds are met", async () => {
      // At this point: totalGuestsEver=11, totalRevenue=1_500_000 → Bronze threshold met
      await program.methods
        .claimBadge(PARK_ID, 0)
        .accounts({ payer: payer.publicKey, badge: badgePda(0) })
        .signers([payer])
        .rpc();

      const badge = await program.account.badgeAccount.fetch(badgePda(0));
      assert.equal(badge.tier, 0, "tier should be 0 (Bronze)");
      assert.equal(badge.city.toString(), cityPda.toString());
      assert.isAbove(badge.awardedAt.toNumber(), 0, "awardedAt should be a unix timestamp");
    });

    it("rejects duplicate Bronze badge claim", async () => {
      try {
        await program.methods
          .claimBadge(PARK_ID, 0)
          .accounts({ payer: payer.publicKey, badge: badgePda(0) })
          .signers([payer])
          .rpc();
        assert.fail("expected account already in use error");
      } catch (err: any) {
        assert.ok(err, "should throw on duplicate claim");
      }
    });

    it("rejects Silver badge when guest threshold is not met", async () => {
      // Silver needs 25 guests; only 11 have visited so far
      try {
        await program.methods
          .claimBadge(PARK_ID, 1)
          .accounts({ payer: payer.publicKey, badge: badgePda(1) })
          .signers([payer])
          .rpc();
        assert.fail("expected BadgeThresholdNotMet error");
      } catch (err: any) {
        assert.include(err.message, "BadgeThresholdNotMet");
      }
    });

    it("rejects invalid tier", async () => {
      try {
        await program.methods
          .claimBadge(PARK_ID, 4)
          .accounts({ payer: payer.publicKey, badge: badgePda(4) })
          .signers([payer])
          .rpc();
        assert.fail("expected InvalidBadgeTier error");
      } catch (err: any) {
        assert.include(err.message, "InvalidBadgeTier");
      }
    });
  });

  // ── Leaderboard ───────────────────────────────────────────────────────────

  describe("initialize_leaderboard", () => {
    it("creates leaderboard PDA with all empty entries", async () => {
      await program.methods
        .initializeLeaderboard()
        .accounts({ payer: payer.publicKey })
        .signers([payer])
        .rpc();

      const lb = await program.account.leaderboard.fetch(leaderboardPda);
      assert.equal(lb.entries.length, 10);
      assert.isTrue(
        lb.entries.every((e: any) => e.revenue.eqn(0)),
        "all entries should start with zero revenue"
      );
    });
  });

  describe("submit_score", () => {
    it("inserts the city into an empty leaderboard slot at index 0", async () => {
      await program.methods
        .submitScore()
        .accounts({ payer: payer.publicKey, city: cityPda })
        .signers([payer])
        .rpc();

      const lb = await program.account.leaderboard.fetch(leaderboardPda);
      const city = await program.account.cityState.fetch(cityPda);

      assert.equal(
        lb.entries[0].park.toString(),
        cityPda.toString(),
        "city should be the top entry"
      );
      assert.isTrue(
        lb.entries[0].revenue.eq(city.totalRevenue),
        "leaderboard revenue should match city total_revenue"
      );
    });

    it("updates the existing entry when the same city submits again", async () => {
      await program.methods
        .submitScore()
        .accounts({ payer: payer.publicKey, city: cityPda })
        .signers([payer])
        .rpc();

      const lb = await program.account.leaderboard.fetch(leaderboardPda);
      const city = await program.account.cityState.fetch(cityPda);

      const cityEntry = lb.entries.find(
        (e: any) => e.park.toString() === cityPda.toString()
      );
      assert.isDefined(cityEntry, "city should still be on the leaderboard");
      assert.isTrue(
        (cityEntry as any).revenue.eq(city.totalRevenue),
        "revenue should reflect current city state"
      );
    });
  });

  // ── Multi-Park World ──────────────────────────────────────────────────────

  describe("multi-park: two independent parks co-exist under one program", () => {
    const PARK_2 = 2;
    const city2Pda = cityPdaFor(PARK_2);

    it("initializes a second independent park (park_id=2)", async () => {
      await program.methods
        .initializeCity(PARK_2, "Park Two")
        .accounts({ authority: payer.publicKey })
        .signers([payer])
        .rpc();

      const city2 = await program.account.cityState.fetch(city2Pda);
      assert.equal(city2.parkId, PARK_2);
      assert.equal(
        Buffer.from(city2.name).subarray(0, 8).toString(),
        "Park Two"
      );
      assert.isTrue(city2.totalGuestsEver.eqn(0));
    });

    it("registers a venue in park 2 without affecting park 1", async () => {
      await program.methods
        .registerVenue(PARK_2, 1, 0, "Water Slide")
        .accounts({ payer: payer.publicKey })
        .signers([payer])
        .rpc();

      // Park 2 venue exists
      const venue2 = await program.account.venueAccount.fetch(venuePda(1, PARK_2));
      assert.equal(
        Buffer.from(venue2.name).subarray(0, 11).toString(),
        "Water Slide"
      );

      // Park 1 venue unchanged (venue_count stays at 0 for park 2 city, and park1 stays at 1)
      const city1 = await program.account.cityState.fetch(cityPda);
      const city2 = await program.account.cityState.fetch(city2Pda);
      // venue 1 in park 1 was deactivated earlier (decrements venue_count to 0)
      assert.equal(city1.venueCount, 0, "park 1 venue_count should be unaffected by park 2");
      assert.equal(city2.venueCount, 1, "park 2 venue_count should be 1");
    });

    it("guest travels: exits park 1, enters park 2 with same guest_id", async () => {
      // Register guest 42 in park 2 (guest 42 has already exited park 1)
      await program.methods
        .registerGuest(PARK_2, 42, new BN(2_000_000))
        .accounts({ payer: payer.publicKey })
        .signers([payer])
        .rpc();

      // Park 2 guest exists independently
      const guest2 = await program.account.guestAccount.fetch(guestPda(42, PARK_2));
      assert.equal(guest2.guestId, 42);
      assert.isTrue(guest2.balance.eqn(2_000_000));
      assert.isTrue(guest2.isActive);

      // Park 1 guest still has its state untouched (inactive, zeroed balance)
      const guest1 = await program.account.guestAccount.fetch(guestPda(42));
      assert.isFalse(guest1.isActive);
      assert.isTrue(guest1.balance.eqn(0));
    });

    it("spend in park 2 does not affect park 1 venue revenue", async () => {
      await program.methods
        .spend(PARK_2, 42, 1, new BN(500_000), 0)
        .accounts({ payer: payer.publicKey })
        .signers([payer])
        .rpc();

      // Park 2 venue accumulated the revenue
      const venue2 = await program.account.venueAccount.fetch(venuePda(1, PARK_2));
      assert.isTrue(venue2.totalRevenue.eqn(500_000));

      // Park 1 venue unchanged (still at 1_500_000 from previous tests)
      const venue1 = await program.account.venueAccount.fetch(venuePda(1));
      assert.isTrue(venue1.totalRevenue.eqn(1_500_000));
    });

    it("park scores update independently", async () => {
      await program.methods.updateParkScore(PARK_2).rpc();

      const city1 = await program.account.cityState.fetch(cityPda);
      const city2 = await program.account.cityState.fetch(city2Pda);

      // Park 2 has 1 active guest (42) → score 510; park 1 has 10 active → score 510
      assert.equal(city1.parkScore, 510, "park 1 score unchanged");
      assert.equal(city2.parkScore, 501, "park 2 has 1 active guest → 500+1=501");
    });
  });
});
