/*****************************************************************************
 * OpenRCT2 × Solana fork — ChainStateCache implementation
 *****************************************************************************/

#include "ChainStateCache.h"

#include "../Context.h"
#include "../PlatformEnvironment.h"
#include "../core/Json.hpp"
#include "../core/Path.hpp"

#include <chrono>
#include <filesystem>
#include <system_error>

namespace OpenRCT2::Scripting
{
    static uint64_t ParseU64String(const json_t& j)
    {
        if (j.is_string())
        {
            try
            {
                return std::stoull(j.get<std::string>());
            }
            catch (...)
            {
                return 0;
            }
        }
        if (j.is_number_integer())
            return j.get<uint64_t>();
        return 0;
    }

    ChainStateCache& ChainStateCache::Get()
    {
        static ChainStateCache instance;
        return instance;
    }

    void ChainStateCache::ReloadIfChanged()
    {
        auto* context = GetContext();
        if (context == nullptr)
            return;

        auto path = Path::Combine(
            context->GetPlatformEnvironment().GetDirectoryPath(DirBase::user),
            u8"chain-state.json");

        std::error_code ec;
        auto fsPath = std::filesystem::path{ path };
        if (!std::filesystem::exists(fsPath, ec) || ec)
        {
            _attempted = true;
            return;
        }

        auto ftime = std::filesystem::last_write_time(fsPath, ec);
        if (ec)
        {
            _attempted = true;
            return;
        }
        int64_t mtime = std::chrono::duration_cast<std::chrono::seconds>(ftime.time_since_epoch()).count();
        if (mtime == _lastMtime)
            return;

        try
        {
            auto root = Json::ReadFromFile(path);
            _operator = Json::GetString(root["operator"]);

            _guests.clear();
            if (root["guests"].is_array())
            {
                for (auto& g : root["guests"])
                {
                    uint32_t id = Json::GetNumber<uint32_t>(g["id"]);
                    if (_guests.size() <= id)
                        _guests.resize(id + 1);
                    GuestWallet w;
                    w.address = Json::GetString(g["address"]);
                    w.balance = ParseU64String(g["balance"]);
                    w.pendingPrize = ParseU64String(g["pending_prize"]);
                    w.isActive = Json::GetBoolean(g["is_active"]);
                    _guests[id] = w;
                }
            }

            _venues.clear();
            if (root["venues"].is_array())
            {
                for (auto& v : root["venues"])
                {
                    uint32_t id = Json::GetNumber<uint32_t>(v["id"]);
                    if (_venues.size() <= id)
                        _venues.resize(id + 1);
                    VenueWallet w;
                    w.address = Json::GetString(v["address"]);
                    w.totalRevenue = ParseU64String(v["total_revenue"]);
                    w.pendingPrize = ParseU64String(v["pending_prize"]);
                    w.pendingPrizeGuestId = Json::GetNumber<uint32_t>(v["pending_prize_guest_id"]);
                    w.isBroken = Json::GetBoolean(v["is_broken"]);
                    w.isActive = Json::GetBoolean(v["is_active"]);
                    _venues[id] = w;
                }
            }

            _lastMtime = mtime;
            _attempted = true;
        }
        catch (...)
        {
            _attempted = true;
        }
    }

    std::optional<GuestWallet> ChainStateCache::GetGuest(uint32_t guestId)
    {
        ReloadIfChanged();
        if (guestId >= _guests.size())
            return std::nullopt;
        return _guests[guestId];
    }

    std::optional<VenueWallet> ChainStateCache::GetVenue(uint32_t venueId)
    {
        ReloadIfChanged();
        if (venueId >= _venues.size())
            return std::nullopt;
        return _venues[venueId];
    }

    std::string ChainStateCache::GetOperator()
    {
        ReloadIfChanged();
        return _operator;
    }
} // namespace OpenRCT2::Scripting
