# OpenRCT2 × Solana City — Chain Architecture

## Overview

This is a Solana-native on-chain layer for OpenRCT2-solana. Every economic action
a guest takes in the park (buying a ticket, riding a coaster, eating food) is
recorded on Solana and settled on the **MagicBlock Ephemeral Rollup** at
**~10-50ms** latency — fast enough to keep up with real-time gameplay.

Built for Solana's account model with unique capabilities impossible on EVM chains:
**VRF random events**, **on-chain cranks** (automated tasks with no server), and
**SPL-native balances**.

```
OpenRCT2-solana (C++ Game)
  └── ChainOutbox (NDJSON file)
        │ ~50ms poll
        ▼
chain-sidecar (TypeScript)
  ├── Base Layer txns (Solana devnet ~400ms)
  │   guest register + delegate, venue register + delegate
  └── Ephemeral Rollup txns (MagicBlock ~10-50ms)
      guest spend, commit, exit, rename venue, remove venue
        │
        ▼
Anchor Program: solana_city
  ├── CityState PDA  [b"city"]
  ├── GuestAccount   [b"guest", u32_le]  ← delegated to ER
  └── VenueAccount   [b"venue", u32_le]  ← delegated to ER
```

## Data Flow

### Guest enters the park
1. C++ game emits `GUEST_ENTRY { guestId, cash }` to `chain-outbox.ndjson`
2. Sidecar picks up the event and sends two transactions to **base layer**:
   - `register_guest(guestId, initialBalance)` — creates the GuestAccount PDA
   - `delegate_guest(guestId)` — hands ownership to the Ephemeral Rollup
3. All future guest operations go to the ER at game speed

### Guest spends (ride, food, shop)
1. C++ game emits `GUEST_SPEND { guestId, venueId, amount, category, tick }`
2. Sidecar routes to **Ephemeral Rollup**:
   - `spend(guestId, venueId, amount, category)` — debits guest, credits venue
3. No confirmation needed for gameplay to continue — ER handles at ~10ms

### Guest exits
1. C++ game emits `GUEST_EXIT { guestId }`
2. Sidecar sends to **Ephemeral Rollup**:
   - `exit_guest()` — sets `is_active = false`, commits state + undelegates
3. GuestAccount returns to base layer with final balance + spend history

### Venues (rides, shops, facilities)
- `VENUE_REGISTERED` → `register_venue` + `delegate_venue` on base layer
- `VENUE_RENAMED` → `rename_venue` on ER (~10ms)
- `VENUE_REMOVED` → `remove_venue` on ER (commit + undelegate)

## Transaction Routing Table

| Event | Instruction | Endpoint |
|-------|-------------|----------|
| Guest enters | `register_guest` + `delegate_guest` | Base Layer |
| Guest spends | `spend` | Ephemeral Rollup |
| Guest mid-session sync | `commit_guest` | Ephemeral Rollup |
| Guest exits | `exit_guest` | Ephemeral Rollup |
| Venue placed | `register_venue` + `delegate_venue` | Base Layer |
| Venue renamed | `rename_venue` | Ephemeral Rollup |
| Venue removed | `remove_venue` | Ephemeral Rollup |
| VRF event request | `request_park_event` | Ephemeral Rollup |
| Crank schedule | `schedule_park_crank` | Ephemeral Rollup |

## Non-blocking Design

The sidecar **never blocks the game**. Events queue up in memory if Solana is
slow or the sidecar restarts. The game writes NDJSON atomically (one `fwrite`
per event); the sidecar tails the file and processes events sequentially to
avoid PDA race conditions.

## Account Ownership States

```
Not delegated (base layer):  account.owner == solana_city program ID
Delegated (in ER):           account.owner == DELEGATION_PROGRAM_ID
After exit/remove:           account.owner == solana_city program ID (again)
```
