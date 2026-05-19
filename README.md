# OpenRCT2 × Solana City

A Solana on-chain layer for a fork of [OpenRCT2](https://github.com/jaysobel/OpenRCT2)
using **MagicBlock Ephemeral Rollups** — making every guest spend, ride visit,
and venue interaction a real blockchain transaction at ~10-50ms latency.

**Status:** Anchor program deployed and live on **Solana devnet**. ER endpoint runs on
**MagicBlock devnet**. See [Deployed Addresses](#deployed-addresses-devnet) below.

---

## What This Is

When you play the park, every economic event becomes real:

- Guests enter with a **$PARK token balance** stored on-chain
- Every ride, food purchase, and ATM withdrawal is a **Solana transaction**
- Revenues accumulate in **venue accounts** visible on-chain
- Random events (ride breakdowns, lucky prizes) use **cryptographically verifiable randomness**
- A **self-scheduling crank** updates the park score every 30 seconds — with no server
- Players earn **milestone badges** and submit scores to a global **leaderboard**, while LPs **stake $PARK** on individual venues

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

## Deployed Addresses (Devnet)

The program is live on Solana **devnet** under upgrade authority
`HDDYb8NAzwMVuobJJD4UCYzeFNgSawJ2vJhPMfFLBiLB`. The deployed binary is
byte-identical to the current `programs/solana-city/` source.

### Program

| Account | Address | Notes |
|---|---|---|
| `solana_city` program | `2ce1z7iFfMB6BHzaWvT5jqhsDsS6jeEjvymGYwrb8wDn` | Same ID on localnet/devnet (`Anchor.toml`) |
| Upgrade authority | `HDDYb8NAzwMVuobJJD4UCYzeFNgSawJ2vJhPMfFLBiLB` | Devnet wallet |

### Singleton PDAs (initialized on devnet)

| Account | Address | Seeds |
|---|---|---|
| `$PARK` token mint | `7vBp2RpMtfpjexC8z7sWV4nUFHNNskQQBxGrRkfSUYN1` | `["park_mint"]` |
| Leaderboard | `8AqUe5DTaoCBzUZt5ZQLTdH6khBTcyPE8Veo7qk2uTxA` | `["leaderboard"]` |
| City (`park_id=1`) | `CUW5Ea9uSvfppPD5PmLykKzSrLYxysCNwDcLSFk86kq` | `["city", park_id_u32_le]` |

### Per-instance PDA seed reference

All seeds use the program ID `2ce1z7iFfMB6BHzaWvT5jqhsDsS6jeEjvymGYwrb8wDn`.
`u32_le` = 4-byte little-endian.

| PDA | Seeds |
|---|---|
| `CityState` | `["city", park_id_u32_le]` |
| `GuestAccount` | `["guest", park_id_u32_le, guest_id_u32_le]` |
| `VenueAccount` | `["venue", park_id_u32_le, venue_id_u32_le]` |
| `VenueStakeVault` | `["vault", park_id_u32_le, venue_id_u32_le]` |
| `StakePosition` | `["stake", park_id_u32_le, venue_id_u32_le, staker_pubkey]` |
| `Badge` | `["badge", city_pubkey, tier_u8]` |
| `$PARK` mint | `["park_mint"]` |
| `Leaderboard` | `["leaderboard"]` |

### Endpoints

| Layer | URL |
|---|---|
| Base (Solana devnet) RPC | `https://api.devnet.solana.com` |
| MagicBlock ER RPC | `https://devnet.magicblock.app/` |
| MagicBlock ER WS | `wss://devnet.magicblock.app/` |

---

## Architecture

### High-level data flow

```
┌──────────────────────┐   NDJSON outbox        ┌────────────────────────┐
│ OpenRCT2 (C++ game)  │ ─────────────────────▶ │ chain-sidecar (TS)     │
│  • game loop         │  ~/Library/Application │  • tails outbox        │
│  • robot terminal    │   Support/OpenRCT2/    │  • classifies events   │
│  • rctctl CLI        │   chain-outbox.ndjson  │  • routes to base / ER │
└──────────────────────┘                        └─────────┬──────────────┘
        ▲                                                 │
        │ in-game CLI / agent                             │
        │                                                 ▼
                                            ┌──────────────────────────────┐
                                            │ Solana devnet (base layer)   │
                                            │  • city init, registrations  │
                                            │  • $PARK mint + redeem       │
                                            │  • stake / claim_prize       │
                                            │  • leaderboard, badges       │
                                            └─────────┬────────────────────┘
                                                      │ delegate / commit /
                                                      │ undelegate
                                                      ▼
                                            ┌──────────────────────────────┐
                                            │ MagicBlock Ephemeral Rollup  │
                                            │ (devnet.magicblock.app)      │
                                            │  • spend (hot path)          │
                                            │  • request_park_event (VRF)  │
                                            │  • auto_park_tick (crank)    │
                                            └──────────────────────────────┘
```

Guest and venue accounts are created on the base layer, then **delegated to
the ER** for fast gameplay (`spend`, VRF, crank). Periodic `commit_*` syncs
flush state back to devnet; `exit_*` undelegates and returns final state.

### Source tree

```
openrct-solana/
├── game/                       — OpenRCT2 C++ fork (build dir, robot terminal, rctctl)
│   ├── src/openrct2/scripting/rpc/handlers/ChainHandlers.cpp  — chain.status RPC
│   └── src/openrct2/...         — ChainOutbox NDJSON writer wired into Guest/Ride/Game
│
├── programs/solana-city/       — Anchor program (Rust)
│   ├── Cargo.toml              — anchor 0.32.1, ephemeral-rollups-sdk 0.11.1,
│   │                             ephemeral-vrf-sdk 0.2.3, magicblock-magic-program-api 0.8.5
│   └── src/
│       ├── lib.rs              — #[ephemeral] program entry, 28 instructions
│       ├── state.rs            — account types
│       ├── errors.rs           — CityError enum
│       └── instructions/
│           ├── city.rs         — initialize_city, update_park_score
│           ├── guest.rs        — register / delegate / claim_prize / commit / exit
│           ├── venue.rs        — register / delegate / rename / repair / remove / deactivate
│           ├── token.rs        — initialize_park_mint, redeem_balance
│           ├── staking.rs      — create_stake_vault, stake, unstake, claim_stake_rewards
│           ├── leaderboard.rs  — initialize_leaderboard, submit_score
│           ├── badges.rs       — claim_badge (milestone tiers)
│           ├── vrf.rs          — request_park_event, consume_park_event, apply_vrf_result
│           └── crank.rs        — schedule_park_crank, auto_park_tick
│
├── chain-sidecar/              — TypeScript event router
│   └── src/
│       ├── main.ts             — dispatcher + city/$PARK bootstrap
│       ├── e2e.ts              — devnet end-to-end smoke
│       ├── outbox/             — NDJSON tail reader + event types
│       ├── solana/
│       │   ├── clients.ts      — dual provider: devnet + MagicBlock ER
│       │   ├── accounts.ts     — PDA derivation
│       │   └── delegate.ts     — base ↔ ER transaction builders
│       └── ipc/                — JSON-RPC bridge to the game
│
├── tests/                      — Anchor mocha suite (devnet ER + localnet multi-park)
├── migrations/                 — Anchor deploy scripts
└── Anchor.toml, Cargo.toml     — workspace config
```

### Program instructions (28)

| Module | Instructions |
|---|---|
| `city` | `initialize_city`, `update_park_score` |
| `guest` | `register_guest`, `delegate_guest`, `spend`, `claim_prize`, `commit_guest`, `exit_guest` |
| `venue` | `register_venue`, `delegate_venue`, `rename_venue`, `repair_venue`, `remove_venue`, `deactivate_venue` |
| `token` | `initialize_park_mint`, `redeem_balance` |
| `staking` | `create_stake_vault`, `stake`, `unstake`, `claim_stake_rewards` |
| `leaderboard` | `initialize_leaderboard`, `submit_score` |
| `badges` | `claim_badge` |
| `vrf` | `request_park_event`, `consume_park_event`, `apply_vrf_result` |
| `crank` | `schedule_park_crank`, `auto_park_tick` |

---

## Getting Started

### Prerequisites

```bash
solana --version   # 2.1+
anchor --version   # 0.32.1
node --version     # 18+
cargo --version    # 1.79+
# macOS game build also needs:
brew install libvterm pkg-config cmake ninja
```

A funded devnet wallet at `~/.config/solana/id.json` (`solana airdrop 2 --url devnet`)
and a Steam/GOG install of RollerCoaster Tycoon 2 (launch once so the assets
land in `~/Library/Application Support/OpenRCT2/`).

### Build everything

```bash
# Anchor program
anchor build                                        # → target/deploy/solana_city.so

# Native game (macOS)
cd game
cmake -S . -B build -G Ninja                        # one-time
cmake --build build --target agent_bundle -j8
cd ..

# Chain sidecar
cd chain-sidecar && npm install && cd ..
```

### Run end-to-end (devnet + MagicBlock devnet ER)

No local validator needed — the program is **already deployed on devnet** at
`2ce1z7iFfMB6BHzaWvT5jqhsDsS6jeEjvymGYwrb8wDn` and the sidecar talks to
MagicBlock's devnet ER directly.

```bash
# Terminal 1 — sidecar (tails the game's NDJSON outbox, routes to devnet + ER)
cd chain-sidecar
npm run dev

# Terminal 2 — game
cd game
./build/OpenRCT2.app/Contents/MacOS/OpenRCT2 \
    --verbose --log-file game-logs/session.log
```

In the game, click the robot icon in the toolbar to open the AI agent terminal
(launches Claude Code if `claude` is on `PATH`, otherwise the bootstrap REPL).

### Environment variables (optional overrides)

All defaults already point at devnet — only set these to override.

```bash
# chain-sidecar/.env
BASE_RPC=https://api.devnet.solana.com
EPHEMERAL_PROVIDER_ENDPOINT=https://devnet.magicblock.app/
EPHEMERAL_WS_ENDPOINT=wss://devnet.magicblock.app/
WALLET_PATH=~/.config/solana/id.json
OUTBOX_PATH=~/Library/Application Support/OpenRCT2/chain-outbox.ndjson
PROGRAM_ID=2ce1z7iFfMB6BHzaWvT5jqhsDsS6jeEjvymGYwrb8wDn
PARK_ID=1
CITY_NAME=Solana City
```

### Tests

```bash
# Anchor program tests against devnet + MagicBlock ER
yarn ts-mocha -p ./tsconfig.json -t 180000 tests/solana-city-er.ts

# Game CLI validation (fast)
cd game/build && ctest -R rctctl_validation

# Full headless E2E
cd game/build && ctest -R agent_scenarios
```

---

## Roadmap

See [FEATURES.md](./FEATURES.md) for the prioritized feature list.
See [CHAIN.md](./CHAIN.md) for the event router contract (outbox event types,
delegation rules, ER routing).
