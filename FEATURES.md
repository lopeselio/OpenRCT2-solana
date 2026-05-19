# Solana City — Feature List

A plain-English breakdown of everything built and planned. Items marked ✅ are
scaffolded in this repo. Items marked 🔜 are designed but not yet implemented.
Items marked 💡 are ideas for future expansion.

---

## ✅ Built: Core Chain Layer

### 1. Guest Accounts on Solana
**What it does:** Every park guest becomes a real Solana account (a PDA).
When they buy a ticket, their balance is stored on-chain. When they leave,
their final balance and total spend are committed back to the base layer.

**Why it matters:** Guest spending is real — you can look up any guest's
on-chain history. No EVM or backend database needed.

**How it works:**
- Guest enters → `register_guest` creates PDA on base layer
- `delegate_guest` hands PDA to the Ephemeral Rollup for fast gameplay
- Guest exits → `exit_guest` commits state + returns PDA to base layer

---

### 2. Venue Accounts on Solana
**What it does:** Every ride, shop, food stall, and ATM is also a Solana
account. All revenue they collect is tracked on-chain.

**Why it matters:** You can audit any ride's lifetime revenue. Revenue is
real, not just a number in a database.

**How it works:**
- Venue is placed in-game → `register_venue` + `delegate_venue`
- Guest spends → venue's `total_revenue` grows on the Ephemeral Rollup
- Venue removed → `remove_venue` commits revenue + closes account

---

### 3. MagicBlock Ephemeral Rollup (Ultra-Fast Transactions)
**What it does:** Guest spend transactions happen at **~10-50ms latency**
instead of the ~400ms Solana base layer confirmations.

**Why it matters:** The game runs at real-time speed. Without the ER, every
guest buying a hot dog would stall the game for 400ms. With the ER, it's
faster than the human eye can notice.

**How it works:**
- Guest and venue PDAs are "delegated" to the Ephemeral Rollup on entry
- All spend transactions go to the ER endpoint
- State is periodically committed back ("synced") to the base Solana chain

---

### 4. City State PDA
**What it does:** A single on-chain account tracks park-wide stats: total
guests ever, currently active guests, total revenue, number of venues,
and the park score.

**Why it matters:** Anyone can query the park's health from a block explorer.
The park score (0-1000) updates automatically every 30 seconds.

---

### 5. NDJSON Outbox + Chain Sidecar
**What it does:** The game writes economic events to a local file
(`chain-outbox.ndjson`). A TypeScript sidecar watches this file and sends
the right transactions to Solana.

**Why it matters:** The game never waits for blockchain confirmation.
Events queue up; the sidecar works through them at its own pace.

**Files:**
- `ChainOutbox.h / .cpp` — C++ file writer
- `chain-sidecar/src/outbox/reader.ts` — TypeScript file watcher
- `chain-sidecar/src/main.ts` — event dispatcher

---

## ✅ Built: Solana-Exclusive Features

### 6. VRF Random Park Events
**What it does:** Verifiable random events happen during gameplay:
- **Ride breakdown** (20% chance): A ride breaks and earns no revenue until repaired
- **Lucky guest prize** (30% chance): Guest wins 50–500 $PARK tokens  
- **Park bonus** (20% chance): Guest gets +10 $PARK

**Why it matters:** This is cryptographically provable randomness — neither the
park owner nor the player can predict or manipulate the outcome. The randomness
proof lives on-chain. Nothing like this exists on EVM without an oracle.

**How it works:**
- Sidecar calls `request_park_event` on the Ephemeral Rollup
- MagicBlock's VRF oracle generates a random number and calls back
- `consume_park_event` applies the result to guest and venue accounts

---

### 7. On-Chain Ride Repair System
**What it does:** When VRF marks a ride as broken (`is_broken = true`), guests
can no longer spend at that venue. The park must explicitly call `repair_venue`
to bring it back.

**Why it matters:** Creates a real management decision:
- Broken ride = zero revenue
- Repair costs a transaction fee (SOL)
- Do you repair immediately, or let it sit while you handle other tasks?

This is emergent on-chain game mechanics — not scripted, not faked.

---

### 8. Park Crank (Self-Scheduling Automated Task)
**What it does:** A recurring task runs automatically every **30 seconds** on the
Ephemeral Rollup. It recalculates the park score from current guest count and
revenue. No external server, no cron job — the ER schedules it internally.

**Why it matters:** On EVM chains, you need a "keeper bot" (external server)
to run recurring on-chain logic. MagicBlock cranks are built into the ER.
The park tick keeps running even if you close your laptop.

**Score formula:**
```
park_score = 500 + min(active_guests, 200) + min(total_revenue / 1M, 300)
```
Maximum score is 1000.

---

## ✅ Built: DeFi & Social Layer

### 9. $PARK SPL Token Integration
**What it does:** Guests accumulate an internal `balance: u64` (in PARK units)
during gameplay on the Ephemeral Rollup. On exit, `redeem_balance` converts
that balance into real **$PARK SPL tokens** in the caller's ATA.

**Why it matters:** The token is a real SPL asset — it appears in wallets and
on chain explorers. The ER keeps speed high (no SPL CPI in the hot path),
while the base layer handles final minting.

