# OpenRCT2 × Solana City

A Solana on-chain layer for [OpenRCT2-solana](https://github.com/jaysobel/OpenRCT2) using
**MagicBlock Ephemeral Rollups** — making every guest spend, ride visit, and
venue interaction a real blockchain transaction at ~10-50ms latency.

---

## What This Is

When you play the park, every economic event becomes real:

- Guests enter with a **$PARK token balance** stored on-chain
- Every ride, food purchase, and ATM withdrawal is a **Solana transaction**
- Revenues accumulate in **venue accounts** visible on-chain
- Random events (ride breakdowns, lucky prizes) use **cryptographically verifiable randomness**
- A **self-scheduling crank** updates the park score every 30 seconds — with no server

---

## Features

### Core

| Feature | Description |
|---------|-------------|
| **Guest accounts** | Each guest gets a PDA (`GuestAccount`) holding their balance and spend history |
| **Venue accounts** | Each ride/shop/facility gets a PDA (`VenueAccount`) accumulating revenue |
| **City state** | One `CityState` PDA tracks park-wide stats (total guests, revenue, score) |
| **NDJSON outbox** | C++ game writes events atomically; sidecar tails the file without blocking gameplay |
| **Chain sidecar** | TypeScript process that watches the outbox and routes transactions to Solana |

### Unique to Solana

#### MagicBlock Ephemeral Rollup (~10-50ms per spend)
Guest spend transactions run on a **delegated ephemeral rollup** — not the base
Solana chain. This means:
- No confirmation latency during gameplay
- Accounts "teleport" to the ER on guest entry, back on exit
- Base layer stays consistent via periodic commits

#### VRF Random Park Events
Uses `ephemeral-vrf-sdk` for **verifiable randomness** — the outcome is provable
on-chain, not just a pseudo-random number the server controls.

Random event table (triggered ~once per guest per visit):

| Roll (0–99) | Event | Effect |
|------------|-------|--------|
| 0–19 | **Ride breakdown** | `venue.is_broken = true` — guests can't use it until repaired |
| 20–49 | Quiet day | Nothing |
| 50–79 | **Lucky guest wins prize** | 50–500 $PARK awarded to the guest |
| 80–99 | **Park bonus** | +10 $PARK to the current guest |

The breakdown mechanic is meaningful: a ride that breaks earns no revenue until
`repair_venue` is called (by the sidecar or park manager wallet).

#### Crank — Automated Park Tick (no server needed)
A MagicBlock crank automatically runs `auto_park_tick` every **30 seconds** on
the Ephemeral Rollup. No cron job, no cloud function needed. The ER handles it.

The tick:
1. Recalculates **park score** (0–1000) from guest count + revenue
2. Logs the current state on-chain

Score formula: `500 + min(active_guests, 200) + min(revenue / 1M, 300)`

#### On-Chain Repair System
When VRF marks a ride broken, the park must call `repair_venue` to bring it
back online. This creates a real management decision: do you spend sidecar SOL
to repair, or leave it and lose revenue?

---

## Architecture

```
OpenRCT2-solana (C++)
  ├── ChainOutbox.h / .cpp     — appends NDJSON events to outbox file
  └── rpc/handlers/ChainHandlers.cpp  — chain.status RPC endpoint

chain-sidecar/ (TypeScript)
  ├── outbox/reader.ts         — tails the NDJSON file (50ms poll)
  ├── outbox/types.ts          — TypeScript types for all 6 event kinds
  ├── solana/clients.ts        — dual connections: base layer + ER
  ├── solana/accounts.ts       — PDA derivation helpers
  ├── solana/delegate.ts       — transaction builders for all operations
  └── main.ts                  — event dispatcher + city initializer

programs/solana-city/ (Rust/Anchor)
  ├── src/
  │   ├── lib.rs               — program entry + #[ephemeral] macro
  │   ├── state.rs             — CityState, GuestAccount, VenueAccount
  │   ├── errors.rs            — CityError enum
  │   └── instructions/
  │       ├── city.rs          — initialize_city, update_park_score
  │       ├── guest.rs         — register, delegate, spend, commit, exit
  │       ├── venue.rs         — register, delegate, rename, repair, remove
  │       ├── vrf.rs           — request_park_event, consume_park_event
  │       └── crank.rs         — schedule_park_crank, auto_park_tick
  └── Cargo.toml
```

---

## Getting Started

### Prerequisites

```bash
# Solana + Anchor toolchain
solana --version   # 2.1+
anchor --version   # 0.32.1
node --version     # 18+
cargo --version    # 1.79+
```

### Build the Anchor program

```bash
cd solana-city
anchor build
```

### Run the chain sidecar

```bash
cd solana-city/chain-sidecar
npm install
cp .env.example .env  # edit WALLET_PATH, OUTBOX_PATH, PROGRAM_ID
npm run dev
```

### Environment variables

```bash
# .env
BASE_RPC=https://api.devnet.solana.com
EPHEMERAL_PROVIDER_ENDPOINT=https://devnet.magicblock.app/
EPHEMERAL_WS_ENDPOINT=wss://devnet.magicblock.app/
WALLET_PATH=~/.config/solana/id.json
OUTBOX_PATH=~/Library/Application Support/OpenRCT2/chain-outbox.ndjson
PROGRAM_ID=XP3NQyV6mBX53QxiJgGpSJyKcD6dSLJWkPaK8QZzNkg
CITY_NAME=Solana City
```

### Wire up the game (C++)

Add to your game startup (e.g. `ScriptEngine.cpp`):

```cpp
#include "ChainOutbox.h"

// On game load:
OpenRCT2::Scripting::ChainOutbox::Get().Open(
    GetEnvironment().GetDirectoryPath(DIRBASE::USER, "chain-outbox.ndjson")
);

// On game exit:
OpenRCT2::Scripting::ChainOutbox::Get().Close();
```

Then call `ChainOutbox::Get().EmitGuestEntry(...)` etc. from existing handlers
(see `GuestHandlers.cpp` for where guests pay entrance fees).

---

## TODO / Roadmap

See [FEATURES.md](./FEATURES.md) for the full prioritized feature list.

Core working: Anchor program compiles, sidecar routes events, VRF + crank wired.
Next: integrate C++ emit calls into game handlers, deploy to devnet, end-to-end test.
