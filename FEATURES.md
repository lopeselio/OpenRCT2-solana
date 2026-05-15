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

## 🔜 Designed: Next Priorities

### 9. $PARK SPL Token Integration
**What it does:** Replace the internal `balance: u64` with a real SPL token
mint. Guests would hold actual $PARK token accounts that show up in wallets.

**Why it matters:** The token becomes tradable. You could buy park tickets from
a DEX. Revenue goes to a real token treasury visible on chain explorers.

**What's needed:**
- Add `anchor-spl` dependency
- Create a `ParkMint` PDA at city initialization
- Change `register_guest` to mint $PARK to a guest-owned ATA
- Change `spend` to move real SPL tokens between ATAs

---

### 10. On-Chain Leaderboard
**What it does:** A `Leaderboard` PDA tracks the top 10 parks by total revenue.
Parks can "register" themselves to appear on a global on-chain ranking.

**Why it matters:** Multiple people running their own Solana City parks could
compete for the top spot. Fully on-chain, no server.

**Status:** `Leaderboard` struct is defined in `state.rs`, instruction not yet written.

---

### 11. Ride Revenue Staking
**What it does:** Any wallet can stake SOL on a specific ride. When the ride
earns revenue, stakers get a percentage share.

**Why it matters:** Turns the game into a DeFi primitive. You could become
an investor in someone's virtual roller coaster. Revenue auto-distributes
on-chain.

**What's needed:**
- `StakePosition` PDA per (staker, venue)
- `stake_on_venue(venueId, amount)` instruction
- Modify `spend` to split revenue between venue and stakers
- `claim_stake_rewards(venueId)` instruction

---

### 12. Park Milestone Badges
**What it does:** When a park hits a milestone (1,000 guests, 1,000,000 $PARK
revenue, etc.), an on-chain badge is minted using Metaplex.

**Why it matters:** Permanent proof of achievement. Badge NFTs appear in
the park owner's wallet.

**Milestones:**
- 100 guests: Bronze badge
- 1,000 guests: Silver badge  
- 10,000 guests: Gold badge
- 1M $PARK revenue: Diamond badge

---

## 💡 Future Ideas

### 13. Multi-Park World
Multiple Solana City parks on the same program. Parks can see each other's
guest counts, revenue, and park scores. Guests could "travel" between parks
(undelegate from one city's ER, re-delegate in another).

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
| 9 | $PARK SPL token | 🔜 Next | needs `anchor-spl` |
| 10 | Leaderboard | 🔜 Next | struct ready, instruction pending |
| 11 | Ride revenue staking | 🔜 Future | |
| 12 | Milestone badges (NFTs) | 🔜 Future | |
| 13 | Multi-park world | 💡 Idea | |
| 14 | Weather oracle | 💡 Idea | |
| 15 | Park bonds | 💡 Idea | |
| 16 | Claude Code park manager | 💡 Idea | |
