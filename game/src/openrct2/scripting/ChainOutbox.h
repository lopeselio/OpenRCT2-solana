/*****************************************************************************
 * Copyright (c) 2014-2025 OpenRCT2 developers
 *
 * OpenRCT2 is licensed under the GNU General Public License version 3.
 *****************************************************************************/

#pragma once

#include <chrono>
#include <cstdint>
#include <fstream>
#include <mutex>
#include <string>
#include <string_view>

// ChainOutbox — writes game economic events as NDJSON to a file that the
// Solana chain-sidecar tails. All writes are append-only and atomic (one
// fwrite per event). The hot path (game tick) never blocks on this.

namespace OpenRCT2::Scripting
{
    class ChainOutbox
    {
    public:
        static ChainOutbox& Get();

        // Open (or create) the outbox file. Call once at game startup.
        void Open(const std::string& path);

        // Close the outbox. Call on game exit.
        void Close();

        // Guest buys a ticket and enters the park.
        void EmitGuestEntry(int32_t guestId, double cashDecimal);

        // Guest pays at any venue (ride, shop, food, ATM, etc.).
        void EmitGuestSpend(int32_t guestId, int32_t venueId, double amount,
                            int32_t category, int32_t gameTick);

        // Guest leaves the park.
        void EmitGuestExit(int32_t guestId);

        // A new ride / shop / facility is placed on the map.
        void EmitVenueRegistered(int32_t venueId, int32_t venueKind,
                                 std::string_view name, std::string_view objectType);

        // A venue is renamed in-game.
        void EmitVenueRenamed(int32_t venueId, std::string_view newName);

        // A venue is demolished.
        void EmitVenueRemoved(int32_t venueId);

    private:
        ChainOutbox() = default;
        void Write(const std::string& json);

        std::ofstream _file;
        std::mutex    _mutex;
        uint64_t      _seq{ 0 };

        int64_t NowMs() const
        {
            using namespace std::chrono;
            return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
        }
    };

} // namespace OpenRCT2::Scripting
