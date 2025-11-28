/**
 * HTTP/SSE Transport for QuickText Jira MCP Server
 * Enables Postman MCP Client and HTTP-based testing
 * 
 * Compatible with MCP SDK 1.11.0 SSEServerTransport
 */

import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import cors from "cors";

/**
 * Creates HTTP transport with Server-Sent Events (SSE)
 * 
 * @param {import("@modelcontextprotocol/sdk/server/index.js").Server} server - MCP Server instance
 * @param {object} config - Configuration options
 * @param {number} config.port - HTTP port (default: 3000)
 * @param {string} config.bindAddress - Bind address (default: 127.0.0.1)
 * @param {string} config.corsOrigin - CORS origin (default: *)
 * @returns {Promise<void>}
 */
export async function createHttpTransport(server, config = {}) {
  const {
    port = 3000,
    bindAddress = "127.0.0.1",
    corsOrigin = "*",
  } = config;

  const app = express();

  // Enable CORS
  app.use(cors({
    origin: corsOrigin,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }));

  // Parse JSON bodies
  app.use(express.json());

  // Health check endpoint
  app.get("/health", (req, res) => {
    res.json({
      status: "healthy",
      service: "jira-enhanced-quicktext",
      version: "4.1.0",
      transport: "http-sse",
      tool_count: 30,
      timestamp: new Date().toISOString(),
    });
  });

  // SSE endpoint - MCP clients connect here
  app.get("/sse", async (req, res) => {
    console.error("[HTTP-SSE] New client connected");

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    try {
      // Create SSE transport and connect to MCP server
      const transport = new SSEServerTransport("/message", res);
      await server.connect(transport);

      // Handle client disconnect
      req.on("close", () => {
        console.error("[HTTP-SSE] Client disconnected");
      });
    } catch (error) {
      console.error("[HTTP-SSE] Connection error:", error);
      res.status(500).json({
        error: "Failed to establish SSE connection",
        message: error.message,
      });
    }
  });

  // Message endpoint - Receives MCP messages from clients
  app.post("/message", async (req, res) => {
    try {
      // SSEServerTransport handles the actual message processing
      // This endpoint acknowledges receipt
      res.status(202).json({ accepted: true });
    } catch (error) {
      console.error("[HTTP-SSE] Message handling error:", error);
      res.status(500).json({
        error: "Message processing failed",
        message: error.message,
      });
    }
  });

  // Optional: Tool discovery endpoint (read-only, no MCP protocol required)
  app.get("/tools", async (req, res) => {
    try {
      // This would require accessing the server's tool registry
      // For now, return a placeholder
      res.json({
        message: "Tool discovery via /tools endpoint",
        note: "Use MCP protocol via /sse for full tool interaction",
        tool_count: 30,
      });
    } catch (error) {
      console.error("[HTTP-SSE] Tool list error:", error);
      res.status(500).json({
        error: "Failed to list tools",
        message: error.message,
      });
    }
  });

  // Start HTTP server
  return new Promise((resolve, reject) => {
    const httpServer = app.listen(port, bindAddress, () => {
      console.error(`
╔════════════════════════════════════════════════════════════════════╗
║  🚀 QuickText Jira MCP Server - HTTP Transport Mode               ║
╠════════════════════════════════════════════════════════════════════╣
║  Version:          4.1.0                                           ║
║  Tools:            30 quicktext-jira_* tools                       ║
║  Transport:        HTTP/SSE (Server-Sent Events)                   ║
║                                                                    ║
║  Endpoints:                                                        ║
║    SSE:            http://${bindAddress}:${port}/sse                           ║
║    Message:        http://${bindAddress}:${port}/message                       ║
║    Health:         http://${bindAddress}:${port}/health                        ║
║    Tools:          http://${bindAddress}:${port}/tools                         ║
║                                                                    ║
║  📝 Postman MCP Configuration:                                     ║
║     Connect to:    http://${bindAddress}:${port}/sse                           ║
║     Method:        GET                                             ║
║                                                                    ║
║  ⚠️  Security:     Bound to ${bindAddress} (localhost only)             ║
╚════════════════════════════════════════════════════════════════════╝
      `);
      resolve();
    });

    httpServer.on("error", (error) => {
      if (error.code === "EADDRINUSE") {
        console.error(`[HTTP-SSE] ERROR: Port ${port} is already in use`);
        console.error(`[HTTP-SSE] Try setting MCP_HTTP_PORT to a different port`);
      } else {
        console.error(`[HTTP-SSE] Server error:`, error);
      }
      reject(error);
    });
  });
}
