/**
 * Transport Manager for QuickText Jira MCP Server
 * Handles transport selection based on environment variables
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHttpTransport } from "./http-transport.js";

/**
 * Select and create appropriate transport based on configuration
 * 
 * @param {string} mode - Transport mode: 'stdio' | 'http'
 * @param {object} config - Transport configuration
 * @returns {object} Transport instance or config
 */
export async function selectTransport(mode, config = {}) {
  const transportMode = (mode || "stdio").toLowerCase();

  switch (transportMode) {
    case "http":
    case "sse":
      return {
        type: "http",
        init: async (server) => {
          await createHttpTransport(server, config);
        },
      };

    case "stdio":
    default:
      return {
        type: "stdio",
        transport: new StdioServerTransport(),
      };
  }
}

/**
 * Parse transport configuration from environment variables
 * 
 * @returns {object} Transport configuration
 */
export function getTransportConfig() {
  return {
    mode: process.env.MCP_TRANSPORT || "stdio",
    httpPort: parseInt(process.env.MCP_HTTP_PORT || "3000", 10),
    bindAddress: process.env.MCP_BIND_ADDRESS || "127.0.0.1",
    corsOrigin: process.env.MCP_CORS_ORIGIN || "*",
    timeout: parseInt(process.env.MCP_HTTP_TIMEOUT || "30000", 10),
  };
}