**How it works:**
- `initialize_park_mint` creates a self-authority PDA mint (`[b"park_mint"]`)
- `redeem_balance(guest_id)` requires guest to be inactive; mints `balance` tokens
- Sidecar calls `redeemBalance` automatically on every `GUEST_EXIT` event
- Staking rewards also mint $PARK via `unstake` and `claim_stake_rewards`

---

### 10. On-Chain Leaderboard
**What it does:** A `Leaderboard` PDA tracks the top 10 parks by total revenue.
Any park can call `submit_score` to upsert their entry — the leaderboard
stays sorted descending.

**Why it matters:** Multiple Solana City parks can compete for the top spot.
Fully on-chain, no server.

**How it works:**
- `initialize_leaderboard` creates the singleton PDA `[b"leaderboard"]`
- `submit_score` upserts the city entry, evicts the lowest if full, sorts descending
- Sidecar can call this on a timer or after significant revenue milestones

---

### 11. Ride Revenue Staking
**What it does:** Any wallet can stake SOL on a specific venue. When the venue
earns revenue (via guest spending), stakers earn $PARK proportional to their
share of the stake.

**Why it matters:** Turns the game into a DeFi primitive — become an investor
in someone's virtual roller coaster. Revenue auto-distributes on-chain.

**How it works:**
- `create_stake_vault(venueId)` — one vault PDA per venue
- `stake(venueId, amount)` — deposits SOL, inits position if new
- Accumulator pattern: `acc_reward_per_token` grows with each revenue delta
- `claim_stake_rewards(venueId)` — harvests $PARK without unstaking
- `unstake(venueId)` — returns SOL + mints any remaining $PARK rewards

---

### 12. Park Milestone Badges
**What it does:** When a park hits a guest-count milestone, an on-chain
`BadgeAccount` PDA is created — a permanent proof of achievement.

**Why it matters:** Badges are composable on-chain records. Any wallet or
dApp can query whether a park has earned a specific tier.

**Tiers (by `total_guests_ever`):**
- Bronze (tier 0): 5 guests
- Silver (tier 1): 25 guests
- Gold (tier 2): 100 guests
- Diamond (tier 3): 500 guests

**How it works:**
- `claim_badge(tier)` — creates PDA `[b"badge", city_key, tier_byte]`
- Attempting to re-claim the same tier fails (PDA already initialized)
- No Metaplex dependency — simple on-chain record, easy to extend

---

## ✅ Built: Multi-Park World

### 13. Multi-Park World
Multiple independent parks run under one deployed program, each identified
by a `park_id: u32`. Every city, guest, venue, vault, and stake PDA is
namespaced by `park_id` in its seeds.

**Guest travel:** a guest that exits park 1 can be registered in park 2 with
the same `guest_id`. Their $PARK SPL tokens (in their wallet ATA) carry over
automatically — the token mint is global, not park-scoped.

**Sidecar:** reads `PARK_ID` from the environment (default 1). To run a second
park, launch a second sidecar with `PARK_ID=2 npm start`.

**Implementation:**
- All seeds updated: `[b"city", park_id_le]`, `[b"guest", park_id_le, guest_id_le]`, etc.
- `CityState` stores `park_id` for easy querying
- Every instruction takes `park_id: u32` as first arg (ER instructions that rely on
  external account passing use unconstrained `AccountInfo` and don't need seeds)
- `AutoParkTick` uses no seeds — the specific city key is baked in at crank schedule time

## 💡 Future Ideas

### 14. Weather Oracle (Pyth/Switchboard)
Pull real-world weather data on-chain. Rainy day in the player's city → 
fewer guests appear in-game, park score drops. Uses Pyth price feeds or
Switchboard oracles.

### 15. Park Bonds
The park can issue bonds: pay SOL now, receive $PARK revenue over 30 days.
Fully automated via on-chain time-lock accounts.

### 16. Claude Code Park Manager
The existing Claude Code AI agent (via `rctctl`) can read chain state and
make management decisions: "ride is broken, repair it", "revenue below
target, hire more staff". Claude becomes an on-chain-aware park manager.

---

## Implementation Status Summary

| # | Feature | Status | Where |
|---|---------|--------|-------|
| 1 | Guest PDAs | ✅ Built | `instructions/guest.rs` |
| 2 | Venue PDAs | ✅ Built | `instructions/venue.rs` |
| 3 | Ephemeral Rollup routing | ✅ Built | `chain-sidecar/src/solana/` |
| 4 | City state PDA | ✅ Built | `instructions/city.rs` |
| 5 | NDJSON outbox + sidecar | ✅ Built | `ChainOutbox.cpp`, `chain-sidecar/` |
| 6 | VRF random events | ✅ Built | `instructions/vrf.rs` |
| 7 | Ride repair mechanic | ✅ Built | `instructions/venue.rs` |
| 8 | Park crank (auto-tick) | ✅ Built | `instructions/crank.rs` |
| 9 | $PARK SPL token | ✅ Built | `instructions/token.rs` |
| 10 | Leaderboard | ✅ Built | `instructions/leaderboard.rs` |
| 11 | Ride revenue staking | ✅ Built | `instructions/staking.rs` |
| 12 | Milestone badges | ✅ Built | `instructions/badges.rs` |
| 13 | Multi-park world | ✅ Built | park_id seeds across all instructions |
| 14 | Weather oracle | 💡 Idea | |
| 15 | Park bonds | 💡 Idea | |
| 16 | Claude Code park manager | 💡 Idea | |
