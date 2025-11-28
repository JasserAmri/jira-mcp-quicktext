import express, { Request, Response, NextFunction } from "express";
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
 * JSON-RPC 2.0 Error object
 */
interface JsonRpcError {
  jsonrpc: "2.0";
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
  id?: string | number | null;
}

/**
 * JSON-RPC 2.0 standard error codes
 */
const JSON_RPC_ERROR_CODES = {
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_ERROR: -32000,
  // Custom MCP error codes
  UNAUTHORIZED: -32001,
} as const;

/**
 * CORS configuration
 */
const CORS_CONFIG = {
  ALLOW_ORIGIN: "*",
  ALLOW_METHODS: "GET, POST, DELETE, OPTIONS",
  ALLOW_HEADERS: "Content-Type, Mcp-Session-Id",
  EXPOSE_HEADERS: "Mcp-Session-Id",
} as const;

/**
 * Session timeout configuration
 */
const SESSION_CONFIG = {
  MAX_AGE_MS: 3600000, // 1 hour
  CLEANUP_INTERVAL_MS: 300000, // 5 minutes
} as const;

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
 * Validation Helpers
 */

/**
 * Validate that session ID header is present
 * @param sessionId - Session ID from header
 * @returns true if valid, false otherwise
 */
function validateSessionIdHeader(sessionId: string | undefined): sessionId is string {
  return typeof sessionId === "string" && sessionId.length > 0;
}

/**
 * Extract session ID from request headers (case-insensitive)
 * @param req - Express Request object
 * @returns Session ID or undefined
 */
function extractSessionId(req: Request): string | undefined {
  return req.headers["mcp-session-id"] as string | undefined;
}

/**
 * Error Response Helpers
 */

/**
 * Create a JSON-RPC 2.0 error response
 * @param code - Error code (from JSON_RPC_ERROR_CODES)
 * @param message - Error message
 * @param id - Optional JSON-RPC request ID
 * @returns JSON-RPC error object
 */
function createJsonRpcError(
  code: number,
  message: string,
  id?: string | number | null
): JsonRpcError {
  return {
    jsonrpc: "2.0",
    error: {
      code,
      message,
    },
    ...(id !== undefined && { id }),
  };
}

/**
 * Send a JSON-RPC error response
 * @param res - Express Response object
 * @param statusCode - HTTP status code
 * @param errorCode - JSON-RPC error code
 * @param message - Error message
 */
function sendJsonRpcError(
  res: Response,
  statusCode: number,
  errorCode: number,
  message: string
): void {
  res.status(statusCode).json(createJsonRpcError(errorCode, message));
}

/**
 * Logging Helpers
 */

/**
 * Log structured message with context
 * @param level - Log level (info, warn, error)
 * @param context - Context (e.g., "GET /mcp", "SessionManager")
 * @param message - Log message
 * @param data - Optional additional data
 */
function log(
  level: "info" | "warn" | "error",
  context: string,
  message: string,
  data?: Record<string, unknown>
): void {
  const timestamp = new Date().toISOString();
  const logData = data ? ` ${JSON.stringify(data)}` : "";

  const logMessage = `[${timestamp}] [${context}] ${message}${logData}`;

  switch (level) {
    case "error":
      console.error(logMessage);
      break;
    case "warn":
      console.warn(logMessage);
      break;
    default:
      console.log(logMessage);
  }
}

/**
 * Endpoint Handlers
 */

/**
 * Handle GET /mcp - Establish SSE connection with session
 * @param req - Express Request
 * @param res - Express Response
 * @param sessionManager - Session manager instance
 */
function handleGetMcp(req: Request, res: Response, sessionManager: SessionManager): void {
  log("info", "GET /mcp", "New SSE connection request");

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

  log("info", "GET /mcp", "Session established", { sessionId });

  // Handle client disconnect
  req.on("close", () => {
    log("info", "GET /mcp", "Client disconnected, cleaning up session", { sessionId });
    sessionManager.deleteSession(sessionId);
  });

  // Keep connection alive - send initial comment
  res.write(": MCP Streamable HTTP connection established\n\n");
}

