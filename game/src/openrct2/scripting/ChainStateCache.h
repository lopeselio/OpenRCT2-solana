/*****************************************************************************
 * OpenRCT2 × Solana fork
 * Reads chain-state.json (written by chain-sidecar) and exposes per-entity
 * wallet info for in-game windows. Cached + mtime-reloaded.
 *****************************************************************************/

#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace OpenRCT2::Scripting
{
    struct GuestWallet
    {
        std::string address; // base58 PDA
        uint64_t balance;     // in TYCOON micro-units (10^6 = 1 TYCOON)
        uint64_t pendingPrize;
        bool isActive;
    };

    struct VenueWallet
    {
        std::string address;
        uint64_t totalRevenue;
        uint64_t pendingPrize;
        uint32_t pendingPrizeGuestId;
        bool isBroken;
        bool isActive;
    };

    class ChainStateCache
    {
    public:
        static ChainStateCache& Get();

        // Lookups return std::nullopt if not present or file missing.
        // Each call may trigger an mtime check and reparse.
        std::optional<GuestWallet> GetGuest(uint32_t guestId);
        std::optional<VenueWallet> GetVenue(uint32_t venueId);

        // Operator's hot-wallet pubkey (base58). Always present once loaded.
        std::string GetOperator();

    private:
        ChainStateCache() = default;
        void ReloadIfChanged();

        std::string _operator;
        // Mapped by id; keep std::vector for cache-friendly iteration during reload.
        std::vector<std::optional<GuestWallet>> _guests;
        std::vector<std::optional<VenueWallet>> _venues;

        int64_t _lastMtime = 0;
        bool _attempted = false;
    };
} // namespace OpenRCT2::Scripting
