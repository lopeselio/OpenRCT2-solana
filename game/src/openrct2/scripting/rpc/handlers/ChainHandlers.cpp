/*****************************************************************************
 * Copyright (c) 2014-2025 OpenRCT2 developers
 *
 * OpenRCT2 is licensed under the GNU General Public License version 3.
 *****************************************************************************/

#ifdef ENABLE_SCRIPTING

#include "../HandlerRegistry.h"
#include "../RpcTypes.h"
#include "HandlerInit.h"
#include "../../ChainOutbox.h"

namespace OpenRCT2::Scripting::Rpc::Handlers
{
    namespace
    {
        struct ChainRegistrar
        {
            ChainRegistrar()
            {
                HandlerRegistry::Instance().Register(
                    "chain.status",
                    [](const json_t& /*params*/) -> RpcResult {
                        return RpcResult::Ok({ { "ok", true } });
                    });
            }
        } chainRegistrar;
    } // namespace

    void InitChainHandlers()
    {
        (void)chainRegistrar;
    }

} // namespace OpenRCT2::Scripting::Rpc::Handlers

#endif // ENABLE_SCRIPTING
