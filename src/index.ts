#!/usr/bin/env node
/**
 * @fileoverview eia-energy-mcp-server MCP server entry point.
 * @module index
 */

import { createApp, disabledTool } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { browseRoutesTool } from './mcp-server/tools/definitions/browse-routes.tool.js';
import { dataframeDescribeTool } from './mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeDropTool } from './mcp-server/tools/definitions/dataframe-drop.tool.js';
import { dataframeQueryTool } from './mcp-server/tools/definitions/dataframe-query.tool.js';
import { describeRouteTool } from './mcp-server/tools/definitions/describe-route.tool.js';
import { queryRouteTool } from './mcp-server/tools/definitions/query-route.tool.js';
import { searchRoutesTool } from './mcp-server/tools/definitions/search-routes.tool.js';
import { initCanvasBridge } from './services/canvas-bridge/canvas-bridge.js';
import { initEiaApiService } from './services/eia/eia-service.js';

const serverConfig = getServerConfig();

const dropTool = serverConfig.dataframeDropEnabled
  ? dataframeDropTool
  : disabledTool(dataframeDropTool, {
      reason: 'Dataframe drop is disabled in this deployment.',
      hint: 'EIA_DATAFRAME_DROP_ENABLED=true',
    });

await createApp({
  tools: [
    browseRoutesTool,
    describeRouteTool,
    searchRoutesTool,
    queryRouteTool,
    dataframeDescribeTool,
    dataframeQueryTool,
    dropTool,
  ],
  setup(core) {
    initEiaApiService();
    initCanvasBridge(core.canvas);
  },
});
