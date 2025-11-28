/**
 * StreamableHTTP Transport for QuickText Jira MCP Server v4.2
 * Implements official MCP Streamable HTTP specification (Nov 25, 2024)
 * Replaces deprecated SSEServerTransport
 * 
 * Compatible with MCP SDK 1.21.1 StreamableHTTPServerTransport
 */

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";

/**
 * Creates StreamableHTTP transport with proper MCP protocol compliance
 * 
 * @param {import("@modelcontextprotocol/sdk/server/index.js").Server} server - MCP Server instance
 * @param {object} config - Configuration options
 * @param {number} config.port - HTTP port (default: 3000)
 * @param {string} config.bindAddress - Bind address (default: 127.0.0.1)
 * @param {string} config.corsOrigin - CORS origin (default: *)
 * @param {string} config.endpoint - MCP endpoint path (default: /mcp)
 * @param {string[]} config.allowedHosts - Allowed Host headers for DNS protection
 * @param {string[]} config.allowedOrigins - Allowed Origin headers for DNS protection
 * @param {boolean} config.enableDnsProtection - Enable DNS rebinding protection (default: false)
 * @returns {Promise<void>}
 */
export async function createStreamableHttpTransport(server, config = {}) {
  const {
    port = 3000,
    bindAddress = "127.0.0.1",
    corsOrigin = "*",
    endpoint = "/mcp",
    allowedHosts = [],
    allowedOrigins = [],
    enableDnsProtection = false,
  } = config;

  const app = express();

  // Enable CORS
  app.use(cors({
    origin: corsOrigin,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Last-Event-ID"],
    exposedHeaders: ["X-Session-ID"],
  }));

  // Parse JSON bodies
  app.use(express.json());

  // Health check endpoint (non-MCP)
  app.get("/health", (req, res) => {
    res.json({
      status: "healthy",
      service: "jira-enhanced-quicktext",
      version: "4.2.0",
      transport: "streamable-http",
      tool_count: 30,
      mcp_endpoint: endpoint,
      timestamp: new Date().toISOString(),
    });
  });

  // Track active transports by session
  const activeTransports = new Map();

  // Unified MCP endpoint - handles GET (SSE) and POST (messages)
  app.all(endpoint, async (req, res) => {
    try {
      if (req.method === "GET") {
        // SSE stream initialization
        console.error("[StreamableHTTP] New SSE connection request");

        // Create transport with session management
        const transport = new StreamableHTTPServerTransport(req, res, {
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: async (sessionId) => {
            console.error(`[StreamableHTTP] Session initialized: ${sessionId}`);
            activeTransports.set(sessionId, transport);
          },
          onsessionclosed: async (sessionId) => {
            console.error(`[StreamableHTTP] Session closed: ${sessionId}`);
            activeTransports.delete(sessionId);
          },
          enableJsonResponse: false, // Force SSE streaming
          allowedHosts: allowedHosts.length > 0 ? allowedHosts : undefined,
          allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : undefined,
          enableDnsRebindingProtection: enableDnsProtection,
        });

        // Connect MCP server to transport
        await server.connect(transport);
        
        console.error("[StreamableHTTP] SSE stream established");

      } else if (req.method === "POST") {
        // Message handling - route to correct session
        const sessionId = req.query.sessionId || req.body?.sessionId;
        
        if (!sessionId) {
          return res.status(400).json({
            error: "Missing sessionId",
            message: "POST requests must include sessionId query parameter or in body",
          });
        }

        const transport = activeTransports.get(sessionId);
        
        if (!transport) {
          return res.status(404).json({
            error: "Session not found",
            message: `No active session with ID: ${sessionId}`,
          });
        }

        // Let transport handle the message
        await transport.handleRequest(req, res);
        
      } else if (req.method === "DELETE") {
        // Session termination
        const sessionId = req.query.sessionId;
        
        if (!sessionId) {
          return res.status(400).json({
            error: "Missing sessionId",
            message: "DELETE requests must include sessionId query parameter",
          });
        }

        const transport = activeTransports.get(sessionId);
        
        if (transport) {
          await transport.close();
          activeTransports.delete(sessionId);
          res.status(200).json({ message: "Session terminated" });
        } else {
          res.status(404).json({
            error: "Session not found",
            message: `No active session with ID: ${sessionId}`,
          });
        }
        
      } else {
        res.status(405).json({
          error: "Method not allowed",
          message: `Supported methods: GET (SSE), POST (messages), DELETE (close session)`,
        });
      }

    } catch (error) {
      console.error("[StreamableHTTP] Error:", error);
      
      if (!res.headersSent) {
        res.status(500).json({
          error: "Internal server error",
          message: error.message,
        });
      }
    }
  });

  // Start HTTP server
  return new Promise((resolve, reject) => {
    const httpServer = app.listen(port, bindAddress, () => {
      console.error(`
╔════════════════════════════════════════════════════════════════════╗
║  🚀 QuickText Jira MCP Server - StreamableHTTP Transport         ║
╠════════════════════════════════════════════════════════════════════╣
║  Version:          4.2.0                                           ║
║  Tools:            30 quicktext-jira_* tools                       ║
║  Transport:        StreamableHTTP (MCP SDK 1.21.1)                 ║
║  Protocol:         MCP Streamable HTTP Specification               ║
║                                                                    ║
║  Unified Endpoint:                                                 ║
║    MCP:            http://${bindAddress}:${port}${endpoint}                         ║
║    Health:         http://${bindAddress}:${port}/health                        ║
║                                                                    ║
║  📝 Postman MCP Configuration:                                     ║
║     Connect to:    http://${bindAddress}:${port}${endpoint}                         ║
║     Method:        GET (for SSE stream)                            ║
║                                                                    ║
║  🔒 Security:                                                      ║
║     Bind Address:  ${bindAddress} (localhost only)             ║
║     DNS Protection: ${enableDnsProtection ? 'ENABLED' : 'DISABLED'}                                      ║
║                                                                    ║
║  ⚡ Features:                                                      ║
║     ✓ Session management                                          ║
║     ✓ SSE streaming                                                ║
║     ✓ JSON-RPC 2.0 messages                                        ║
║     ${enableDnsProtection ? '✓' : '○'} DNS rebinding protection                                 ║
║     ○ EventStore resumability (future)                             ║
╚════════════════════════════════════════════════════════════════════╝
      `);
      resolve();
    });

    httpServer.on("error", (error) => {
      if (error.code === "EADDRINUSE") {
        console.error(`[StreamableHTTP] ERROR: Port ${port} is already in use`);
        console.error(`[StreamableHTTP] Try setting MCP_HTTP_PORT to a different port`);
      } else {
        console.error(`[StreamableHTTP] Server error:`, error);
      }
      reject(error);
    });
  });
}
