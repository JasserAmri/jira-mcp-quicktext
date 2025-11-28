/**
 * Transport Manager for QuickText Jira MCP Server v4.2
 * Handles transport selection based on environment variables
 * Updated to use StreamableHTTPServerTransport (non-deprecated)
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createStreamableHttpTransport } from "./streamable-http-transport.js";

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
    case "streamable":
    case "streamablehttp":
      return {
        type: "http",
        init: async (server) => {
          await createStreamableHttpTransport(server, config);
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
  // Parse allowed hosts/origins from comma-separated strings
  const allowedHosts = process.env.MCP_ALLOWED_HOSTS
    ? process.env.MCP_ALLOWED_HOSTS.split(",").map(h => h.trim()).filter(Boolean)
    : [];
  
  const allowedOrigins = process.env.MCP_ALLOWED_ORIGINS
    ? process.env.MCP_ALLOWED_ORIGINS.split(",").map(o => o.trim()).filter(Boolean)
    : [];

  return {
    mode: process.env.MCP_TRANSPORT || "stdio",
    httpPort: parseInt(process.env.MCP_HTTP_PORT || "3000", 10),
    endpoint: process.env.MCP_HTTP_ENDPOINT || "/mcp",
    bindAddress: process.env.MCP_BIND_ADDRESS || "127.0.0.1",
    corsOrigin: process.env.MCP_CORS_ORIGIN || "*",
    allowedHosts,
    allowedOrigins,
    enableDnsProtection: process.env.MCP_ENABLE_DNS_PROTECTION === "true",
    timeout: parseInt(process.env.MCP_HTTP_TIMEOUT || "30000", 10),
  };
}
