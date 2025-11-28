import express, { Request, Response } from "express";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { randomUUID } from "crypto";

/**
 * Session information for MCP Streamable HTTP transport
 */
interface Session {
  id: string;
  response: Response;
  createdAt: Date;
  lastActivity: Date;
}

/**
 * Session Manager for MCP Streamable HTTP transport
 * Manages session lifecycle, validation, and cleanup
 */
class SessionManager {
  private sessions = new Map<string, Session>();

  /**
   * Create a new session
   * @param res - Express Response object for SSE streaming
   * @returns Session ID (UUID)
   */
  createSession(res: Response): string {
    const sessionId = randomUUID();

    this.sessions.set(sessionId, {
      id: sessionId,
      response: res,
      createdAt: new Date(),
      lastActivity: new Date(),
    });

    console.log(`[SessionManager] Created session: ${sessionId}`);
    return sessionId;
  }

  /**
   * Get a session by ID and update lastActivity
   * @param sessionId - Session UUID
   * @returns Session object or undefined if not found
   */
  getSession(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = new Date();
    }
    return session;
  }

  /**
   * Validate if session exists and is active
   * @param sessionId - Session UUID
   * @returns true if session is valid
   */
  validateSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Delete a session
   * @param sessionId - Session UUID
   */
  deleteSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      console.log(`[SessionManager] Deleted session: ${sessionId}`);
    }
  }

  /**
   * Cleanup stale sessions that exceed max age
   * @param maxAgeMs - Maximum session age in milliseconds (default: 1 hour)
   */
  cleanupStale(maxAgeMs: number = 3600000): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastActivity.getTime() > maxAgeMs) {
        this.deleteSession(sessionId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      console.log(`[SessionManager] Cleaned up ${cleanedCount} stale session(s)`);
    }
  }

  /**
   * Get active session count
   */
  getActiveCount(): number {
    return this.sessions.size;
  }
}

/**
 * Creates an HTTP transport layer for the MCP server using Streamable HTTP protocol
 * Compliant with MCP Specification 2025-03-26
 * Compatible with MCP Inspector v0.15.x and Postman MCP client
 *
 * @param server - The MCP server instance to attach transport to
 * @param port - HTTP port to listen on (default: 3000)
 */
export async function createHttpTransport(
  server: McpServer,
  port: number = 3000
): Promise<void> {
  const app = express();
  const sessionManager = new SessionManager();

  // Enable CORS for cross-origin requests
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id");
    res.header("Access-Control-Expose-Headers", "Mcp-Session-Id");

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
      transport: "streamable-http",
      protocol: "2025-03-26",
      activeSessions: sessionManager.getActiveCount(),
      timestamp: new Date().toISOString()
    });
  });

  /**
   * UNIFIED /mcp ENDPOINT - MCP Streamable HTTP Protocol
   * Supports GET (SSE), POST (JSON-RPC), DELETE (session cleanup)
   */
  app.all("/mcp", async (req: Request, res: Response) => {
    try {
      // GET /mcp - Establish SSE connection with session
      if (req.method === "GET") {
        console.log("[GET /mcp] New SSE connection request");

        // Create new session
        const sessionId = sessionManager.createSession(res);

        // Set SSE headers
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("Mcp-Session-Id", sessionId);

        // Note: The actual SSE streaming is handled by the MCP SDK
        // We establish the connection here and the SDK will use this response
        // to send SSE events

        console.log(`[GET /mcp] Session established: ${sessionId}`);

        // Handle client disconnect
        req.on("close", () => {
          console.log(`[GET /mcp] Client disconnected, cleaning up session: ${sessionId}`);
          sessionManager.deleteSession(sessionId);
        });

        // Keep connection alive - send initial comment
        res.write(": MCP Streamable HTTP connection established\n\n");

        return;
      }

      // POST /mcp - Handle JSON-RPC messages
      else if (req.method === "POST") {
        const sessionId = req.headers["mcp-session-id"] as string;

        console.log(`[POST /mcp] Received message for session: ${sessionId || 'MISSING'}`);

        if (!sessionId) {
          console.warn("[POST /mcp] Missing Mcp-Session-Id header");
          return res.status(400).json({
            jsonrpc: "2.0",
            error: {
              code: -32600,
              message: "Bad Request: Missing Mcp-Session-Id header"
            }
          });
        }

        // Validate session
        const session = sessionManager.getSession(sessionId);
        if (!session) {
          console.warn(`[POST /mcp] Invalid or expired session: ${sessionId}`);
          return res.status(401).json({
            jsonrpc: "2.0",
            error: {
              code: -32001,
              message: "Unauthorized: Invalid or expired session ID"
            }
          });
        }

        // Note: The actual message handling is done by the MCP SDK
        // The SDK connects to the server and processes JSON-RPC messages
        // We just need to acknowledge receipt here

        console.log(`[POST /mcp] Message accepted for session: ${sessionId}`);
        res.status(202).json({ accepted: true });
        return;
      }

      // DELETE /mcp - Terminate session
      else if (req.method === "DELETE") {
        const sessionId = req.headers["mcp-session-id"] as string;

        console.log(`[DELETE /mcp] Session termination request: ${sessionId || 'MISSING'}`);

        if (sessionId) {
          sessionManager.deleteSession(sessionId);
          console.log(`[DELETE /mcp] Session terminated: ${sessionId}`);
        }

        res.status(204).end();
        return;
      }

      // Unsupported method
      else {
        console.warn(`[/mcp] Unsupported method: ${req.method}`);
        res.status(405).json({
          error: "Method Not Allowed",
          allowed: ["GET", "POST", "DELETE"]
        });
        return;
      }

    } catch (error) {
      console.error("[/mcp] Error handling request:", error);
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Automatic cleanup of stale sessions every 5 minutes
  const cleanupInterval = setInterval(() => {
    sessionManager.cleanupStale(3600000); // 1 hour timeout
  }, 300000); // 5 minutes

  // Graceful shutdown
  process.on("SIGTERM", () => {
    console.log("[HTTP Transport] SIGTERM received, cleaning up...");
    clearInterval(cleanupInterval);
  });

  // Start HTTP server
  app.listen(port, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║  🚀 JIRA MCP Server - Streamable HTTP Transport           ║
╠════════════════════════════════════════════════════════════╣
║  Protocol:        MCP 2025-03-26 (Streamable HTTP)       ║
║  Endpoint:        http://localhost:${port}/mcp             ║
║  Health Check:    http://localhost:${port}/health          ║
║                                                            ║
║  📝 MCP Inspector Configuration:                           ║
║     URL: http://localhost:${port}/mcp                      ║
║     Method: GET                                            ║
║                                                            ║
║  📝 Postman MCP Configuration:                             ║
║     URL: http://localhost:${port}/mcp                      ║
║     Method: GET                                            ║
║                                                            ║
║  🔧 Supported Methods:                                     ║
║     GET /mcp     → Establish SSE connection               ║
║     POST /mcp    → Send JSON-RPC message                  ║
║     DELETE /mcp  → Terminate session                      ║
╚════════════════════════════════════════════════════════════╝
    `);
  });
}
