import express, { Request, Response } from "express";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

/**
 * Creates an HTTP transport layer for the MCP server using SSE (Server-Sent Events)
 * Compatible with MCP Inspector and standard MCP clients
 *
 * @param server - The MCP server instance to attach transport to
 * @param port - HTTP port to listen on (default: 3000)
 */
export async function createHttpTransport(
  server: McpServer,
  port: number = 3000
): Promise<void> {
  const app = express();

  // Enable CORS for cross-origin requests
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
      transport: "sse",
      timestamp: new Date().toISOString()
    });
  });

  /**
   * Main MCP endpoint using SSE transport from SDK
   */
  app.get("/sse", async (req: Request, res: Response) => {
    console.log("[SSE] New connection established");

    const transport = new SSEServerTransport("/messages", res);
    
    await server.connect(transport);
    
    console.log("[SSE] MCP server connected via SSE transport");
  });

  /**
   * Message endpoint for POST requests
   */
  app.post("/messages", async (req: Request, res: Response) => {
    console.log("[POST /messages] Received message");
    
    // The SSE transport handles this automatically
    // Just acknowledge receipt
    res.status(200).send("OK");
  });

  // Start HTTP server
  app.listen(port, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║  🚀 JIRA MCP Server - SSE Transport                       ║
╠════════════════════════════════════════════════════════════╣
║  Protocol:        MCP with SSE                            ║
║  Endpoint:        http://localhost:${port}/sse              ║
║  Messages:        http://localhost:${port}/messages         ║
║  Health Check:    http://localhost:${port}/health           ║
║                                                            ║
║  📝 MCP Inspector Configuration:                           ║
║     Transport: SSE                                         ║
║     URL: http://localhost:${port}/sse                       ║
║                                                            ║
║  🔧 Endpoints:                                             ║
║     GET  /sse      → Establish SSE connection             ║
║     POST /messages → Send JSON-RPC message                ║
║     GET  /health   → Health check                         ║
╚════════════════════════════════════════════════════════════╝
    `);
  });
}
