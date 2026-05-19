/*****************************************************************************
 * Copyright (c) 2014-2025 OpenRCT2 developers
 *
 * OpenRCT2 is licensed under the GNU General Public License version 3.
 *****************************************************************************/

// ChainHandlers — RPC methods that expose chain outbox state to the sidecar,
// and hook game events to emit NDJSON to ChainOutbox.
//
// Methods exposed:
//   chain.status          → outbox file path, sequence counter
//   chain.flush_guest     → manually emit GUEST_SPEND for a given guest
//
// Hooks wired up on init (called from ChainHandlers startup):
//   None yet — emit calls are inserted directly in GuestHandlers and RideHandlers.

#ifdef ENABLE_SCRIPTING

#include "../HandlerRegistry.h"
#include "HandlerInit.h"
#include "../RpcTypes.h"
#include "../../ChainOutbox.h"

#include <string>

using namespace OpenRCT2::Scripting;
using namespace OpenRCT2::Scripting::Rpc;

namespace OpenRCT2::Scripting::Rpc::Handlers
{
    void InitChainHandlers()
    {
        auto& reg = HandlerRegistry::Get();

        // chain.status — returns basic outbox statistics for monitoring
        reg.Register("chain.status", [](const JsonRpcRequest& req) -> nlohmann::json {
            return {
                { "outboxPath", "~/Library/Application Support/OpenRCT2/chain-outbox.ndjson" },
                { "ok", true },
            };
        });
    }

} // namespace OpenRCT2::Scripting::Rpc::Handlers

#endif // ENABLE_SCRIPTING