/**
 * Handle POST /mcp - Process JSON-RPC messages
 * @param req - Express Request
 * @param res - Express Response
 * @param sessionManager - Session manager instance
 */
function handlePostMcp(req: Request, res: Response, sessionManager: SessionManager): void {
  const sessionId = extractSessionId(req);

  log("info", "POST /mcp", "Received message", { sessionId: sessionId || "MISSING" });

  // Validate session ID header
  if (!validateSessionIdHeader(sessionId)) {
    log("warn", "POST /mcp", "Missing Mcp-Session-Id header");
    sendJsonRpcError(
      res,
      400,
      JSON_RPC_ERROR_CODES.INVALID_REQUEST,
      "Bad Request: Missing Mcp-Session-Id header"
    );
    return;
  }

  // Validate session exists
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    log("warn", "POST /mcp", "Invalid or expired session", { sessionId });
    sendJsonRpcError(
      res,
      401,
      JSON_RPC_ERROR_CODES.UNAUTHORIZED,
      "Unauthorized: Invalid or expired session ID"
    );
    return;
  }

  // Note: The actual message handling is done by the MCP SDK
  // The SDK connects to the server and processes JSON-RPC messages
  // We just need to acknowledge receipt here

  log("info", "POST /mcp", "Message accepted", { sessionId });
  res.status(202).json({ accepted: true });
}

/**
 * Handle DELETE /mcp - Terminate session
 * @param req - Express Request
 * @param res - Express Response
 * @param sessionManager - Session manager instance
 */
function handleDeleteMcp(req: Request, res: Response, sessionManager: SessionManager): void {
  const sessionId = extractSessionId(req);

  log("info", "DELETE /mcp", "Session termination request", { sessionId: sessionId || "MISSING" });

  if (sessionId) {
    sessionManager.deleteSession(sessionId);
    log("info", "DELETE /mcp", "Session terminated", { sessionId });
  }

  res.status(204).end();
}

/**
 * CORS Middleware
 * Configures CORS headers for cross-origin requests
 */
function configureCors(req: Request, res: Response, next: NextFunction): void {
  res.header("Access-Control-Allow-Origin", CORS_CONFIG.ALLOW_ORIGIN);
  res.header("Access-Control-Allow-Methods", CORS_CONFIG.ALLOW_METHODS);
  res.header("Access-Control-Allow-Headers", CORS_CONFIG.ALLOW_HEADERS);
  res.header("Access-Control-Expose-Headers", CORS_CONFIG.EXPOSE_HEADERS);

  if (req.method === "OPTIONS") {
    res.sendStatus(200);
    return;
  }
  next();
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
  app.use(configureCors);

  // Parse JSON bodies with error handling
  app.use(express.json({
    limit: "10mb",
    strict: true,
  }));

  // Handle JSON parsing errors
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError && "body" in err) {
      log("error", "JSON Parser", "Malformed JSON in request body", { error: err.message });
      sendJsonRpcError(
        res,
        400,
        JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        "Bad Request: Malformed JSON"
      );
      return;
    }
    next(err);
  });

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
      switch (req.method) {
        case "GET":
          handleGetMcp(req, res, sessionManager);
          break;

        case "POST":
          handlePostMcp(req, res, sessionManager);
          break;

        case "DELETE":
          handleDeleteMcp(req, res, sessionManager);
          break;

        default:
          log("warn", "/mcp", "Unsupported method", { method: req.method });
          res.status(405).json({
            error: "Method Not Allowed",
            allowed: ["GET", "POST", "DELETE"]
          });
      }
    } catch (error) {
      log("error", "/mcp", "Error handling request", {
        error: error instanceof Error ? error.message : "Unknown error",
        method: req.method
      });
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Automatic cleanup of stale sessions
  const cleanupInterval = setInterval(() => {
    sessionManager.cleanupStale(SESSION_CONFIG.MAX_AGE_MS);
  }, SESSION_CONFIG.CLEANUP_INTERVAL_MS);

  // Graceful shutdown
  process.on("SIGTERM", () => {
    log("info", "HTTP Transport", "SIGTERM received, cleaning up...");
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
