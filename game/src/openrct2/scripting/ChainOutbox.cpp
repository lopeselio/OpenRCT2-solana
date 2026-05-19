/*****************************************************************************
 * Copyright (c) 2014-2025 OpenRCT2 developers
 *
 * OpenRCT2 is licensed under the GNU General Public License version 3.
 *****************************************************************************/

#include "ChainOutbox.h"

#include <iomanip>
#include <sstream>

namespace OpenRCT2::Scripting
{
    ChainOutbox& ChainOutbox::Get()
    {
        static ChainOutbox instance;
        return instance;
    }

    void ChainOutbox::Open(const std::string& path)
    {
        std::lock_guard<std::mutex> lock(_mutex);
        _file.open(path, std::ios::app | std::ios::out);
    }

    void ChainOutbox::Close()
    {
        std::lock_guard<std::mutex> lock(_mutex);
        if (_file.is_open())
            _file.close();
    }

    void ChainOutbox::Write(const std::string& json)
    {
        if (!_file.is_open())
            return;
        _file << json << '\n';
        _file.flush();
    }

    // ─── Escape a string for JSON ──────────────────────────────────────────
    static std::string JsonStr(std::string_view s)
    {
        std::string out;
        out.reserve(s.size() + 2);
        out += '"';
        for (char c : s)
        {
            switch (c)
            {
                case '"':  out += "\\\""; break;
                case '\\': out += "\\\\"; break;
                case '\n': out += "\\n";  break;
                case '\r': out += "\\r";  break;
                case '\t': out += "\\t";  break;
                default:   out += c;
            }
        }
        out += '"';
        return out;
    }

    // ─── Emit helpers ──────────────────────────────────────────────────────

    void ChainOutbox::EmitGuestEntry(int32_t guestId, double cashDecimal)
    {
        std::lock_guard<std::mutex> lock(_mutex);
        std::ostringstream ss;
        ss << std::fixed << std::setprecision(6) << cashDecimal;
        std::string json =
            "{\"kind\":\"GUEST_ENTRY\",\"seq\":" + std::to_string(_seq++) +
            ",\"ts\":" + std::to_string(NowMs()) +
            ",\"guestId\":" + std::to_string(guestId) +
            ",\"cash\":\"" + ss.str() + "\"}";
        Write(json);
    }

    void ChainOutbox::EmitGuestSpend(int32_t guestId, int32_t venueId,
                                     double amount, int32_t category, int32_t gameTick)
    {
        std::lock_guard<std::mutex> lock(_mutex);
        std::ostringstream ss;
        ss << std::fixed << std::setprecision(6) << amount;
        std::string json =
            "{\"kind\":\"GUEST_SPEND\",\"seq\":" + std::to_string(_seq++) +
            ",\"ts\":" + std::to_string(NowMs()) +
            ",\"guestId\":" + std::to_string(guestId) +
            ",\"venueId\":" + std::to_string(venueId) +
            ",\"amount\":\"" + ss.str() + "\"" +
            ",\"category\":" + std::to_string(category) +
            ",\"gameTick\":" + std::to_string(gameTick) + "}";
        Write(json);
    }

    void ChainOutbox::EmitGuestExit(int32_t guestId)
    {
        std::lock_guard<std::mutex> lock(_mutex);
        std::string json =
            "{\"kind\":\"GUEST_EXIT\",\"seq\":" + std::to_string(_seq++) +
            ",\"ts\":" + std::to_string(NowMs()) +
            ",\"guestId\":" + std::to_string(guestId) + "}";
        Write(json);
    }

    void ChainOutbox::EmitVenueRegistered(int32_t venueId, int32_t venueKind,
                                          std::string_view name, std::string_view objectType)
    {
        std::lock_guard<std::mutex> lock(_mutex);
        std::string json =
            "{\"kind\":\"VENUE_REGISTERED\",\"seq\":" + std::to_string(_seq++) +
            ",\"ts\":" + std::to_string(NowMs()) +
            ",\"venueId\":" + std::to_string(venueId) +
            ",\"venueKind\":" + std::to_string(venueKind) +
            ",\"name\":" + JsonStr(name) +
            ",\"objectType\":" + JsonStr(objectType) + "}";
        Write(json);
    }

    void ChainOutbox::EmitVenueRenamed(int32_t venueId, std::string_view newName)
    {
        std::lock_guard<std::mutex> lock(_mutex);
        std::string json =
            "{\"kind\":\"VENUE_RENAMED\",\"seq\":" + std::to_string(_seq++) +
            ",\"ts\":" + std::to_string(NowMs()) +
            ",\"venueId\":" + std::to_string(venueId) +
            ",\"newName\":" + JsonStr(newName) + "}";
        Write(json);
    }

    void ChainOutbox::EmitVenueRemoved(int32_t venueId)
    {
        std::lock_guard<std::mutex> lock(_mutex);
        std::string json =
            "{\"kind\":\"VENUE_REMOVED\",\"seq\":" + std::to_string(_seq++) +
            ",\"ts\":" + std::to_string(NowMs()) +
            ",\"venueId\":" + std::to_string(venueId) + "}";
        Write(json);
    }

} // namespace OpenRCT2::Scripting
