import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { Request, Response } from "express";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";

/**
 * Creates an HTTP transport layer for the MCP server using Server-Sent Events (SSE)
 * Compatible with Postman MCP client and other HTTP-based MCP clients
 * 
 * @param server - The MCP server instance to attach transport to
 * @param port - HTTP port to listen on (default: 3000)
 */
export async function createHttpTransport(
  server: McpServer,
  port: number = 3000
): Promise<void> {
  const app = express();

  // Enable CORS for cross-origin requests (e.g., from Postman)
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });

  // Parse JSON bodies
  app.use(express.json());

  // Health check endpoint
  app.get("/health", (req: Request, res: Response) => {
    res.json({ 
      status: "healthy", 
      service: "jira-mcp",
      transport: "http-sse",
      timestamp: new Date().toISOString()
    });
  });

  // SSE endpoint - This is where MCP clients connect
  app.get("/sse", async (req: Request, res: Response) => {
    console.log("New SSE connection established");
    
    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    
    const transport = new SSEServerTransport("/message", res);
    await server.connect(transport);

    // Handle client disconnect
    req.on("close", () => {
      console.log("SSE connection closed");
    });
  });

  // Message endpoint - Receives messages from MCP clients
  app.post("/message", async (req: Request, res: Response) => {
    try {
      // The SSE transport handles the actual message processing
      // This endpoint just needs to acknowledge receipt
      res.status(202).json({ accepted: true });
    } catch (error) {
      console.error("Error handling message:", error);
      res.status(500).json({ 
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Start HTTP server
  app.listen(port, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║  🚀 JIRA MCP Server - HTTP Transport Mode                 ║
╠════════════════════════════════════════════════════════════╣
║  SSE Endpoint:    http://localhost:${port}/sse             ║
║  Message Endpoint: http://localhost:${port}/message        ║
║  Health Check:    http://localhost:${port}/health          ║
║                                                            ║
║  📝 Postman MCP Configuration:                             ║
║     URL: http://localhost:${port}/sse                      ║
║     Method: GET                                            ║
╚════════════════════════════════════════════════════════════╝
    `);
  });
}
