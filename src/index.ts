#!/usr/bin/env node

/**
 * QuickText Jira + Confluence MCP Server v5.0.0
 * Enhanced with MCP Best Practices + Phase 2 Discovery Suite
 *
 * Production Features:
 * ✅ Vendor Prefix: quinta-jira_ (53 tools) + quinta-confluence_ (16 tools)
 * ✅ Enhanced Descriptions: Comprehensive tool documentation with examples
 * ✅ Structured Errors: Machine-readable error codes (JIRA_1xxx-5xxx, CONF_1xxx-5xxx)
 * ✅ Tool Count: 69 tools total (53 Jira + 16 Confluence)
 * ✅ Structured Outputs: JSON schemas with validation
 * ✅ Jira Agile API: Uses /rest/agile/1.0/ for board/sprint discovery
 * ✅ Data Center Compatible: Tested on Jira v9.4.5
 * ✅ Confluence Server: Supports Confluence Server 7.9+ (REST API v1)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { PDFParse } from "pdf-parse";
import { extractRawText as extractDocxRawText } from "mammoth";
import ExcelJS from "exceljs";

// Jira configuration — read from environment variables (set via .env or MCP client config)
const JIRA_BASE_URL = (process.env.JIRA_BASE_URL ?? '').replace(/\/$/, '');
const JIRA_PAT = process.env.JIRA_API_TOKEN ?? '';
const JIRA_AUTH_TYPE = (process.env.JIRA_AUTH_TYPE ?? 'bearer').toLowerCase();
const JIRA_USER_EMAIL = process.env.JIRA_USER_EMAIL ?? '';

// Confluence configuration (optional — tools are disabled if not set)
const CONFLUENCE_BASE_URL = (process.env.CONFLUENCE_BASE_URL ?? '').replace(/\/$/, '');
const CONFLUENCE_API_TOKEN = process.env.CONFLUENCE_API_TOKEN ?? '';
const CONFLUENCE_AUTH_TYPE = (process.env.CONFLUENCE_AUTH_TYPE ?? 'bearer').toLowerCase();
const CONFLUENCE_USER_EMAIL = process.env.CONFLUENCE_USER_EMAIL ?? '';
const confluenceEnabled = Boolean(CONFLUENCE_BASE_URL && CONFLUENCE_API_TOKEN);

// Network timeout for all upstream requests (configurable)
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) > 0
  ? Number(process.env.REQUEST_TIMEOUT_MS)
  : 30000;

if (!JIRA_BASE_URL || !JIRA_PAT) {
  console.error('ERROR: Missing required environment variables.');
  console.error('  JIRA_BASE_URL and JIRA_API_TOKEN must be set.');
  console.error('  Copy .env.example to .env and fill in your values,');
  console.error('  or set them in your MCP client configuration (claude_desktop_config.json).');
  process.exit(1);
}

// Basic auth requires a user email to form the Basic credential
if (JIRA_AUTH_TYPE === 'basic' && !JIRA_USER_EMAIL) {
  console.error('ERROR: JIRA_USER_EMAIL is required when JIRA_AUTH_TYPE=basic.');
  process.exit(1);
}
if (confluenceEnabled && CONFLUENCE_AUTH_TYPE === 'basic' && !CONFLUENCE_USER_EMAIL) {
  console.error('ERROR: CONFLUENCE_USER_EMAIL is required when CONFLUENCE_AUTH_TYPE=basic.');
  process.exit(1);
}
if (JIRA_AUTH_TYPE !== 'basic' && JIRA_AUTH_TYPE !== 'bearer') {
  console.error(`WARNING: unknown JIRA_AUTH_TYPE "${JIRA_AUTH_TYPE}"; expected "bearer" or "basic". Falling back to bearer.`);
}

// Error codes (JIRA_1xxx-5xxx)
const ErrorCodes = {
  // 1xxx: Authentication/Authorization
  UNAUTHORIZED: "JIRA_1001",
  FORBIDDEN: "JIRA_1002",
  INVALID_TOKEN: "JIRA_1003",
  
  // 2xxx: Input Validation
  INVALID_PARAMETER: "JIRA_2001",
  MISSING_REQUIRED_FIELD: "JIRA_2002",
  INVALID_JQL: "JIRA_2003",
  
  // 3xxx: Resource Errors
  ISSUE_NOT_FOUND: "JIRA_3001",
  PROJECT_NOT_FOUND: "JIRA_3002",
  SPRINT_NOT_FOUND: "JIRA_3003",
  
  // 4xxx: Rate Limiting
  RATE_LIMIT_EXCEEDED: "JIRA_4001",
  QUOTA_EXCEEDED: "JIRA_4002",
  
  // 5xxx: Server/Network
  JIRA_API_ERROR: "JIRA_5001",
  NETWORK_ERROR: "JIRA_5002",
  TIMEOUT: "JIRA_5003",
};

// Confluence error codes (CONF_1xxx-5xxx)
const ConfluenceErrorCodes = {
  UNAUTHORIZED:      "CONF_1001",
  FORBIDDEN:         "CONF_1002",
  INVALID_PARAMETER: "CONF_2001",
  MISSING_REQUIRED:  "CONF_2002",
  PAGE_NOT_FOUND:    "CONF_3001",
  SPACE_NOT_FOUND:   "CONF_3002",
  RATE_LIMIT:        "CONF_4001",
  API_ERROR:         "CONF_5001",
  NETWORK_ERROR:     "CONF_5002",
  NOT_CONFIGURED:    "CONF_5003",
};

// Rate limit tracking
let rateLimitInfo: { remaining: number | null; limit: number | null; reset: string | null } = {
  remaining: null,
  limit: null,
  reset: null,
};

// Auth header builders (single source of truth — used by jiraRequest/confluenceRequest)
function jiraAuthHeader(): string {
  return JIRA_AUTH_TYPE === 'basic'
    ? `Basic ${Buffer.from(`${JIRA_USER_EMAIL}:${JIRA_PAT}`).toString('base64')}`
    : `Bearer ${JIRA_PAT}`;
}
function confluenceAuthHeader(): string {
  return CONFLUENCE_AUTH_TYPE === 'basic'
    ? `Basic ${Buffer.from(`${CONFLUENCE_USER_EMAIL}:${CONFLUENCE_API_TOKEN}`).toString('base64')}`
    : `Bearer ${CONFLUENCE_API_TOKEN}`;
}

// Escape a user-supplied value before interpolating it into a quoted JQL/CQL string literal.
// Prevents query breakout on values containing backslashes or double quotes.
function escapeJqlValue(value: string): string {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
const escapeCqlValue = escapeJqlValue;

// Shared MIME constants for attachment rendering (single source of truth)
const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"];
const TEXT_MIME_PREFIXES = ["text/"];
const TEXT_MIME_EXACT = ["application/json", "application/xml"];
const TEXT_SIZE_LIMIT = 500 * 1024;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DISABLE_ATTACHMENT_TEXT_EXTRACTION = /^(1|true)$/i.test(process.env.DISABLE_ATTACHMENT_TEXT_EXTRACTION ?? "");

// MIME type by file extension, used when uploading an attachment (file_path/source_url
// modes have no browser-supplied Content-Type to fall back on).
const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": DOCX_MIME,
  ".xls": "application/vnd.ms-excel",
  ".xlsx": XLSX_MIME,
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain", ".csv": "text/csv", ".md": "text/markdown",
  ".json": "application/json", ".xml": "application/xml", ".html": "text/html", ".htm": "text/html",
  ".zip": "application/zip", ".rar": "application/vnd.rar", ".7z": "application/x-7z-compressed",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".log": "text/plain",
};
function guessMimeType(filename: string): string {
  return MIME_BY_EXTENSION[extname(filename).toLowerCase()] || "application/octet-stream";
}

// Cap for file_path/source_url attachment uploads, to avoid reading or
// downloading unbounded amounts of data into memory. Configurable via env.
const ATTACHMENT_UPLOAD_MAX_BYTES = (() => {
  const mb = Number(process.env.ATTACHMENT_MAX_UPLOAD_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 100) * 1024 * 1024;
})();

// Derive a filename from the last path/URL segment (used when the caller
// omits `filename` alongside file_path/source_url).
function inferFilenameFromPathOrUrl(pathOrUrl: string): string {
  try {
    const asUrl = new URL(pathOrUrl);
    return basename(asUrl.pathname) || "attachment";
  } catch {
    return basename(pathOrUrl) || "attachment";
  }
}

// Strip characters that would let a filename break out of the quoted
// Content-Disposition header value (CR/LF header injection, embedded quotes).
function sanitizeAttachmentFilename(name: string): string {
  const base = basename(String(name).replace(/[\r\n]/g, "").trim());
  const cleaned = base.replace(/"/g, "'");
  return cleaned || "attachment";
}

// Best-effort text extraction for common office document formats, so Claude can
// read attachment contents instead of only seeing an opaque base64 blob.
// Returns null (falls back to base64) when the MIME type is unsupported, the
// feature is disabled via DISABLE_ATTACHMENT_TEXT_EXTRACTION, or parsing fails.
async function extractAttachmentText(buffer: Buffer, mimeType: string): Promise<string | null> {
  if (DISABLE_ATTACHMENT_TEXT_EXTRACTION) return null;
  try {
    if (mimeType === "application/pdf") {
      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText();
        return result.text;
      } finally {
        await parser.destroy();
      }
    }
    if (mimeType === DOCX_MIME) {
      const result = await extractDocxRawText({ buffer });
      return result.value;
    }
    if (mimeType === XLSX_MIME) {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as any);
      const sheets: string[] = [];
      workbook.eachSheet((sheet) => {
        const rows: string[] = [];
        sheet.eachRow((row) => {
          const cells = (row.values as any[]).slice(1).map(v => (v == null ? "" : String(v)));
          rows.push(cells.join(","));
        });
        sheets.push(`--- Sheet: ${sheet.name} ---\n${rows.join("\n")}`);
      });
      return sheets.join("\n\n");
    }
  } catch (error: any) {
    return null;
  }
  return null;
}

// Jira issue key shape, e.g. QT-123 (used to validate before interpolating into URLs)
const ISSUE_KEY_RE = /^[A-Za-z][A-Za-z0-9_]+-\d+$/;
function isValidIssueKey(key: any): boolean {
  return typeof key === "string" && ISSUE_KEY_RE.test(key);
}

// Create server
const server = new Server(
  {
    name: "jira-confluence-quicktext",
    version: "5.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Structured error helper
function createError(code: string, message: string, details: Record<string, any> = {}, suggestedAction: string | null = null) {
  return {
    error_code: code,
    error_message: message,
    details,
    suggested_action: suggestedAction,
    timestamp: new Date().toISOString(),
  };
}

// Consume (or cancel) a fetch Response's body before discarding the Response.
// Node's built-in fetch (undici) is spec-required to have its body consumed or
// explicitly cancelled; throwing away a Response without reading the body is a
// resource-leak risk regardless of Node version/request pattern. Call this
// before throwing/returning from a branch that doesn't otherwise read the body.
async function drainResponseBody(response: Response): Promise<void> {
  try {
    if (response.body && !response.bodyUsed) {
      await response.body.cancel();
    }
  } catch {
    // Best-effort cleanup only — never let draining failures mask the real error.
  }
}

// Jira API helper with rate limit tracking and error handling
async function jiraRequest(endpoint: string, options: any = {}): Promise<any> {
  const url = `${JIRA_BASE_URL}${endpoint}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: ctrl.signal,
      headers: {
        "Authorization": jiraAuthHeader(),
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...options.headers,
      },
    });

    // Track rate limits (ignore non-numeric/absent headers)
    if (response.headers.has("X-RateLimit-Remaining")) {
      const n = parseInt(response.headers.get("X-RateLimit-Remaining") ?? "", 10);
      if (Number.isFinite(n)) rateLimitInfo.remaining = n;
    }
    if (response.headers.has("X-RateLimit-Limit")) {
      const n = parseInt(response.headers.get("X-RateLimit-Limit") ?? "", 10);
      if (Number.isFinite(n)) rateLimitInfo.limit = n;
    }
    if (response.headers.has("X-RateLimit-Reset")) {
      rateLimitInfo.reset = response.headers.get("X-RateLimit-Reset");
    }

    if (!response.ok) {
      if (response.status === 401) {
        throw createError(
          ErrorCodes.UNAUTHORIZED,
          "Authentication failed",
          { status: response.status },
          "Verify JIRA_PAT token is valid and not expired"
        );
      } else if (response.status === 403) {
        throw createError(
          ErrorCodes.FORBIDDEN,
          "Permission denied",
          { status: response.status },
          "Check user permissions for this resource"
        );
      } else if (response.status === 404) {
        // Map 404 to the most specific resource error based on the endpoint
        const notFoundCode = /\/project/.test(endpoint)
          ? ErrorCodes.PROJECT_NOT_FOUND
          : /\/(sprint|board)/.test(endpoint)
            ? ErrorCodes.SPRINT_NOT_FOUND
            : ErrorCodes.ISSUE_NOT_FOUND;
        throw createError(
          notFoundCode,
          "Resource not found",
          { status: response.status, endpoint },
          "Verify issue key, project key, or sprint/board id is correct"
        );
      } else if (response.status === 429) {
        throw createError(
          ErrorCodes.RATE_LIMIT_EXCEEDED,
          "Rate limit exceeded",
          { status: response.status, rate_limit: rateLimitInfo, retry_after: response.headers.get("Retry-After") },
          "Wait before retrying. Check the Retry-After / X-RateLimit-Reset header"
        );
      } else {
        // Capture the raw error body for diagnosis
        let errorBody: any = null;
        try {
          const errText = await response.text();
          errorBody = errText ? JSON.parse(errText) : null;
        } catch (_) { /* ignore parse errors */ }
        throw createError(
          ErrorCodes.JIRA_API_ERROR,
          `Jira API error: ${response.status} ${response.statusText}`,
          { status: response.status, endpoint, response_body: errorBody }
        );
      }
    }

    // Handle empty responses (e.g. Jira 204 No Content on transitions)
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (_) {
      // A 200 with a non-JSON body usually means an SSO/proxy login page was returned
      throw createError(
        ErrorCodes.JIRA_API_ERROR,
        "Expected JSON but received a non-JSON response (possible SSO/proxy login page)",
        {
          status: response.status,
          endpoint,
          content_type: response.headers.get("Content-Type"),
          body_preview: text.slice(0, 200),
        },
        "Verify JIRA_BASE_URL points directly at the API and the PAT bypasses any SSO portal"
      );
    }
  } catch (error: any) {
    if (error.error_code) {
      throw error; // Already a structured error
    }
    if (error.name === "AbortError") {
      throw createError(
        ErrorCodes.TIMEOUT,
        `Request timed out after ${REQUEST_TIMEOUT_MS}ms`,
        { endpoint, timeout_ms: REQUEST_TIMEOUT_MS },
        "Increase REQUEST_TIMEOUT_MS or check Jira server responsiveness"
      );
    }
    throw createError(
      ErrorCodes.NETWORK_ERROR,
      `Network error: ${error.message}`,
      { endpoint, original_error: error.message },
      "Check network connectivity and Jira server status"
    );
  } finally {
    clearTimeout(timer);
  }
}

// Confluence API helper — mirrors jiraRequest() pattern
async function confluenceRequest(endpoint: string, options: any = {}): Promise<any> {
  if (!confluenceEnabled) {
    throw createError(
      ConfluenceErrorCodes.NOT_CONFIGURED,
      "Confluence not configured. Set CONFLUENCE_BASE_URL and CONFLUENCE_API_TOKEN environment variables.",
      {},
      "Add CONFLUENCE_BASE_URL and CONFLUENCE_API_TOKEN to your environment or MCP config"
    );
  }

  const url = `${CONFLUENCE_BASE_URL}${endpoint}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: ctrl.signal,
      headers: {
        "Authorization": confluenceAuthHeader(),
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      let errorBody: any = null;
      try {
        const errText = await response.text();
        errorBody = errText ? JSON.parse(errText) : null;
      } catch (_) { /* ignore */ }

      if (response.status === 401) {
        throw createError(ConfluenceErrorCodes.UNAUTHORIZED, "Confluence authentication failed", { status: 401 }, "Verify CONFLUENCE_API_TOKEN is valid and not expired");
      } else if (response.status === 403) {
        throw createError(ConfluenceErrorCodes.FORBIDDEN, "Confluence permission denied", { status: 403 }, "Check user permissions for this space or page");
      } else if (response.status === 404) {
        throw createError(ConfluenceErrorCodes.PAGE_NOT_FOUND, "Confluence resource not found", { status: 404, endpoint }, "Verify the page ID, space key, or URL is correct");
      } else if (response.status === 409) {
        throw createError(ConfluenceErrorCodes.API_ERROR, "Version conflict: the page was updated since you fetched it", { status: 409 }, "Fetch the page again with quinta-confluence_get_page to get the latest version number, then retry");
      } else if (response.status === 429) {
        throw createError(ConfluenceErrorCodes.RATE_LIMIT, "Confluence rate limit exceeded", { status: 429, retry_after: response.headers.get("Retry-After") }, "Wait before retrying");
      } else {
        throw createError(ConfluenceErrorCodes.API_ERROR, `Confluence API error: ${response.status} ${response.statusText}`, { status: response.status, endpoint, response_body: errorBody });
      }
    }

    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (_) {
      throw createError(
        ConfluenceErrorCodes.API_ERROR,
        "Expected JSON but received a non-JSON response (possible SSO/proxy login page)",
        { status: response.status, endpoint, content_type: response.headers.get("Content-Type"), body_preview: text.slice(0, 200) },
        "Verify CONFLUENCE_BASE_URL points directly at the API and the token bypasses any SSO portal"
      );
    }
  } catch (error: any) {
    if (error.error_code) throw error;
    if (error.name === "AbortError") {
      throw createError(ConfluenceErrorCodes.NETWORK_ERROR, `Confluence request timed out after ${REQUEST_TIMEOUT_MS}ms`, { endpoint, timeout_ms: REQUEST_TIMEOUT_MS }, "Increase REQUEST_TIMEOUT_MS or check Confluence server responsiveness");
    }
    throw createError(ConfluenceErrorCodes.NETWORK_ERROR, `Network error: ${error.message}`, { endpoint, original_error: error.message }, "Check network connectivity and Confluence server status");
  } finally {
    clearTimeout(timer);
  }
}

// Fetch ALL issues matching a JQL query by paginating /rest/api/2/search.
// Bounded by hardCap to avoid runaway cost on very large result sets.
// Returns the gathered issues, the server-reported total, and whether the
// gathered set is incomplete (hardCap reached before all pages fetched).
async function searchAllIssues(
  jql: string,
  fields: string,
  opts: { hardCap?: number; pageSize?: number; expand?: string } = {}
): Promise<{ issues: any[]; total: number; truncated: boolean }> {
  const hardCap = opts.hardCap ?? 5000;
  const pageSize = Math.min(opts.pageSize ?? 100, 100);
  const expandParam = opts.expand ? `&expand=${encodeURIComponent(opts.expand)}` : "";
  let startAt = 0;
  let total = 0;
  const issues: any[] = [];
  // Hard ceiling on iterations as a belt-and-suspenders guard against a server
  // that never advances (page.length === 0 also breaks the loop).
  for (let i = 0; i < 1000; i++) {
    const data = await jiraRequest(
      `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=${pageSize}&startAt=${startAt}&fields=${fields}${expandParam}`
    );
    total = data.total ?? 0;
    const page = data.issues ?? [];
    issues.push(...page);
    startAt += page.length;
    if (page.length === 0 || startAt >= total || issues.length >= hardCap) break;
  }
  return { issues, total, truncated: issues.length < total };
}

// Strip XHTML tags from Confluence storage format to get plain text
function extractConfluenceText(storageValue: string): string {
  return storageValue.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

// Wrap plain text as Confluence storage format
function toConfluenceStorage(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<p>${escaped}</p>`;
}

// Helper: Fetch a binary URL (attachment content) with PAT auth
// Returns a Buffer and the Content-Type reported by Jira.
// Throws a structured error if the response is not OK or exceeds maxBytes.
async function fetchAttachmentBinary(url: string, maxBytes: number): Promise<{ buffer: Buffer; contentType: string }> {
  const authHeader = JIRA_AUTH_TYPE === 'basic'
    ? `Basic ${Buffer.from(`${JIRA_USER_EMAIL}:${JIRA_PAT}`).toString('base64')}`
    : `Bearer ${JIRA_PAT}`;

  const response = await fetch(url, {
    headers: { Authorization: authHeader },
  });

  if (!response.ok) {
    await drainResponseBody(response);
    throw createError(
      ErrorCodes.JIRA_API_ERROR,
      `Failed to fetch attachment: HTTP ${response.status}`,
      { status: response.status },
      "Verify the attachment ID is correct and you have permission to view this issue"
    );
  }

  const contentType = response.headers.get("Content-Type") || "application/octet-stream";

  // Honour Content-Length as an early guard before buffering
  const contentLength = response.headers.get("Content-Length");
  if (contentLength && parseInt(contentLength) > maxBytes) {
    await drainResponseBody(response);
    const sizeMb = (parseInt(contentLength) / 1024 / 1024).toFixed(2);
    const maxMb = (maxBytes / 1024 / 1024).toFixed(0);
    throw createError(
      ErrorCodes.INVALID_PARAMETER,
      `File too large to download (${sizeMb} MB). Increase max_size_mb (current: ${maxMb}).`,
      { size_bytes: parseInt(contentLength), max_bytes: maxBytes }
    );
  }

  const buffer = await readBodyWithSizeCap(response, maxBytes);

  return { buffer, contentType };
}

// Read a fetch Response body while enforcing a byte cap, without buffering the
// whole thing first — aborts as soon as the cap is crossed instead of trusting
// (possibly absent or dishonest) Content-Length.
async function readBodyWithSizeCap(response: Response, maxBytes: number): Promise<Buffer> {
  const throwTooLarge = (sizeBytes: number): never => {
    const sizeMb = (sizeBytes / 1024 / 1024).toFixed(2);
    const maxMb = (maxBytes / 1024 / 1024).toFixed(0);
    throw createError(
      ErrorCodes.INVALID_PARAMETER,
      `File too large to download (${sizeMb} MB). Increase max_size_mb (current: ${maxMb}).`,
      { size_bytes: sizeBytes, max_bytes: maxBytes }
    );
  };

  const body = response.body;
  if (!body || typeof (body as any).getReader !== "function") {
    // Fallback for runtimes without a streamable body — still enforce the cap.
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) throwTooLarge(arrayBuffer.byteLength);
    return Buffer.from(arrayBuffer);
  }

  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throwTooLarge(total);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c)), total);
}

// Helper: Parse time logged by role from customfield_10300
function parseTimeLoggedByRole(customfield10300: any) {
  const roles: Record<string, number> = { Developer: 0, Tester: 0, Reviewer: 0 };
  
  if (!customfield10300 || !Array.isArray(customfield10300)) {
    return roles;
  }

  customfield10300.forEach(entry => {
    const roleMatch = entry.match(/Role:\s*(\w+)/);
    if (!roleMatch) return;
    
    const role = roleMatch[1];
    const timeMatch = entry.match(/\((\d+)\(/);
    if (timeMatch) {
      const seconds = parseInt(timeMatch[1]);
      if (roles.hasOwnProperty(role)) {
        roles[role] = seconds;
      }
    }
  });

  return roles;
}

// Helper: Parse assignee roles from customfield_10301
function parseAssigneeRoles(customfield10301: any) {
  const assignments = { dev: null, test: null };
  
  if (!customfield10301 || !Array.isArray(customfield10301)) {
    return assignments;
  }

  customfield10301.forEach(entry => {
    const match = entry.match(/Role:\s*(\d+)\s*\(([^)]*)\)/);
    if (match) {
      const roleId = match[1];
      const username = match[2].trim() || null;
      
      if (roleId === "10105") {  // Developer
        assignments.dev = username;
      } else if (roleId === "10104") {  // Tester
        assignments.test = username;
      }
    }
  });

  return assignments;
}

// Resolve a Jira user token (login name like "mbo" OR a user key like "JIRAUSER10234")
// to a display name. Cached for the process lifetime so repeated keys cost one call.
const userNameCache = new Map<string, string>();
async function resolveUserDisplayName(token: string | null): Promise<string | null> {
  if (!token) return null;
  if (userNameCache.has(token)) return userNameCache.get(token)!;
  // Jira Data Center: keys look like JIRAUSER#####; anything else is treated as a username.
  const qs = /^JIRAUSER\d+$/i.test(token)
    ? `key=${encodeURIComponent(token)}`
    : `username=${encodeURIComponent(token)}`;
  try {
    const u = await jiraRequest(`/rest/api/2/user?${qs}`);
    const name = u?.displayName || token;
    userNameCache.set(token, name); // cache successful resolutions only
    return name;
  } catch (_) {
    return token; // fall back to the raw token; don't cache transient failures
  }
}

// Resolve the dev/test tokens from parseAssigneeRoles() to display names,
// keeping the raw tokens for traceability.
async function resolveAssigneeRoles(customfield10301: any) {
  const raw = parseAssigneeRoles(customfield10301);
  const [dev, test] = await Promise.all([
    resolveUserDisplayName(raw.dev),
    resolveUserDisplayName(raw.test),
  ]);
  return { dev, test, dev_raw: raw.dev, test_raw: raw.test };
}

// Synchronous variant that reads only from the cache (call after pre-warming with
// prewarmRoleNames). Falls back to the raw token if a name isn't cached.
function resolveAssigneeRolesCached(customfield10301: any) {
  const raw = parseAssigneeRoles(customfield10301);
  return {
    dev: raw.dev ? (userNameCache.get(raw.dev) ?? raw.dev) : null,
    test: raw.test ? (userNameCache.get(raw.test) ?? raw.test) : null,
    dev_raw: raw.dev,
    test_raw: raw.test,
  };
}

// Resolve the user token inside each raw customfield_10301 entry
// (e.g. "Role: 10105 (mbo)" -> "Role: 10105 (Malek Boubakri)"), so the raw
// field rendering is consistent with the resolved assignee_roles object.
// Works for any role id, not just dev/test.
async function resolveRoleFieldEntries(cf: any): Promise<any> {
  if (!Array.isArray(cf)) return cf;
  return Promise.all(cf.map(async (entry: any) => {
    if (typeof entry !== "string") return entry;
    const m = entry.match(/\(([^)]*)\)/);
    const token = (m?.[1] ?? "").trim();
    // Skip empty or non-user placeholders (e.g. "()", "null", "null | null")
    if (!token || token === "null" || token.includes("|")) return entry;
    const name = await resolveUserDisplayName(token);
    return name && name !== token ? entry.replace(/\(([^)]*)\)/, `(${name})`) : entry;
  }));
}

// Resolve (and cache) every dev/test token across a set of issues in parallel.
async function prewarmRoleNames(issues: any[]) {
  const tokens = new Set<string>();
  for (const issue of issues) {
    const r = parseAssigneeRoles(issue.fields?.customfield_10301);
    if (r.dev) tokens.add(r.dev as string);
    if (r.test) tokens.add(r.test as string);
  }
  await Promise.all([...tokens].map((t) => resolveUserDisplayName(t)));
}

// Helper: Parse sprint from Jira's Java toString() format
// Format: "com.atlassian.greenhopper.service.sprint.Sprint@xxx[id=304,rapidViewId=4,state=ACTIVE,name=QUIC Sprint 197,startDate=2026-01-27T15:17:00.000Z,endDate=2026-02-10T15:17:00.000Z,...]"
function parseSprint(sprintData: any) {
  if (!sprintData) return null;
  
  // If it's already an object with expected properties, return as-is
  if (typeof sprintData === 'object' && sprintData.name) {
    return {
      id: sprintData.id,
      name: sprintData.name,
      state: sprintData.state,
      startDate: sprintData.startDate,
      endDate: sprintData.endDate,
      goal: sprintData.goal
    };
  }
  
  // Parse Java toString() format
  if (typeof sprintData === 'string') {
    const result: any = {};
    
    const idMatch = sprintData.match(/id=(\d+)/);
    if (idMatch) result.id = parseInt(idMatch[1], 10);
    
    const nameMatch = sprintData.match(/name=([^,\]]+)/);
    if (nameMatch) result.name = nameMatch[1];
    
    const stateMatch = sprintData.match(/state=([^,\]]+)/);
    if (stateMatch) result.state = stateMatch[1];
    
    const startMatch = sprintData.match(/startDate=([^,\]]+)/);
    if (startMatch && startMatch[1] !== '<null>') result.startDate = startMatch[1];
    
    const endMatch = sprintData.match(/endDate=([^,\]]+)/);
    if (endMatch && endMatch[1] !== '<null>') result.endDate = endMatch[1];
    
    const goalMatch = sprintData.match(/goal=([^,\]]*)/);
    if (goalMatch && goalMatch[1] !== '<null>') result.goal = goalMatch[1] || null;
    
    return Object.keys(result).length > 0 ? result : null;
  }
  
  return null;
}

// Helper: Parse sprints array from customfield_10008
function parseSprints(customfield10008: any) {
  if (!customfield10008 || !Array.isArray(customfield10008)) {
    return [];
  }
  return customfield10008.map(s => parseSprint(s)).filter(Boolean);
}

// Helper: Run async tasks with a concurrency limit (avoids hammering Jira)
async function asyncPool<T, R>(concurrency: number, items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: Promise<R>[] = [];
  const executing = new Set<Promise<R>>();

  for (const item of items) {
    const promise: Promise<R> = fn(item).then(result => {
      executing.delete(promise);
      return result;
    });
    executing.add(promise);
    results.push(promise);

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

// Helper: Calculate working days between two dates (excludes weekends)
function calculateWorkingDays(startDate: string, endDate: string): number {
  const start = new Date(startDate);
  const end = new Date(endDate);
  let workingDays = 0;
  
  const current = new Date(start);
  while (current <= end) {
    const dayOfWeek = current.getDay();
    // 0 = Sunday, 6 = Saturday
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      workingDays++;
    }
    current.setDate(current.getDate() + 1);
  }
  
  return workingDays;
}

// Tool definitions
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [      // 1. GET FULL ISSUE
      {
        name: "quinta-jira_get_full_issue",
        description: "Get COMPLETE issue details including descriptions, comments, assignee names, priority, and all custom fields. Example: quinta-jira_get_full_issue({issue_key: 'QT-14006'})",
        inputSchema: {
          type: "object",
          properties: {
            issue_key: {
              type: "string",
              description: "Issue key (e.g., 'QT-14006')",
            },
          },
          required: ["issue_key"],
        },
      },
      
      // 2. SEARCH SPRINT ISSUES
      {
        name: "quinta-jira_search_sprint_issues",
        description: "Search all issues in current or specific sprint with FULL field data including assignees, priorities, descriptions. Returns paginated results with total count. Example: quinta-jira_search_sprint_issues({project_key: 'QT', max_results: 500})",
        inputSchema: {
          type: "object",
          properties: {
            project_key: {
              type: "string",
              description: "Project key (e.g., 'QT')",
              default: "QT",
            },
            sprint_name: {
              type: "string",
              description: "Optional: specific sprint name. If omitted, searches open sprints",
            },
            max_results: {
              type: ["number", "string"],
              description: "Maximum results to return (default: 500)",
              default: 500,
            },
          },
          required: ["project_key"],
        },
      },
      
      // 3. TEAM WORKLOAD
      {
        name: "quinta-jira_get_team_workload",
        description: "Analyze team workload distribution for current sprint with assignee names and ticket counts grouped by status. Includes unassigned tickets. Example: quinta-jira_get_team_workload({project_key: 'QT'})",
        inputSchema: {
          type: "object",
          properties: {
            project_key: {
              type: "string",
              description: "Project key (e.g., 'QT')",
              default: "QT",
            },
          },
          required: ["project_key"],
        },
      },
      
      // 4. HOTFIX ANALYSIS
      {
        name: "quinta-jira_analyze_hotfixes",
        description: "Analyze all HOTFIX tickets in current sprint - groups by component, identifies patterns, calculates ratio vs total tickets. Detects 'HOTFIX' and 'HTOFIX' typo variants. Example: quinta-jira_analyze_hotfixes({project_key: 'QT'})",
        inputSchema: {
          type: "object",
          properties: {
            project_key: {
              type: "string",
              description: "Project key (e.g., 'QT')",
              default: "QT",
            },
          },
          required: ["project_key"],
        },
      },
      
      // 5. ADVANCED SEARCH
      {
        name: "quinta-jira_search_advanced",
        description: "Advanced JQL search with custom field selection. Supports complex queries with AND/OR logic, custom fields, date ranges. Example: quinta-jira_search_advanced({jql: 'project = QT AND status = \"In Progress\"', max_results: 100})",
        inputSchema: {
          type: "object",
          properties: {
            jql: {
              type: "string",
              description: "JQL query string (e.g., 'project = QT AND assignee = currentUser()')",
            },
            max_results: {
              type: ["number", "string"],
              description: "Maximum results (default: 100)",
              default: 100,
            },
          },
          required: ["jql"],
        },
      },
      
      // 6. TIME METRICS
      {
        name: "quinta-jira_get_time_metrics",
        description: "Extract time estimates and logged time BY ROLE (dev/test/review) for current sprint. Includes ticket-level breakdown and sprint totals in hours/days. Example: quinta-jira_get_time_metrics({project_key: 'QT'})",
        inputSchema: {
          type: "object",
          properties: {
            project_key: {
              type: "string",
              description: "Project key (e.g., 'QT')",
              default: "QT",
            },
          },
          required: ["project_key"],
        },
      },
      
      // 7. UNASSIGNED BY ROLE
      {
        name: "quinta-jira_get_unassigned_by_role",
        description: "Count tickets unassigned for DEVELOPER vs TESTER roles separately. Helps identify bottlenecks in role-based assignment workflow. Example: quinta-jira_get_unassigned_by_role({project_key: 'QT'})",
        inputSchema: {
          type: "object",
          properties: {
            project_key: {
              type: "string",
              description: "Project key (e.g., 'QT')",
              default: "QT",
            },
          },
          required: ["project_key"],
        },
      },
      
      // 8. SEARCH BY LABELS
      {
        name: "quinta-jira_search_by_labels",
        description: "Search tickets by specific labels (rg for regressions, SprintGoal, etc.) with status breakdown. Returns count, status distribution, and ticket list per label. Example: quinta-jira_search_by_labels({project_key: 'QT', labels: ['rg', 'SprintGoal']})",
        inputSchema: {
          type: "object",
          properties: {
            project_key: {
              type: "string",
              description: "Project key (e.g., 'QT')",
              default: "QT",
            },
            labels: {
              type: "array",
              items: { type: "string" },
              description: "Labels to search for (e.g., ['rg', 'SprintGoal'])",
            },
          },
          required: ["project_key", "labels"],
        },
      },
      
      // 9. RATE LIMITS
      {
        name: "quinta-jira_get_rate_limits",
        description: "Check current API rate limit status and remaining quota. Returns limit, remaining requests, reset time, and status (OK/WARNING). Example: quinta-jira_get_rate_limits({})",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      
      // 10. GET ALL LABELS
      {
        name: "quinta-jira_get_all_labels",
        description: "Discover labels used in a project with usage counts. Defaults to the project's OPEN SPRINTS (fast, consistent with the other analytics tools). Pass scope:'all' to scan the whole project history (slower; may be truncated on very large projects — check the 'truncated' flag). Example: quinta-jira_get_all_labels({project_key: 'QT'}) or ({project_key: 'QT', scope: 'all'})",
        inputSchema: {
          type: "object",
          properties: {
            project_key: {
              type: "string",
              description: "Project key (e.g., 'QT')",
              default: "QT",
            },
            scope: {
              type: "string",
              enum: ["open_sprints", "all"],
              description: "'open_sprints' (default): labels on issues in the project's open sprints. 'all': labels across the entire project history.",
              default: "open_sprints",
            },
          },
          required: ["project_key"],
        },
      },
      
      // 11. TIME IN STATUS
      {
        name: "quinta-jira_get_time_in_status",
        description: "Calculate average time issues spend in each status (To Do, In Progress, Done, etc.). Identifies workflow bottlenecks. Example: quinta-jira_get_time_in_status({project_key: 'QT'})",
        inputSchema: {
          type: "object",
          properties: {
            project_key: {
              type: "string",
              description: "Project key (e.g., 'QT')",
              default: "QT",
            },
          },
          required: ["project_key"],
        },
      },
      
      // 12. LIST SPRINTS
      {
        name: "quinta-jira_list_sprints",
        description: "List all sprints in project with status (active/closed/future), start/end dates, and goal. Example: quinta-jira_list_sprints({project_key: 'QT', board_id: 58})",
        inputSchema: {
          type: "object",
          properties: {
            project_key: {
              type: "string",
              description: "Project key (e.g., 'QT')",
              default: "QT",
            },
            board_id: {
              type: ["number", "string"],
              description: "Board ID to fetch sprints from",
            },
          },
          required: ["project_key"],
        },
      },
      
      // 13. CREATE ISSUE
      {
        name: "quinta-jira_create_issue",
        description: "Create new Jira issue with full field support. User fields (assignee, tester, reviewer) use Jira DC username (the 'name' field, e.g. 'osg', 'hga'). Example: quinta-jira_create_issue({project_key: 'QT', summary: 'Bug found', issue_type: 'Bug', assignee: 'osg'})",
        inputSchema: {
          type: "object",
          properties: {
            project_key: {
              type: "string",
              description: "Project key (e.g., 'QT')",
            },
            summary: {
              type: "string",
              description: "Issue summary/title",
            },
            description: {
              type: "string",
              description: "Issue description",
            },
            issue_type: {
              type: "string",
              description: "Issue type (Bug, Task, Story, Sub-task, etc.)",
              default: "Task",
            },
            priority: {
              type: "string",
              description: "Priority (Highest, High, Medium, Low, Lowest)",
            },
            assignee: {
              type: "string",
              description: "Assignee username (Jira DC 'name' field, e.g. 'osg', 'hga')",
            },
            labels: {
              type: "array",
              items: { type: "string" },
              description: "Labels array (e.g. ['Hotfix'])",
            },
            time_estimate: {
              type: "string",
              description: "Time estimate in Jira format (e.g. '4h', '2d', '1w 2d 4h')",
            },
            reviewer_key: {
              type: "string",
              description: "Reviewer username — sets customfield_10020 (Reviewed By)",
            },
            tester_key: {
              type: "string",
              description: "Tester username — sets customfield_10018 (Tester)",
            },
            components: {
              type: "array",
              items: { type: "string" },
              description: "Component names (e.g. ['Backend', 'Frontend'])",
            },
            fix_versions: {
              type: "array",
              items: { type: "string" },
              description: "Fix version names (e.g. ['v2.1.0'])",
            },
            due_date: {
              type: "string",
              description: "Due date in YYYY-MM-DD format",
            },
            epic_link: {
              type: "string",
              description: "Epic issue key to link to (e.g. 'QT-1000')",
            },
            parent_key: {
              type: "string",
              description: "Parent issue key for sub-tasks (e.g. 'QT-1234')",
            },
            sprint_id: {
              type: ["number", "string"],
              description: "Sprint ID to assign the issue to (use list_sprints to find IDs)",
            },
            story_points: {
              type: ["number", "string"],
              description: "Story points estimate",
            },
            epic_name: {
              type: "string",
              description: "Epic name (required when issue_type is 'Epic'). Maps to customfield_10003.",
            },
          },
          required: ["project_key", "summary"],
        },
      },
      
      // 14. UPDATE ISSUE
      {
        name: "quinta-jira_update_issue",
        description: `Update existing issue fields. Jira DC field formats:
- assignee: {"name": "username"} (NOT accountId)
- priority: {"name": "High"}
- labels: ["label1", "label2"]
- components: [{"name": "Backend"}]
- fixVersions: [{"name": "v2.0"}]
- duedate: "2026-12-31"
- customfield_10018 (Tester): {"name": "username"}
- customfield_10020 (Reviewed By): {"name": "username"}
- customfield_10023 (Story point estimate): number
- customfield_10012 (Story Points classic): number
- customfield_10006 (Epic Link): "QT-1000"
- customfield_10015 (Flagged): [{"value": "Impediment"}]
- customfield_10901 (QA Status): {"value": "QA Pending"}
- customfield_10900 (QA Validator): {"name": "username"}
- timetracking: {"originalEstimate": "4h"} (auto-routed to update block)
- timeOriginalEstimate: "4h" (shorthand, also auto-routed)
- customfield_10901 (QA Status): {"id": "OPTION_ID"} (use option ID, not value name)
For sprint assignment, use move_to_sprint tool instead.
Example: quinta-jira_update_issue({issue_key: 'QT-123', fields: {assignee: {name: 'osg'}}})`,
        inputSchema: {
          type: "object",
          properties: {
            issue_key: {
              type: "string",
              description: "Issue key (e.g., 'QT-14006')",
            },
            fields: {
              type: "object",
              description: "Fields object — see tool description for Jira DC format reference",
            },
          },
          required: ["issue_key", "fields"],
        },
      },
      
      // 15. TRANSITION ISSUE
      {
        name: "quinta-jira_transition_issue",
        description: "Change issue status (To Do → In Progress → Done, etc.). Use get_transitions to see available transitions first. Pass `fields` to set values that live on the transition screen (e.g. resolution) — these cannot be set via update_issue. Example: quinta-jira_transition_issue({issue_key: 'QT-123', transition_id: '2', fields: {resolution: {name: \"Won't Do\"}}})",
        inputSchema: {
          type: "object",
          properties: {
            issue_key: {
              type: "string",
              description: "Issue key (e.g., 'QT-14006')",
            },
            transition_id: {
              type: "string",
              description: "Transition ID (get from quinta-jira_get_transitions)",
            },
            fields: {
              type: "object",
              description: "Optional field values to set during the transition (transition-screen fields like resolution), e.g. {\"resolution\": {\"name\": \"Won't Do\"}}. Sent as the \"fields\" key alongside the transition.",
              additionalProperties: true,
            },
          },
          required: ["issue_key", "transition_id"],
        },
      },
      
      // 16. ADD COMMENT
      {
        name: "quinta-jira_add_comment",
        description: "Add comment to issue. The body is sent verbatim as Jira Server/DC wiki markup (e.g. *bold*, {code}…{code}); plain text works as-is. Returns comment ID. Example: quinta-jira_add_comment({issue_key: 'QT-123', body: 'This is fixed now'})",
        inputSchema: {
          type: "object",
          properties: {
            issue_key: {
              type: "string",
              description: "Issue key (e.g., 'QT-14006')",
            },
            body: {
              type: "string",
              description: "Comment text, sent as Jira wiki markup (not Markdown)",
            },
          },
          required: ["issue_key", "body"],
        },
      },
      
      // 17. ADD ATTACHMENT
      {
        name: "quinta-jira_add_attachment",
        description: "Add a file attachment to an issue. Provide exactly ONE content source: `file_path` (a local file path on the machine running this server — the best option for files the user already has on disk), `source_url` (the server downloads it), or `content_base64` (raw base64 content). `filename` is inferred from `file_path`/`source_url` when omitted, but is required with `content_base64`. Examples: quinta-jira_add_attachment({issue_key: 'QT-123', file_path: 'C:\\\\Users\\\\me\\\\screenshot.png'}) or quinta-jira_add_attachment({issue_key: 'QT-123', source_url: 'https://example.com/report.pdf'})",
        inputSchema: {
          type: "object",
          properties: {
            issue_key: {
              type: "string",
              description: "Issue key (e.g., 'QT-14006')",
            },
            filename: {
              type: "string",
              description: "Filename with extension. Optional with file_path/source_url (inferred); required with content_base64.",
            },
            file_path: {
              type: "string",
              description: "Absolute local path to the file to upload, read directly by the server.",
            },
            source_url: {
              type: "string",
              description: "URL to download the file from before attaching it.",
            },
            content_base64: {
              type: "string",
              description: "Base64 encoded file content (legacy path — prefer file_path or source_url).",
            },
          },
          required: ["issue_key"],
        },
      },
      
      // 18. GET EPIC CHILDREN
      {
        name: "quinta-jira_get_epic_children",
        description: "Get all issues linked to an epic with full details. Includes story points, assignees, status. Example: quinta-jira_get_epic_children({epic_key: 'QT-1000'})",
        inputSchema: {
          type: "object",
          properties: {
            epic_key: {
              type: "string",
              description: "Epic issue key (e.g., 'QT-1000')",
            },
            max_results: {
              type: ["number", "string"],
              description: "Maximum child issues to return (default: 100)",
              default: 100,
            },
          },
          required: ["epic_key"],
        },
      },
      
      // 19. GET TRANSITIONS
      {
        name: "quinta-jira_get_transitions",
        description: "Get available status transitions for an issue (what statuses it can move to). Required before calling transition_issue. Example: quinta-jira_get_transitions({issue_key: 'QT-123'})",
        inputSchema: {
          type: "object",
          properties: {
            issue_key: {
              type: "string",
              description: "Issue key (e.g., 'QT-14006')",
            },
          },
          required: ["issue_key"],
        },
      },
      
      // 20. GET CUSTOM FIELDS
      {
        name: "quinta-jira_get_custom_fields",
        description: "Discover all custom field IDs and names in QuickText Jira. Useful for understanding field mapping (customfield_10023 = Story point estimate, etc.). Example: quinta-jira_get_custom_fields({})",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      
      // 21. SEARCH BY ASSIGNEE
      {
        name: "quinta-jira_search_by_assignee",
        description: "Find all tickets assigned to specific user(s) in current sprint. Supports multiple assignees. Example: quinta-jira_search_by_assignee({project_key: 'QT', assignee_names: ['John Doe']})",
        inputSchema: {
          type: "object",
          properties: {
            project_key: {
              type: "string",
              description: "Project key (e.g., 'QT')",
              default: "QT",
            },
            assignee_names: {
              type: "array",
              items: { type: "string" },
              description: "List of assignee display names",
            },
          },
          required: ["project_key", "assignee_names"],
        },
      },
      
      // 22. GET STATUS DISTRIBUTION
      {
        name: "quinta-jira_get_status_distribution",
        description: "Analyze ticket distribution across statuses (To Do, In Progress, Done, etc.) for current sprint. Shows percentages and counts. Example: quinta-jira_get_status_distribution({project_key: 'QT'})",
        inputSchema: {
          type: "object",
          properties: {
            project_key: {
              type: "string",
              description: "Project key (e.g., 'QT')",
              default: "QT",
            },
          },
          required: ["project_key"],
        },
      },
      
      // 23. GET REPORTER STATS
      {
        name: "quinta-jira_get_reporter_stats",
        description: "Analyze who creates the most tickets (reporters) in current sprint. Shows counts, percentages, and top reporters. Example: quinta-jira_get_reporter_stats({project_key: 'QT'})",
        inputSchema: {
          type: "object",
          properties: {
            project_key: {
              type: "string",
              description: "Project key (e.g., 'QT')",
              default: "QT",
            },
          },
          required: ["project_key"],
        },
      },
      
      // 24-30: Additional productivity tools
      {
        name: "quinta-jira_get_issue_links",
        description: "Get all linked issues (blocks, is blocked by, relates to, duplicates, etc.). Shows relationship types and linked issue details. Example: quinta-jira_get_issue_links({issue_key: 'QT-123'})",
        inputSchema: {
          type: "object",
          properties: {
            issue_key: {
              type: "string",
              description: "Issue key (e.g., 'QT-14006')",
            },
          },
          required: ["issue_key"],
        },
      },
      {
        name: "quinta-jira_get_issue_history",
        description: "Get complete change history for an issue (who changed what and when). Includes field changes, status transitions, assignments. Example: quinta-jira_get_issue_history({issue_key: 'QT-123'})",
        inputSchema: {
          type: "object",
          properties: {
            issue_key: {
              type: "string",
              description: "Issue key (e.g., 'QT-14006')",
            },
          },
          required: ["issue_key"],
        },
      },
      {
        name: "quinta-jira_get_sprint_velocity",
        description: "Calculate sprint velocity (story points completed per sprint) over last N sprints. Helps with capacity planning. Example: quinta-jira_get_sprint_velocity({project_key: 'QT', sprint_count: 5})",
        inputSchema: {
          type: "object",
          properties: {
            project_key: {
              type: "string",
              description: "Project key (e.g., 'QT')",
              default: "QT",
            },
            sprint_count: {
              type: ["number", "string"],
              description: "Number of past (closed) sprints to analyze (default: 3)",
              default: 3,
            },
            board_id: {
              type: ["number", "string"],
              description: "Optional board id. If omitted, the first scrum board for the project is used.",
            },
            story_points_field: {
              type: "string",
              description: "Custom field id holding story points (default: customfield_10023)",
              default: "customfield_10023",
            },
          },
          required: ["project_key"],
        },
      },
      {
        name: "quinta-jira_get_blocked_tickets",
        description: "Find all tickets currently blocked or with 'blocked' status. Critical for identifying sprint impediments. Example: quinta-jira_get_blocked_tickets({project_key: 'QT'})",
        inputSchema: {
          type: "object",
          properties: {
            project_key: {
              type: "string",
              description: "Project key (e.g., 'QT')",
              default: "QT",
            },
          },
          required: ["project_key"],
        },
      },
      {
        name: "quinta-jira_get_priority_breakdown",
        description: "Analyze ticket distribution by priority (Highest, High, Medium, Low). Shows counts and percentages. Example: quinta-jira_get_priority_breakdown({project_key: 'QT'})",
        inputSchema: {
          type: "object",
          properties: {
            project_key: {
              type: "string",
              description: "Project key (e.g., 'QT')",
              default: "QT",
            },
          },
          required: ["project_key"],
        },
      },
      {
        name: "quinta-jira_get_component_breakdown",
        description: "Analyze tickets by component (Backend, Frontend, QA, etc.). Identifies which components have most issues. Example: quinta-jira_get_component_breakdown({project_key: 'QT'})",
        inputSchema: {
          type: "object",
          properties: {
            project_key: {
              type: "string",
              description: "Project key (e.g., 'QT')",
              default: "QT",
            },
          },
          required: ["project_key"],
        },
      },
      {
        name: "quinta-jira_bulk_transition",
        description: "Transition multiple issues to same status at once. Efficient for batch operations. Pass `fields` to set transition-screen values (e.g. resolution) on every issue in the batch. Example: quinta-jira_bulk_transition({issue_keys: ['QT-1', 'QT-2'], transition_id: '2', fields: {resolution: {name: \"Won't Do\"}}})",
        inputSchema: {
          type: "object",
          properties: {
            issue_keys: {
              type: "array",
              items: { type: "string" },
              description: "Array of issue keys to transition",
            },
            transition_id: {
              type: "string",
              description: "Transition ID (same for all issues)",
            },
            fields: {
              type: "object",
              description: "Optional field values to set during the transition for every issue (transition-screen fields like resolution), e.g. {\"resolution\": {\"name\": \"Won't Do\"}}.",
              additionalProperties: true,
            },
          },
          required: ["issue_keys", "transition_id"],
        },
      },
      
      // 31. GET SPRINT KPI DATA
      {
        name: "quinta-jira_get_sprint_kpi_data",
        description: "Fetch comprehensive sprint KPI data including time tracking, test/review frequencies, and role assignments. Returns all data needed for sprint analytics dashboards. Example: quinta-jira_get_sprint_kpi_data({project_key: 'QT', sprint_name: 'Sprint 191'})",
        inputSchema: {
          type: "object",
          properties: {
            project_key: {
              type: "string",
              description: "Project key (e.g., 'QT')",
              default: "QT",
            },
            sprint_name: {
              type: "string",
              description: "Optional: specific sprint name. If omitted, uses open sprints",
            },
            max_results: {
              type: ["number", "string"],
              description: "Maximum results (default: 1000)",
              default: 1000,
            },
          },
          required: ["project_key"],
        },
      },
      
      // 32. LIST BOARDS (Discovery Suite)
      {
        name: "quinta-jira_list_boards",
        description: "Discover Scrum/Kanban boards. Use this to find board_ids. Filters: name, project_key. Example: quinta-jira_list_boards({name: 'QT Board', project_key: 'QT'})",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Filter by board name (partial match)",
            },
            project_key: {
              type: "string",
              description: "Filter by project key (e.g., 'QT')",
            },
          },
        },
      },
      
      // 33. GET BOARD (Discovery Suite)
      {
        name: "quinta-jira_get_board",
        description: "Get configuration and column details for a specific board. Returns board type, location, and configuration including workflow columns. Example: quinta-jira_get_board({board_id: 58})",
        inputSchema: {
          type: "object",
          properties: {
            board_id: {
              type: ["number", "string"],
              description: "Board ID (get from list_boards)",
            },
          },
          required: ["board_id"],
        },
      },
      
      // 34. GET SPRINT (Discovery Suite)
      {
        name: "quinta-jira_get_sprint",
        description: "Get full details of a specific sprint including duration metrics and state. Returns sprint dates, goal, state (active/closed/future), and calculated working days. Example: quinta-jira_get_sprint({sprint_id: 184})",
        inputSchema: {
          type: "object",
          properties: {
            sprint_id: {
              type: ["number", "string"],
              description: "Sprint ID (get from list_sprints or list_boards)",
            },
          },
          required: ["sprint_id"],
        },
      },

      // 35. GET TESTER WORKLOAD
      {
        name: "quinta-jira_get_tester_workload",
        description: "Show workload distribution across testers in the current sprint, grouped by tester name. Reads customfield_10018 (Tester field). Example: quinta-jira_get_tester_workload({project_key: 'QT'})",
        inputSchema: {
          type: "object",
          properties: {
            project_key: {
              type: "string",
              description: "Project key (e.g., 'QT')",
              default: "QT",
            },
          },
          required: ["project_key"],
        },
      },

      // 36. GET REVIEWER WORKLOAD
      {
        name: "quinta-jira_get_reviewer_workload",
        description: "Show workload distribution across reviewers in the current sprint, grouped by reviewer name. Reads customfield_10020 (Reviewed By field). Example: quinta-jira_get_reviewer_workload({project_key: 'QT'})",
        inputSchema: {
          type: "object",
          properties: {
            project_key: {
              type: "string",
              description: "Project key (e.g., 'QT')",
              default: "QT",
            },
          },
          required: ["project_key"],
        },
      },

      // 37. GET ISSUE WORKLOGS
      {
        name: "quinta-jira_get_issue_worklogs",
        description: "Get all work log entries for a specific issue showing who logged time, how much, and when. Returns individual worklog records with author details and time spent. Example: quinta-jira_get_issue_worklogs({issue_key: 'QT-14006'})",
        inputSchema: {
          type: "object",
          properties: {
            issue_key: {
              type: "string",
              description: "Issue key (e.g., 'QT-14006')",
            },
          },
          required: ["issue_key"],
        },
      },

      // 38. GET BULK WORKLOGS
      {
        name: "quinta-jira_get_bulk_worklogs",
        description: "Get worklogs across multiple issues aggregated by author. Shows who actually logged time (not just ticket assignee). Supports filtering by sprint name or date range. WARNING: Makes one API call per issue, use max_issues to limit. Example: quinta-jira_get_bulk_worklogs({project_key: 'QT', sprint_name: 'QUIC Sprint 198'})",
        inputSchema: {
          type: "object",
          properties: {
            project_key: {
              type: "string",
              description: "Project key (e.g., 'QT')",
            },
            sprint_name: {
              type: "string",
              description: "Sprint name (e.g., 'QUIC Sprint 198'). If omitted, uses open sprints",
            },
            date_from: {
              type: "string",
              description: "Start date ISO format (e.g., '2025-09-09'). Alternative to sprint_name",
            },
            date_to: {
              type: "string",
              description: "End date ISO format (e.g., '2025-09-23'). Used with date_from",
            },
            max_issues: {
              type: ["number", "string"],
              description: "Max issues to fetch worklogs for (default: 200). Use small values for testing",
              default: 200,
            },
          },
          required: ["project_key"],
        },
      },

      // 39. GET ISSUE CYCLE TIME
      {
        name: "quinta-jira_get_issue_cycle_time",
        description: "Calculate cycle time and time-in-status for sprint issues using changelog data. Shows how long tickets spent in each status, identifies bottleneck statuses, and provides per-assignee cycle times. WARNING: Makes one API call per issue. Example: quinta-jira_get_issue_cycle_time({project_key: 'QT', sprint_name: 'QUIC Sprint 198'})",
        inputSchema: {
          type: "object",
          properties: {
            project_key: {
              type: "string",
              description: "Project key (e.g., 'QT')",
            },
            sprint_name: {
              type: "string",
              description: "Sprint name. If omitted, uses open sprints",
            },
            max_issues: {
              type: ["number", "string"],
              description: "Max issues to process (default: 100). Use small values for testing",
              default: 100,
            },
          },
          required: ["project_key"],
        },
      },
      {
        name: "quinta-jira_get_mentions",
        description: "Find all issues where a user was @mentioned in comments within a time window. Uses two-step approach: JQL candidate fetch + comment-level [~username] markup scan. Required because Jira DC 9.4 has no native JQL mention operator. Default window: last 2 weeks. Example: quinta-jira_get_mentions({username_key: 'jam', project_key: 'QT', since: '-2w'})",
        inputSchema: {
          type: "object",
          properties: {
            username_key: {
              type: "string",
              description: "Jira username key used in @mentions, e.g. 'jam'. This is the key in [~jam] markup.",
            },
            project_key: {
              type: "string",
              description: "Project key to search within. Default: 'QT'",
              default: "QT",
            },
            since: {
              type: "string",
              description: "Start of time window. ISO date 'YYYY-MM-DD' or relative '-Nd'/'-Nw' (e.g. '-2w', '-14d', '-30d'). Default: '-2w'",
              default: "-2w",
            },
            until: {
              type: "string",
              description: "End of time window. ISO date 'YYYY-MM-DD'. Default: now (omit for current time)",
            },
          },
          required: ["username_key"],
        },
      },

      // 41. DELETE ISSUE
      {
        name: "quinta-jira_delete_issue",
        description: "Delete an issue from Jira. Use with caution — this is irreversible. Example: quinta-jira_delete_issue({issue_key: 'QT-99999', delete_subtasks: true})",
        inputSchema: {
          type: "object",
          properties: {
            issue_key: {
              type: "string",
              description: "Issue key to delete (e.g., 'QT-99999')",
            },
            delete_subtasks: {
              type: "boolean",
              description: "Also delete sub-tasks (default: false)",
              default: false,
            },
          },
          required: ["issue_key"],
        },
      },

      // 42. MOVE TO SPRINT
      {
        name: "quinta-jira_move_to_sprint",
        description: "Move one or more issues to a sprint using the Agile API. Use list_sprints to find sprint IDs. Example: quinta-jira_move_to_sprint({sprint_id: 308, issue_keys: ['QT-123', 'QT-456']})",
        inputSchema: {
          type: "object",
          properties: {
            sprint_id: {
              type: ["number", "string"],
              description: "Target sprint ID (get from list_sprints)",
            },
            issue_keys: {
              type: "array",
              items: { type: "string" },
              description: "Issue keys to move to the sprint",
            },
          },
          required: ["sprint_id", "issue_keys"],
        },
      },

      // 43. MOVE TO BACKLOG
      {
        name: "quinta-jira_move_to_backlog",
        description: "Move issues to the backlog (remove from any sprint). Example: quinta-jira_move_to_backlog({issue_keys: ['QT-123']})",
        inputSchema: {
          type: "object",
          properties: {
            issue_keys: {
              type: "array",
              items: { type: "string" },
              description: "Issue keys to move to backlog",
            },
          },
          required: ["issue_keys"],
        },
      },

      // 44. ADD ISSUE LINK
      {
        name: "quinta-jira_add_issue_link",
        description: "Create a link between two issues. Link types: 'Blocks' (outward: blocks / inward: is blocked by), 'Duplicate' (outward: duplicates / inward: is duplicated by), 'Relates' (relates to). Example: quinta-jira_add_issue_link({link_type: 'Blocks', inward_issue: 'QT-100', outward_issue: 'QT-200'})",
        inputSchema: {
          type: "object",
          properties: {
            link_type: {
              type: "string",
              description: "Link type name (e.g. 'Blocks', 'Duplicate', 'Relates', 'Cloners')",
            },
            inward_issue: {
              type: "string",
              description: "Inward issue key (e.g. 'QT-100' — this issue 'is blocked by' the outward issue)",
            },
            outward_issue: {
              type: "string",
              description: "Outward issue key (e.g. 'QT-200' — this issue 'blocks' the inward issue)",
            },
            comment: {
              type: "string",
              description: "Optional comment to add with the link",
            },
          },
          required: ["link_type", "inward_issue", "outward_issue"],
        },
      },

      // 45. ADD WATCHER
      {
        name: "quinta-jira_add_watcher",
        description: "Add a user as watcher to an issue. Example: quinta-jira_add_watcher({issue_key: 'QT-123', username: 'osg'})",
        inputSchema: {
          type: "object",
          properties: {
            issue_key: {
              type: "string",
              description: "Issue key",
            },
            username: {
              type: "string",
              description: "Username to add as watcher (Jira DC 'name' field)",
            },
          },
          required: ["issue_key", "username"],
        },
      },

      // 46. REMOVE WATCHER
      {
        name: "quinta-jira_remove_watcher",
        description: "Remove a user from watchers of an issue. Example: quinta-jira_remove_watcher({issue_key: 'QT-123', username: 'osg'})",
        inputSchema: {
          type: "object",
          properties: {
            issue_key: {
              type: "string",
              description: "Issue key",
            },
            username: {
              type: "string",
              description: "Username to remove from watchers",
            },
          },
          required: ["issue_key", "username"],
        },
      },

      // 47. GET WATCHERS
      {
        name: "quinta-jira_get_watchers",
        description: "Get all watchers of an issue. Example: quinta-jira_get_watchers({issue_key: 'QT-123'})",
        inputSchema: {
          type: "object",
          properties: {
            issue_key: {
              type: "string",
              description: "Issue key",
            },
          },
          required: ["issue_key"],
        },
      },

      // 48. GET ISSUE LINK TYPES
      {
        name: "quinta-jira_get_link_types",
        description: "Get all available issue link types (Blocks, Duplicate, Relates, etc.). Use before add_issue_link to find correct link type names.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },

      // 49. ASSIGN ISSUE
      {
        name: "quinta-jira_assign_issue",
        description: "Assign an issue to a user using Jira DC's dedicated assignment endpoint. More reliable than update_issue for assignee changes. Use username=null to unassign. Example: quinta-jira_assign_issue({issue_key: 'QT-123', username: 'osg'})",
        inputSchema: {
          type: "object",
          properties: {
            issue_key: {
              type: "string",
              description: "Issue key",
            },
            username: {
              type: "string",
              description: "Username to assign (Jira DC 'name' field). Pass null or omit to unassign.",
            },
          },
          required: ["issue_key"],
        },
      },

      // 50. RANK ISSUES
      {
        name: "quinta-jira_rank_issues",
        description: "Reorder issues in the backlog/sprint by ranking them before or after another issue. Example: quinta-jira_rank_issues({issue_keys: ['QT-100'], rank_before: 'QT-200'})",
        inputSchema: {
          type: "object",
          properties: {
            issue_keys: {
              type: "array",
              items: { type: "string" },
              description: "Issue keys to reorder",
            },
            rank_before: {
              type: "string",
              description: "Place the issues before this issue key",
            },
            rank_after: {
              type: "string",
              description: "Place the issues after this issue key",
            },
          },
          required: ["issue_keys"],
        },
      },

      // 51. LIST ATTACHMENTS
      {
        name: "quinta-jira_list_attachments",
        description: "List all attachments on a Jira issue with metadata (id, filename, mime_type, size_bytes, download URL, thumbnail URL). Returns empty array when the issue has no attachments. Example: quinta-jira_list_attachments({issue_key: 'QT-15415'})",
        inputSchema: {
          type: "object",
          properties: {
            issue_key: {
              type: "string",
              description: "Issue key (e.g., 'QT-15415')",
            },
          },
          required: ["issue_key"],
        },
      },

      // 52. GET ATTACHMENT
      {
        name: "quinta-jira_get_attachment",
        description: "Download a specific attachment by its ID. Images (PNG/JPEG/GIF/WEBP) are returned as native MCP image blocks so Claude can see them directly. Small text files are returned as decoded text. PDFs and other binaries are returned as base64 in a text block. Example: quinta-jira_get_attachment({attachment_id: '202820'})",
        inputSchema: {
          type: "object",
          properties: {
            attachment_id: {
              type: "string",
              description: "Attachment ID from quinta-jira_list_attachments (e.g., '202820')",
            },
            max_size_mb: {
              type: ["number", "string"],
              description: "Maximum file size to download in MB (default: 10)",
              default: 10,
            },
          },
          required: ["attachment_id"],
        },
      },

      // 53. GET ISSUE ATTACHMENTS BULK
      {
        name: "quinta-jira_get_issue_attachments_bulk",
        description: "Download all image attachments from an issue in one call (up to 5 images). Returns native MCP image blocks so Claude can see the images directly. Ideal for viewing all visual specs on a ticket. Example: quinta-jira_get_issue_attachments_bulk({issue_key: 'QT-15415'})",
        inputSchema: {
          type: "object",
          properties: {
            issue_key: {
              type: "string",
              description: "Issue key (e.g., 'QT-15415')",
            },
            max_size_mb: {
              type: ["number", "string"],
              description: "Max size per image in MB (default: 10)",
              default: 10,
            },
            max_images: {
              type: ["number", "string"],
              description: "Maximum number of images to download (default: 5, hard cap: 5)",
              default: 5,
            },
          },
          required: ["issue_key"],
        },
      },

      // ─── Confluence Tools ──────────────────────────────────────────────────

      // 54. SEARCH PAGES
      {
        name: "quinta-confluence_search_pages",
        description: "Search Confluence pages using CQL (Confluence Query Language). Returns matching pages with id, title, space, and last-updated date. Example: quinta-confluence_search_pages({cql: 'space=DEV AND title~\"onboarding\"', limit: 10})",
        inputSchema: {
          type: "object",
          properties: {
            cql: { type: "string", description: "CQL query (e.g., 'space=DEV AND type=page AND label=release')" },
            limit: { type: ["number", "string"], description: "Max results to return (default: 25, max: 50)", default: 25 },
            start: { type: ["number", "string"], description: "Pagination offset (default: 0)", default: 0 },
          },
          required: ["cql"],
        },
      },

      // 55. GET PAGE
      {
        name: "quinta-confluence_get_page",
        description: "Get full details of a Confluence page by its ID, including body content, version, space, and parent. Example: quinta-confluence_get_page({page_id: '123456'})",
        inputSchema: {
          type: "object",
          properties: {
            page_id: { type: "string", description: "Confluence page ID (numeric string)" },
            include_body: { type: "boolean", description: "Include page body as plain text (default: true)", default: true },
          },
          required: ["page_id"],
        },
      },

      // 56. GET PAGE BY TITLE
      {
        name: "quinta-confluence_get_page_by_title",
        description: "Find a Confluence page by space key and exact title. Returns the page with its ID, version and content. Example: quinta-confluence_get_page_by_title({space_key: 'DEV', title: 'Architecture Overview'})",
        inputSchema: {
          type: "object",
          properties: {
            space_key: { type: "string", description: "Space key (e.g., 'DEV', 'HR', 'IT')" },
            title: { type: "string", description: "Exact page title to search for" },
          },
          required: ["space_key", "title"],
        },
      },

      // 57. GET CHILD PAGES
      {
        name: "quinta-confluence_get_child_pages",
        description: "Get all direct child pages of a Confluence page. Useful for navigating a space's page hierarchy. Example: quinta-confluence_get_child_pages({page_id: '123456'})",
        inputSchema: {
          type: "object",
          properties: {
            page_id: { type: "string", description: "Parent page ID" },
            limit: { type: ["number", "string"], description: "Max children to return (default: 25)", default: 25 },
          },
          required: ["page_id"],
        },
      },

      // 58. LIST SPACES
      {
        name: "quinta-confluence_list_spaces",
        description: "List all available Confluence spaces with their keys, names, types and status. Example: quinta-confluence_list_spaces({})",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: ["number", "string"], description: "Max spaces to return (default: 50)", default: 50 },
            type: { type: "string", description: "Filter by type: 'global' or 'personal' (optional)" },
          },
          required: [],
        },
      },

      // 59. GET SPACE
      {
        name: "quinta-confluence_get_space",
        description: "Get details of a specific Confluence space including description and homepage. Example: quinta-confluence_get_space({space_key: 'DEV'})",
        inputSchema: {
          type: "object",
          properties: {
            space_key: { type: "string", description: "Space key (e.g., 'DEV')" },
          },
          required: ["space_key"],
        },
      },

      // 60. GET PAGE LABELS
      {
        name: "quinta-confluence_get_page_labels",
        description: "Get all labels attached to a Confluence page. Example: quinta-confluence_get_page_labels({page_id: '123456'})",
        inputSchema: {
          type: "object",
          properties: {
            page_id: { type: "string", description: "Page ID" },
          },
          required: ["page_id"],
        },
      },

      // 61. SEARCH BY LABEL
      {
        name: "quinta-confluence_search_by_label",
        description: "Find all Confluence pages tagged with a specific label. Example: quinta-confluence_search_by_label({label: 'architecture', space_key: 'DEV'})",
        inputSchema: {
          type: "object",
          properties: {
            label: { type: "string", description: "Label name to search for" },
            space_key: { type: "string", description: "Limit search to this space key (optional)" },
            limit: { type: ["number", "string"], description: "Max results (default: 25)", default: 25 },
          },
          required: ["label"],
        },
      },

      // 62. GET PAGE COMMENTS
      {
        name: "quinta-confluence_get_page_comments",
        description: "Get all comments on a Confluence page with author and date. Example: quinta-confluence_get_page_comments({page_id: '123456'})",
        inputSchema: {
          type: "object",
          properties: {
            page_id: { type: "string", description: "Page ID" },
            limit: { type: ["number", "string"], description: "Max comments to return (default: 50)", default: 50 },
          },
          required: ["page_id"],
        },
      },

      // 63. GET PAGE HISTORY
      {
        name: "quinta-confluence_get_page_history",
        description: "Get the version history of a Confluence page, showing who changed it and when. Example: quinta-confluence_get_page_history({page_id: '123456', limit: 10})",
        inputSchema: {
          type: "object",
          properties: {
            page_id: { type: "string", description: "Page ID" },
            limit: { type: ["number", "string"], description: "Max versions to return (default: 10)", default: 10 },
          },
          required: ["page_id"],
        },
      },

      // 64. GET CURRENT USER
      {
        name: "quinta-confluence_get_current_user",
        description: "Get the profile of the currently authenticated Confluence user. Useful to verify connectivity and identity. Example: quinta-confluence_get_current_user({})",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },

      // 65. CREATE PAGE
      {
        name: "quinta-confluence_create_page",
        description: "Create a new Confluence page in a space. Body must be Confluence XHTML storage format (e.g., '<p>Hello world</p>'). Example: quinta-confluence_create_page({space_key: 'DEV', title: 'My New Page', body: '<p>Content here</p>'})",
        inputSchema: {
          type: "object",
          properties: {
            space_key: { type: "string", description: "Space key where the page will be created" },
            title: { type: "string", description: "Page title" },
            body: { type: "string", description: "Page body in Confluence XHTML storage format (e.g., '<p>Hello</p>')" },
            parent_id: { type: "string", description: "Optional parent page ID — creates the page as a child of this page" },
          },
          required: ["space_key", "title", "body"],
        },
      },

      // 66. UPDATE PAGE
      {
        name: "quinta-confluence_update_page",
        description: "Update an existing Confluence page. Requires the current version number (get it from quinta-confluence_get_page first). Body must be XHTML storage format. Example: quinta-confluence_update_page({page_id: '123456', title: 'Updated Title', body: '<p>New content</p>', version: 3})",
        inputSchema: {
          type: "object",
          properties: {
            page_id: { type: "string", description: "ID of the page to update" },
            title: { type: "string", description: "New page title" },
            body: { type: "string", description: "New page body in Confluence XHTML storage format" },
            version: { type: ["number", "string"], description: "Current version number of the page (required to prevent conflicts)" },
            version_message: { type: "string", description: "Optional message describing what changed" },
          },
          required: ["page_id", "title", "body", "version"],
        },
      },

      // 67. ADD PAGE COMMENT
      {
        name: "quinta-confluence_add_page_comment",
        description: "Add a comment to a Confluence page. Accepts plain text — it is automatically converted to storage format. Example: quinta-confluence_add_page_comment({page_id: '123456', body: 'Great documentation!'})",
        inputSchema: {
          type: "object",
          properties: {
            page_id: { type: "string", description: "ID of the page to comment on" },
            body: { type: "string", description: "Comment text (plain text, automatically formatted)" },
          },
          required: ["page_id", "body"],
        },
      },

      // 68. ADD PAGE LABEL
      {
        name: "quinta-confluence_add_page_label",
        description: "Add a label to a Confluence page. Example: quinta-confluence_add_page_label({page_id: '123456', label: 'needs-review'})",
        inputSchema: {
          type: "object",
          properties: {
            page_id: { type: "string", description: "ID of the page to label" },
            label: { type: "string", description: "Label name to add (lowercase, no spaces)" },
          },
          required: ["page_id", "label"],
        },
      },

      // 69. MOVE PAGE
      {
        name: "quinta-confluence_move_page",
        description: "Move a Confluence page to a different parent within the SAME space (e.g. reorganise the QUIC page tree). Cross-space moves are NOT supported by the Confluence Server REST API — those must be done via the UI (open page → ··· → Move). Example: quinta-confluence_move_page({page_id: '123456', target_parent_id: '789012'})",
        inputSchema: {
          type: "object",
          properties: {
            page_id: { type: "string", description: "ID of the page to move" },
            target_space_key: { type: "string", description: "Target space key (required for cross-space moves, e.g. 'DEV')" },
            target_parent_id: { type: "string", description: "Target parent page ID (omit to move to space root)" },
          },
          required: ["page_id"],
        },
      },
    ],
  };
});


// Tool request handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = (request.params.arguments ?? {}) as Record<string, any>;

  try {
    switch (name) {
      // 1. GET FULL ISSUE
      case "quinta-jira_get_full_issue": {
        const { issue_key } = args;
        
        if (!issue_key) {
          throw createError(
            ErrorCodes.MISSING_REQUIRED_FIELD,
            "issue_key is required",
            { provided_args: args },
            "Provide issue_key parameter (e.g., 'QT-14006')"
          );
        }

        const data = await jiraRequest(
          `/rest/api/2/issue/${encodeURIComponent(issue_key)}?expand=changelog,renderedFields`
        );

        const fullIssueRoles = await resolveAssigneeRoles(data.fields.customfield_10301);
        const resolvedCf10301 = await resolveRoleFieldEntries(data.fields.customfield_10301);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                issue: {
                  key: data.key,
                  summary: data.fields.summary,
                  status: data.fields.status?.name,
                  priority: data.fields.priority?.name,
                  assignee: data.fields.assignee?.displayName || "Unassigned",
                  reporter: data.fields.reporter?.displayName,
                  created: data.fields.created,
                  updated: data.fields.updated,
                  description: data.renderedFields?.description || data.fields.description,
                  comments: data.fields.comment?.comments?.map((c: any) => ({
                    author: c.author.displayName,
                    body: c.body,
                    created: c.created,
                  })) || [],
                  labels: data.fields.labels || [],
                  components: data.fields.components?.map((c: any) => c.name) || [],
                  story_points: data.fields.customfield_10023,
                  time_estimate: data.fields.timeestimate,
                  time_logged: data.fields.timespent,
                  custom_fields: {
                    customfield_10300: data.fields.customfield_10300, // Time logged by role (raw)
                    customfield_10301: resolvedCf10301, // Assignee roles with user tokens resolved to display names
                    customfield_10301_raw: data.fields.customfield_10301, // original unresolved values
                  },
                  assignee_roles: fullIssueRoles, // resolved display names (+ *_raw tokens)
                  tester: data.fields.customfield_10018?.displayName ?? null,
                  reviewed_by: data.fields.customfield_10020?.displayName ?? null,
                  participants: Array.isArray(data.fields.customfield_10019)
                    ? data.fields.customfield_10019.map((u: any) => u.displayName)
                    : null,
                  qa_status: data.fields.customfield_10901?.value ?? null,
                  qa_validator: data.fields.customfield_10900?.displayName ?? null,
                  frequency_tested_ko: data.fields.customfield_10705 ?? null,
                  frequency_review_ko: data.fields.customfield_10806 ?? null,
                  log_work_by_roles: data.fields.customfield_10302 ?? null,
                },
              }, null, 2),
            },
          ],
        };
      }

      // 2. SEARCH SPRINT ISSUES
      case "quinta-jira_search_sprint_issues": {
        const { project_key, sprint_name, max_results = 500 } = args;

        const escProject = escapeJqlValue(project_key);
        let jql = `project = "${escProject}" AND sprint in openSprints()`;

        if (sprint_name) {
          jql = `project = "${escProject}" AND sprint = "${escapeJqlValue(sprint_name)}"`;
        }

        jql += " ORDER BY created DESC";

        const data = await jiraRequest(
          `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=${max_results}&fields=*all`
        );

        const sprintIssues = await Promise.all(data.issues.map(async (issue: any) => ({
          key: issue.key,
          summary: issue.fields.summary,
          status: issue.fields.status?.name,
          priority: issue.fields.priority?.name,
          assignee: issue.fields.assignee?.displayName || "Unassigned",
          reporter: issue.fields.reporter?.displayName,
          created: issue.fields.created,
          updated: issue.fields.updated,
          labels: issue.fields.labels || [],
          components: issue.fields.components?.map((c: any) => c.name) || [],
          story_points: issue.fields.customfield_10023,
          assignee_roles: await resolveAssigneeRoles(issue.fields.customfield_10301),
          sprints: parseSprints(issue.fields.customfield_10008),
        })));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                total: data.total,
                returned: data.issues.length,
                truncated: data.total > data.issues.length,
                max_results,
                issues: sprintIssues,
              }, null, 2),
            },
          ],
        };
      }

      // 3. TEAM WORKLOAD
      case "quinta-jira_get_team_workload": {
        const { project_key } = args;
        
        const jql = `project = "${escapeJqlValue(project_key)}" AND sprint in openSprints() ORDER BY assignee ASC`;
        const { issues, total, truncated } = await searchAllIssues(jql, "assignee,status");

        const workload: Record<string, any> = {};
        issues.forEach((issue: any) => {
          const assignee = issue.fields.assignee?.displayName || "Unassigned";
          const status = issue.fields.status?.name || "Unknown";

          if (!workload[assignee]) {
            workload[assignee] = { total: 0, by_status: {} };
          }

          workload[assignee].total++;
          workload[assignee].by_status[status] = (workload[assignee].by_status[status] || 0) + 1;
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                total_issues: issues.length,
                total_matched: total,
                truncated,
                team_members: Object.keys(workload).length,
                workload,
              }, null, 2),
            },
          ],
        };
      }

      // 4. ANALYZE HOTFIXES
      case "quinta-jira_analyze_hotfixes": {
        const { project_key } = args;
        
        const escProject = escapeJqlValue(project_key);
        const jql = `project = "${escProject}" AND sprint in openSprints() AND (summary ~ "HOTFIX" OR summary ~ "HTOFIX") ORDER BY created DESC`;
        const { issues, total, truncated } = await searchAllIssues(jql, "summary,components,status,created");

        const byComponent: Record<string, any> = {};
        issues.forEach((issue: any) => {
          const components = issue.fields.components?.map((c: any) => c.name) || ["No Component"];
          components.forEach((comp: any) => {
            if (!byComponent[comp]) {
              byComponent[comp] = { count: 0, issues: [] };
            }
            byComponent[comp].count++;
            byComponent[comp].issues.push({
              key: issue.key,
              summary: issue.fields.summary,
              status: issue.fields.status?.name,
            });
          });
        });

        const sprintTotal = (await jiraRequest(
          `/rest/api/2/search?jql=${encodeURIComponent(`project = "${escProject}" AND sprint in openSprints()`)}&maxResults=0`
        )).total;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                total_hotfixes: total,
                gathered: issues.length,
                truncated,
                by_component: byComponent,
                hotfix_ratio: (sprintTotal ? (total / sprintTotal * 100) : 0).toFixed(2) + "%",
              }, null, 2),
            },
          ],
        };
      }

      // 5. ADVANCED SEARCH
      case "quinta-jira_search_advanced": {
        const { jql, max_results = 100 } = args;
        
        if (!jql) {
          throw createError(
            ErrorCodes.INVALID_PARAMETER,
            "JQL query is required",
            { provided_args: args },
            "Provide a valid JQL query string"
          );
        }

        const data = await jiraRequest(
          `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=${max_results}&fields=*all`
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                jql_query: jql,
                total: data.total,
                returned: data.issues.length,
                issues: data.issues.map((issue: any) =>({
                  key: issue.key,
                  summary: issue.fields.summary,
                  status: issue.fields.status?.name,
                  assignee: issue.fields.assignee?.displayName || "Unassigned",
                  priority: issue.fields.priority?.name,
                  created: issue.fields.created,
                  time_original_estimate_seconds: issue.fields.timeoriginalestimate ?? null,
                  time_spent_seconds: issue.fields.timespent ?? null,
                  time_remaining_seconds: issue.fields.timeestimate ?? null,
                  aggregate_time_spent_seconds: issue.fields.aggregatetimespent ?? null,
                })),
              }, null, 2),
            },
          ],
        };
      }

      // 6. TIME METRICS
      case "quinta-jira_get_time_metrics": {
        const { project_key } = args;
        
        const jql = `project = "${escapeJqlValue(project_key)}" AND sprint in openSprints()`;
        const { issues, total, truncated } = await searchAllIssues(jql, "summary,timeestimate,customfield_10300");

        const totals: Record<string, number> = { Developer: 0, Tester: 0, Reviewer: 0 };
        const tickets = issues.map((issue: any) =>{
          const timeByRole = parseTimeLoggedByRole(issue.fields.customfield_10300);
          
          Object.keys(timeByRole).forEach(role => {
            totals[role] += timeByRole[role];
          });

          return {
            key: issue.key,
            summary: issue.fields.summary,
            time_estimate_hours: (issue.fields.timeestimate || 0) / 3600,
            time_logged_by_role: {
              Developer: (timeByRole.Developer / 3600).toFixed(2) + "h",
              Tester: (timeByRole.Tester / 3600).toFixed(2) + "h",
              Reviewer: (timeByRole.Reviewer / 3600).toFixed(2) + "h",
            },
          };
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                total_issues: issues.length,
                total_matched: total,
                truncated,
                sprint_totals: {
                  Developer: (totals.Developer / 3600).toFixed(2) + "h",
                  Tester: (totals.Tester / 3600).toFixed(2) + "h",
                  Reviewer: (totals.Reviewer / 3600).toFixed(2) + "h",
                },
                tickets,
              }, null, 2),
            },
          ],
        };
      }

      // 7. UNASSIGNED BY ROLE
      case "quinta-jira_get_unassigned_by_role": {
        const { project_key } = args;
        
        const jql = `project = "${escapeJqlValue(project_key)}" AND sprint in openSprints()`;
        const { issues, total, truncated } = await searchAllIssues(jql, "customfield_10301");

        let unassignedDev = 0;
        let unassignedTest = 0;

        issues.forEach((issue: any) => {
          const roles = parseAssigneeRoles(issue.fields.customfield_10301);
          if (!roles.dev) unassignedDev++;
          if (!roles.test) unassignedTest++;
        });

        const pop = issues.length || 1;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                total_issues: issues.length,
                total_matched: total,
                truncated,
                unassigned_developer: unassignedDev,
                unassigned_tester: unassignedTest,
                unassigned_percentage: {
                  developer: ((unassignedDev / pop) * 100).toFixed(2) + "%",
                  tester: ((unassignedTest / pop) * 100).toFixed(2) + "%",
                },
              }, null, 2),
            },
          ],
        };
      }

      // 8. SEARCH BY LABELS
      case "quinta-jira_search_by_labels": {
        const { project_key, labels } = args;
        
        if (!labels || labels.length === 0) {
          throw createError(
            ErrorCodes.MISSING_REQUIRED_FIELD,
            "labels array is required and must not be empty",
            { provided_args: args }
          );
        }

        const results: Record<string, any> = {};

        for (const label of labels) {
          const jql = `project = "${escapeJqlValue(project_key)}" AND sprint in openSprints() AND labels = "${escapeJqlValue(label)}"`;
          const { issues, total, truncated } = await searchAllIssues(jql, "status,summary");

          const statusBreakdown: Record<string, any> = {};
          issues.forEach((issue: any) => {
            const status = issue.fields.status?.name || "Unknown";
            statusBreakdown[status] = (statusBreakdown[status] || 0) + 1;
          });

          results[label] = {
            count: total,
            gathered: issues.length,
            truncated,
            status_breakdown: statusBreakdown,
            issues: issues.map((i: any) => ({ key: i.key, summary: i.fields.summary })),
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: true, results }, null, 2),
            },
          ],
        };
      }

      // 9. RATE LIMITS
      case "quinta-jira_get_rate_limits": {
        // Rate-limit info is populated only if the server sends X-RateLimit-* headers.
        // Self-hosted Jira Data Center typically does NOT emit these headers, so the
        // values stay null — report that honestly rather than a bare "Unknown".
        const reported = rateLimitInfo.limit !== null || rateLimitInfo.remaining !== null || rateLimitInfo.reset !== null;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                headers_reported: reported,
                rate_limit: {
                  limit: rateLimitInfo.limit ?? "not reported by this Jira instance",
                  remaining: rateLimitInfo.remaining ?? "not reported by this Jira instance",
                  reset: rateLimitInfo.reset ?? "not reported by this Jira instance",
                  status: !reported ? "UNKNOWN" : (rateLimitInfo.remaining !== null && rateLimitInfo.remaining < 10 ? "WARNING" : "OK"),
                },
                note: reported ? undefined : "This Jira Data Center instance does not send X-RateLimit-* headers, so live quota values are unavailable. This is expected on most self-hosted deployments.",
              }, null, 2),
            },
          ],
        };
      }

      // 10. GET ALL LABELS
      case "quinta-jira_get_all_labels": {
        const { project_key, scope = "open_sprints" } = args;

        // Default to open sprints (fast, consistent with sibling analytics tools).
        // scope:'all' scans the entire project history (may truncate on huge projects).
        const scopeClause = scope === "all" ? "" : " AND sprint in openSprints()";
        const jql = `project = "${escapeJqlValue(project_key)}"${scopeClause}`;
        const { issues, total, truncated } = await searchAllIssues(jql, "labels");

        const labelCounts: Record<string, any> = {};
        issues.forEach((issue: any) => {
          (issue.fields.labels || []).forEach((label: any) => {
            labelCounts[label] = (labelCounts[label] || 0) + 1;
          });
        });

        const sortedLabels = Object.entries(labelCounts)
          .sort((a: any, b: any) => (b[1] as number) - (a[1] as number))
          .map(([label, count]) => ({ label, count }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                scope,
                total_unique_labels: sortedLabels.length,
                issues_scanned: issues.length,
                total_matched: total,
                truncated,
                labels: sortedLabels,
              }, null, 2),
            },
          ],
        };
      }

      // 11. TIME IN STATUS
      case "quinta-jira_get_time_in_status": {
        const { project_key } = args;
        
        const jql = `project = "${escapeJqlValue(project_key)}" AND sprint in openSprints()`;
        const { issues, total, truncated } = await searchAllIssues(jql, "status,created", { expand: "changelog" });

        const statusTimes: Record<string, any> = {};

        issues.forEach((issue: any) => {
          const changelog = issue.changelog?.histories || [];
          let currentStatus = issue.fields.status?.name;
          let currentTime = new Date(issue.fields.created || issue.fields?.created).getTime();

          changelog.forEach((history: any) => {
            const statusChange = history.items.find((item: any) => item.field === "status");
            if (statusChange) {
              const changeTime = new Date(history.created).getTime();
              const duration = changeTime - currentTime;

              if (!statusTimes[currentStatus]) {
                statusTimes[currentStatus] = { total_ms: 0, count: 0 };
              }
              statusTimes[currentStatus].total_ms += duration;
              statusTimes[currentStatus].count++;

              currentStatus = statusChange.toString;
              currentTime = changeTime;
            }
          });
        });

        const averages = Object.entries(statusTimes).map(([status, statusData]: [string, any]) => ({
          status,
          average_hours: (statusData.total_ms / statusData.count / 1000 / 3600).toFixed(2),
          issue_count: statusData.count,
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                issues_scanned: issues.length,
                total_matched: total,
                truncated,
                averages,
              }, null, 2),
            },
          ],
        };
      }

      // 12. LIST SPRINTS
      case "quinta-jira_list_sprints": {
        const { project_key, board_id } = args;
        
        if (!board_id) {
          // Fallback: Extract sprint info from issues when board_id is not provided.
          // Scan a sizable sample (not just one issue) so all open sprints surface;
          // dedup by sprint id below. This is a best-effort sampled list — pass
          // board_id for an authoritative sprint enumeration via the Agile API.
          const jql = `project = "${escapeJqlValue(project_key)}" AND sprint in openSprints()`;
          const { issues } = await searchAllIssues(jql, "customfield_10008", { hardCap: 500 });

          const sprintsMap = new Map();
          issues.forEach((issue: any) => {
            const sprints = parseSprints(issue.fields.customfield_10008);
            sprints.forEach(sprint => {
              if (sprint && sprint.id && !sprintsMap.has(sprint.id)) {
                sprintsMap.set(sprint.id, {
                  id: sprint.id,
                  name: sprint.name,
                  state: sprint.state,
                  start_date: sprint.startDate,
                  end_date: sprint.endDate,
                  goal: sprint.goal,
                });
              }
            });
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  source: "extracted_from_issues",
                  note: "Sampled from up to 500 open-sprint issues; pass board_id for an authoritative list.",
                  sprints: Array.from(sprintsMap.values()),
                }, null, 2),
              },
            ],
          };
        }

        const data = await jiraRequest(`/rest/agile/1.0/board/${board_id}/sprint`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                sprints: data.values.map((sprint: any) =>({
                  id: sprint.id,
                  name: sprint.name,
                  state: sprint.state,
                  start_date: sprint.startDate,
                  end_date: sprint.endDate,
                  goal: sprint.goal,
                })),
              }, null, 2),
            },
          ],
        };
      }

      // 13. CREATE ISSUE
      case "quinta-jira_create_issue": {
        const {
          project_key, summary, description, issue_type = "Task", priority,
          assignee, labels, time_estimate, reviewer_key, tester_key,
          components, fix_versions, due_date, epic_link, parent_key,
          sprint_id, story_points, epic_name,
          // Legacy support
          time_estimate_seconds,
        } = args;

        if (!project_key) {
          throw createError(ErrorCodes.MISSING_REQUIRED_FIELD, "project_key is required");
        }
        if (!summary) {
          throw createError(ErrorCodes.MISSING_REQUIRED_FIELD, "summary is required");
        }

        const createPayload: any = {
          fields: {
            project: { key: project_key },
            summary,
            description: description || "",
            issuetype: { name: issue_type },
          },
        };

        // Fields that can be set at creation time
        if (priority) createPayload.fields.priority = { name: priority };
        if (due_date) createPayload.fields.duedate = due_date;
        if (components && components.length > 0) {
          createPayload.fields.components = components.map((c: string) => ({ name: c }));
        }
        if (fix_versions && fix_versions.length > 0) {
          createPayload.fields.fixVersions = fix_versions.map((v: string) => ({ name: v }));
        }
        if (parent_key) createPayload.fields.parent = { key: parent_key };
        if (epic_name) createPayload.fields.customfield_10003 = epic_name;

        const data = await jiraRequest("/rest/api/2/issue", {
          method: "POST",
          body: JSON.stringify(createPayload),
        });

        const issueKey = data.key;
        const issueUrl = `${JIRA_BASE_URL}/browse/${issueKey}`;
        const appliedFields: string[] = ["project", "summary", "issuetype"];
        const warnings: Array<{ field: string; reason: string; raw_error?: any }> = [];

        if (priority) appliedFields.push("priority");
        if (due_date) appliedFields.push("duedate");
        if (components && components.length > 0) appliedFields.push("components");
        if (fix_versions && fix_versions.length > 0) appliedFields.push("fixVersions");
        if (parent_key) appliedFields.push("parent");

        // Post-creation field updates (batched where possible)
        const postCreateFields: any = {};
        if (assignee) postCreateFields.assignee = { name: assignee };
        if (labels && labels.length > 0) postCreateFields.labels = labels;
        if (reviewer_key) postCreateFields.customfield_10020 = { name: reviewer_key };
        if (tester_key) postCreateFields.customfield_10018 = { name: tester_key };
        if (story_points !== undefined) postCreateFields.customfield_10023 = story_points;
        if (epic_link) postCreateFields.customfield_10006 = epic_link;

        // Time estimate: must be sent via update block (not fields block)
        const timeEstStr = time_estimate || (time_estimate_seconds ? `${time_estimate_seconds}s` : null);
        let postCreateUpdateBlock: any = {};
        if (timeEstStr) {
          postCreateUpdateBlock.timetracking = [{ set: { originalEstimate: timeEstStr } }];
        }

        if (Object.keys(postCreateFields).length > 0 || Object.keys(postCreateUpdateBlock).length > 0) {
          const postPayload: any = {};
          if (Object.keys(postCreateFields).length > 0) postPayload.fields = postCreateFields;
          if (Object.keys(postCreateUpdateBlock).length > 0) postPayload.update = postCreateUpdateBlock;

          try {
            await jiraRequest(`/rest/api/2/issue/${issueKey}`, {
              method: "PUT",
              body: JSON.stringify(postPayload),
            });
            appliedFields.push(...Object.keys(postCreateFields));
            if (postCreateUpdateBlock.timetracking) appliedFields.push("timetracking");
          } catch (batchErr: any) {
            // If batch fails, try each field individually
            for (const [fieldName, fieldValue] of Object.entries(postCreateFields)) {
              try {
                await jiraRequest(`/rest/api/2/issue/${issueKey}`, {
                  method: "PUT",
                  body: JSON.stringify({ fields: { [fieldName]: fieldValue } }),
                });
                appliedFields.push(fieldName);
              } catch (fieldErr: any) {
                let rawErr = fieldErr.error_message || fieldErr.message || String(fieldErr);
                if (fieldErr.details) rawErr = fieldErr.details;
                warnings.push({ field: fieldName, reason: rawErr, raw_error: fieldErr });
              }
            }
            // Try timetracking separately via update block
            if (postCreateUpdateBlock.timetracking) {
              try {
                await jiraRequest(`/rest/api/2/issue/${issueKey}`, {
                  method: "PUT",
                  body: JSON.stringify({ update: postCreateUpdateBlock }),
                });
                appliedFields.push("timetracking");
              } catch (ttErr: any) {
                warnings.push({ field: "timetracking", reason: ttErr.error_message || ttErr.message || String(ttErr) });
              }
            }
          }
        }

        // Sprint assignment via Agile API (cannot be done via regular field update)
        if (sprint_id) {
          try {
            await jiraRequest(`/rest/agile/1.0/sprint/${sprint_id}/issue`, {
              method: "POST",
              body: JSON.stringify({ issues: [issueKey] }),
            });
            appliedFields.push("sprint");
          } catch (e: any) {
            warnings.push({ field: "sprint", reason: e.error_message || e.message || String(e) });
          }
        }

        const createResult: any = {
          success: true,
          issue_key: issueKey,
          issue_id: data.id,
          issue_url: issueUrl,
          self: data.self,
          applied_fields: appliedFields,
        };
        if (warnings.length > 0) {
          createResult.warnings = warnings;
          // The issue was created but one or more secondary fields failed to apply.
          createResult.partial_success = true;
        }

        return {
          content: [{ type: "text", text: JSON.stringify(createResult, null, 2) }],
        };
      }

      // 14. UPDATE ISSUE
      case "quinta-jira_update_issue": {
        const { issue_key, fields } = args;

        if (!isValidIssueKey(issue_key)) {
          throw createError(ErrorCodes.MISSING_REQUIRED_FIELD, "issue_key is required and must look like 'PROJ-123'");
        }
        if (!fields || Object.keys(fields).length === 0) {
          throw createError(
            ErrorCodes.MISSING_REQUIRED_FIELD,
            "fields object is required with at least one field to update"
          );
        }

        // Separate timetracking from regular fields — it must go in the "update" block
        const regularFields: any = {};
        const updateBlock: any = {};
        for (const [k, v] of Object.entries(fields)) {
          if (k === "timetracking") {
            updateBlock.timetracking = [{ set: v }];
          } else if (k === "timeOriginalEstimate" || k === "timeoriginalestimate") {
            // Convenience: accept timeOriginalEstimate as a shorthand
            updateBlock.timetracking = [{ set: { originalEstimate: v } }];
          } else {
            regularFields[k] = v;
          }
        }

        const putPayload: any = {};
        if (Object.keys(regularFields).length > 0) putPayload.fields = regularFields;
        if (Object.keys(updateBlock).length > 0) putPayload.update = updateBlock;

        // Try batch update first
        try {
          await jiraRequest(`/rest/api/2/issue/${issue_key}`, {
            method: "PUT",
            body: JSON.stringify(putPayload),
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  message: `Issue ${issue_key} updated successfully`,
                  updated_fields: Object.keys(fields),
                }, null, 2),
              },
            ],
          };
        } catch (batchErr: any) {
          // If batch fails and we have multiple fields, try each individually
          if (Object.keys(fields).length > 1) {
            const succeeded: string[] = [];
            const failed: Array<{ field: string; reason: any }> = [];

            for (const [fieldName, fieldValue] of Object.entries(fields)) {
              try {
                let singlePayload: any;
                if (fieldName === "timetracking") {
                  singlePayload = { update: { timetracking: [{ set: fieldValue }] } };
                } else if (fieldName === "timeOriginalEstimate" || fieldName === "timeoriginalestimate") {
                  singlePayload = { update: { timetracking: [{ set: { originalEstimate: fieldValue } }] } };
                } else {
                  singlePayload = { fields: { [fieldName]: fieldValue } };
                }
                await jiraRequest(`/rest/api/2/issue/${issue_key}`, {
                  method: "PUT",
                  body: JSON.stringify(singlePayload),
                });
                succeeded.push(fieldName);
              } catch (fieldErr: any) {
                failed.push({
                  field: fieldName,
                  reason: fieldErr.details || fieldErr.error_message || fieldErr.message || String(fieldErr),
                });
              }
            }

            if (succeeded.length > 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      partial_success: true,
                      message: `Issue ${issue_key} partially updated`,
                      updated_fields: succeeded,
                      failed_fields: failed,
                    }, null, 2),
                  },
                ],
              };
            }
            // All individual attempts failed — report all errors
            throw createError(
              ErrorCodes.JIRA_API_ERROR,
              `All field updates failed for ${issue_key}`,
              { failed_fields: failed, batch_error: batchErr.details || batchErr.error_message || batchErr.message }
            );
          }
          throw batchErr;
        }
      }

      // 15. TRANSITION ISSUE
      case "quinta-jira_transition_issue": {
        const { issue_key, transition_id, fields } = args;

        if (!isValidIssueKey(issue_key)) {
          throw createError(ErrorCodes.MISSING_REQUIRED_FIELD, "issue_key is required and must look like 'PROJ-123'");
        }
        if (!transition_id) {
          throw createError(
            ErrorCodes.MISSING_REQUIRED_FIELD,
            "transition_id is required",
            {},
            "Use quinta-jira_get_transitions to get available transition IDs"
          );
        }

        // Build the transition body. Include "fields" only when provided so that
        // transition-screen-only fields (e.g. resolution) can be set atomically
        // with the transition; existing callers that omit fields are unaffected.
        const transitionBody: any = { transition: { id: transition_id } };
        if (fields && typeof fields === "object" && Object.keys(fields).length > 0) {
          transitionBody.fields = fields;
        }

        await jiraRequest(`/rest/api/2/issue/${issue_key}/transitions`, {
          method: "POST",
          body: JSON.stringify(transitionBody),
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: `Issue ${issue_key} transitioned successfully`,
                fields_set: transitionBody.fields ? Object.keys(transitionBody.fields) : [],
              }, null, 2),
            },
          ],
        };
      }

      // 16. ADD COMMENT
      case "quinta-jira_add_comment": {
        const { issue_key, body } = args;

        if (!isValidIssueKey(issue_key)) {
          throw createError(ErrorCodes.MISSING_REQUIRED_FIELD, "issue_key is required and must look like 'PROJ-123'");
        }
        if (!body) {
          throw createError(
            ErrorCodes.MISSING_REQUIRED_FIELD,
            "comment body is required"
          );
        }

        const data = await jiraRequest(`/rest/api/2/issue/${issue_key}/comment`, {
          method: "POST",
          body: JSON.stringify({ body }),
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                comment_id: data.id,
                author: data.author?.displayName ?? null,
                created: data.created,
              }, null, 2),
            },
          ],
        };
      }

      // 17. ADD ATTACHMENT
      case "quinta-jira_add_attachment": {
        const { issue_key, file_path, source_url } = args;
        let { filename, content_base64 } = args;

        const sourceCount = [file_path, source_url, content_base64].filter(Boolean).length;
        if (sourceCount === 0) {
          throw createError(
            ErrorCodes.MISSING_REQUIRED_FIELD,
            "Provide exactly one content source: file_path, source_url, or content_base64"
          );
        }
        if (sourceCount > 1) {
          throw createError(
            ErrorCodes.INVALID_PARAMETER,
            "Provide only one content source: file_path, source_url, or content_base64 — not more than one"
          );
        }
        if (content_base64 && !filename) {
          throw createError(
            ErrorCodes.MISSING_REQUIRED_FIELD,
            "filename is required when using content_base64"
          );
        }

        let fileBuffer: Buffer;
        if (file_path) {
          const stats = await stat(file_path).catch((err: any) => {
            throw createError(
              ErrorCodes.INVALID_PARAMETER,
              `Cannot read file_path: ${err.message}`,
              { file_path },
              "Verify the path exists and is readable by the machine running this MCP server"
            );
          });
          if (stats.size > ATTACHMENT_UPLOAD_MAX_BYTES) {
            throw createError(
              ErrorCodes.INVALID_PARAMETER,
              `File too large to upload (${(stats.size / 1024 / 1024).toFixed(2)} MB). Max is ${(ATTACHMENT_UPLOAD_MAX_BYTES / 1024 / 1024).toFixed(0)} MB (configurable via ATTACHMENT_MAX_UPLOAD_MB).`,
              { size_bytes: stats.size, max_bytes: ATTACHMENT_UPLOAD_MAX_BYTES }
            );
          }
          fileBuffer = await readFile(file_path);
          filename = filename || inferFilenameFromPathOrUrl(file_path);
        } else if (source_url) {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
          let fetchResp: Response;
          try {
            fetchResp = await fetch(source_url, { signal: ctrl.signal });
          } catch (err: any) {
            throw createError(
              ErrorCodes.NETWORK_ERROR,
              err.name === "AbortError"
                ? `Timed out downloading source_url after ${REQUEST_TIMEOUT_MS}ms`
                : `Failed to download source_url: ${err.message}`,
              { source_url }
            );
          } finally {
            clearTimeout(timer);
          }
          if (!fetchResp.ok) {
            await drainResponseBody(fetchResp);
            throw createError(
              ErrorCodes.JIRA_API_ERROR,
              `Failed to download source_url: HTTP ${fetchResp.status}`,
              { status: fetchResp.status, source_url }
            );
          }
          fileBuffer = await readBodyWithSizeCap(fetchResp, ATTACHMENT_UPLOAD_MAX_BYTES);
          filename = filename || inferFilenameFromPathOrUrl(source_url);
        } else {
          fileBuffer = Buffer.from(content_base64, "base64");
        }

        const safeFilename = sanitizeAttachmentFilename(filename);
        const contentType = guessMimeType(safeFilename);

        // Build proper multipart/form-data manually (Jira DC requires field name "file")
        const boundary = `----JiraMCPBoundary${Date.now()}`;
        const CRLF = "\r\n";
        const multipartParts = [
          `--${boundary}${CRLF}`,
          `Content-Disposition: form-data; name="file"; filename="${safeFilename}"${CRLF}`,
          `Content-Type: ${contentType}${CRLF}`,
          CRLF,
        ];
        const headerBuf = Buffer.from(multipartParts.join(""), "utf-8");
        const footerBuf = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, "utf-8");
        const multipartBody = Buffer.concat([headerBuf, fileBuffer, footerBuf]);

        const attachUrl = `${JIRA_BASE_URL}/rest/api/2/issue/${issue_key}/attachments`;
        const attachResp = await fetch(attachUrl, {
          method: "POST",
          headers: {
            "Authorization": JIRA_AUTH_TYPE === 'basic'
              ? `Basic ${Buffer.from(`${JIRA_USER_EMAIL}:${JIRA_PAT}`).toString('base64')}`
              : `Bearer ${JIRA_PAT}`,
            "X-Atlassian-Token": "no-check",
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
          },
          body: multipartBody,
        });

        if (!attachResp.ok) {
          const errText = await attachResp.text();
          throw createError(
            ErrorCodes.JIRA_API_ERROR,
            `Attachment upload failed: ${attachResp.status}`,
            { status: attachResp.status, response: errText }
          );
        }

        const attachData = await attachResp.json();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: `Attachment ${safeFilename} added to ${issue_key}`,
                attachments: Array.isArray(attachData) ? attachData.map((a: any) => ({
                  id: a.id,
                  filename: a.filename,
                  size: a.size,
                  mimeType: a.mimeType,
                  content: a.content,
                })) : attachData,
              }, null, 2),
            },
          ],
        };
      }

      // 18. GET EPIC CHILDREN
      case "quinta-jira_get_epic_children": {
        const { epic_key, max_results = 100 } = args;

        const jql = `"Epic Link" = "${escapeJqlValue(epic_key)}"`;
        const data = await jiraRequest(
          `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=${max_results}&fields=summary,status,assignee,customfield_10023`
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                epic_key,
                total_children: data.total,
                returned: data.issues.length,
                truncated: data.total > data.issues.length,
                children: data.issues.map((issue: any) =>({
                  key: issue.key,
                  summary: issue.fields.summary,
                  status: issue.fields.status?.name,
                  assignee: issue.fields.assignee?.displayName || "Unassigned",
                  story_points: issue.fields.customfield_10023,
                })),
              }, null, 2),
            },
          ],
        };
      }

      // 19. GET TRANSITIONS
      case "quinta-jira_get_transitions": {
        const { issue_key } = args;
        
        const data = await jiraRequest(`/rest/api/2/issue/${issue_key}/transitions`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                issue_key,
                available_transitions: data.transitions.map((t: any) => ({
                  id: t.id,
                  name: t.name,
                  to_status: t.to?.name,
                })),
              }, null, 2),
            },
          ],
        };
      }

      // 20. GET CUSTOM FIELDS
      case "quinta-jira_get_custom_fields": {
        const data = await jiraRequest("/rest/api/2/field");

        const customFields = data
          .filter((field: any) => field.id.startsWith("customfield_"))
          .map((field: any) =>({
            id: field.id,
            name: field.name,
            type: field.schema?.type,
          }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                total_custom_fields: customFields.length,
                custom_fields: customFields,
              }, null, 2),
            },
          ],
        };
      }

      // 21. SEARCH BY ASSIGNEE
      case "quinta-jira_search_by_assignee": {
        const { project_key, assignee_names } = args;
        
        if (!assignee_names || assignee_names.length === 0) {
          throw createError(
            ErrorCodes.MISSING_REQUIRED_FIELD,
            "assignee_names array is required"
          );
        }

        const results: Record<string, any> = {};

        for (const name of assignee_names) {
          const jql = `project = "${escapeJqlValue(project_key)}" AND sprint in openSprints() AND assignee = "${escapeJqlValue(name)}"`;
          const data = await jiraRequest(
            `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=500&fields=summary,status`
          );

          results[name] = {
            count: data.total,
            returned: data.issues.length,
            truncated: data.total > data.issues.length,
            issues: data.issues.map((i: any) => ({
              key: i.key,
              summary: i.fields.summary,
              status: i.fields.status?.name,
            })),
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: true, results }, null, 2),
            },
          ],
        };
      }

      // 22. GET STATUS DISTRIBUTION
      case "quinta-jira_get_status_distribution": {
        const { project_key } = args;
        
        const jql = `project = "${escapeJqlValue(project_key)}" AND sprint in openSprints()`;
        const { issues, total, truncated } = await searchAllIssues(jql, "status");

        const distribution: Record<string, any> = {};
        issues.forEach((issue: any) => {
          const status = issue.fields.status?.name || "Unknown";
          distribution[status] = (distribution[status] || 0) + 1;
        });

        const pop = issues.length || 1;
        const stats = Object.entries(distribution).map(([status, count]: [string, any]) => ({
          status,
          count,
          percentage: ((count / pop) * 100).toFixed(2) + "%",
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                total_issues: issues.length,
                total_matched: total,
                truncated,
                distribution: stats,
              }, null, 2),
            },
          ],
        };
      }

      // 23. GET REPORTER STATS
      case "quinta-jira_get_reporter_stats": {
        const { project_key } = args;
        
        const jql = `project = "${escapeJqlValue(project_key)}" AND sprint in openSprints()`;
        const { issues, total, truncated } = await searchAllIssues(jql, "reporter");

        const reporterCounts: Record<string, any> = {};
        issues.forEach((issue: any) => {
          const reporter = issue.fields.reporter?.displayName || "Unknown";
          reporterCounts[reporter] = (reporterCounts[reporter] || 0) + 1;
        });

        const pop = issues.length || 1;
        const stats = Object.entries(reporterCounts)
          .map(([reporter, count]: [string, any]) => ({
            reporter,
            count,
            percentage: ((count / pop) * 100).toFixed(2) + "%",
          }))
          .sort((a: any, b: any) => (b.count as number) - (a.count as number));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                total_issues: issues.length,
                total_matched: total,
                truncated,
                unique_reporters: stats.length,
                reporters: stats,
              }, null, 2),
            },
          ],
        };
      }

      // 24. GET ISSUE LINKS
      case "quinta-jira_get_issue_links": {
        const { issue_key } = args;
        
        const data = await jiraRequest(`/rest/api/2/issue/${issue_key}`);

        const links = (data.fields.issuelinks || []).map((link: any) =>{
          if (link.outwardIssue) {
            return {
              type: link.type.outward,
              linked_issue: link.outwardIssue.key,
              summary: link.outwardIssue.fields.summary,
              status: link.outwardIssue.fields.status?.name,
            };
          } else if (link.inwardIssue) {
            return {
              type: link.type.inward,
              linked_issue: link.inwardIssue.key,
              summary: link.inwardIssue.fields.summary,
              status: link.inwardIssue.fields.status?.name,
            };
          }
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                issue_key,
                total_links: links.length,
                links,
              }, null, 2),
            },
          ],
        };
      }

      // 25. GET ISSUE HISTORY
      case "quinta-jira_get_issue_history": {
        const { issue_key } = args;
        
        const data = await jiraRequest(`/rest/api/2/issue/${issue_key}?expand=changelog`);

        const history = (data.changelog?.histories || []).map((change: any) =>({
          author: change.author.displayName,
          created: change.created,
          changes: change.items.map((item: any) =>({
            field: item.field,
            from: item.fromString,
            to: item.toString,
          })),
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                issue_key,
                total_changes: history.length,
                history,
              }, null, 2),
            },
          ],
        };
      }

      // 26. GET SPRINT VELOCITY
      case "quinta-jira_get_sprint_velocity": {
        const { project_key, board_id } = args;
        const spField: string = args.story_points_field || "customfield_10023";
        const sprintCount = Math.max(1, Number(args.sprint_count) > 0 ? Number(args.sprint_count) : 3);

        // 1. Resolve a scrum board for the project (unless one was given).
        let boardId = board_id;
        if (!boardId) {
          const boards = await jiraRequest(`/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(project_key)}&maxResults=50`);
          const values = boards.values ?? [];
          const scrum = values.find((b: any) => b.type === "scrum") ?? values[0];
          if (!scrum) {
            throw createError(
              ErrorCodes.SPRINT_NOT_FOUND,
              `No board found for project ${project_key}`,
              { project_key },
              "Pass board_id explicitly, or verify the project has an associated scrum board"
            );
          }
          boardId = scrum.id;
        }

        // 2. Get closed sprints for the board, newest first, take the last N.
        const sprintsResp = await jiraRequest(`/rest/agile/1.0/board/${boardId}/sprint?state=closed&maxResults=50`);
        const closed = (sprintsResp.values ?? [])
          .sort((a: any, b: any) => new Date(b.completeDate || b.endDate || 0).getTime() - new Date(a.completeDate || a.endDate || 0).getTime())
          .slice(0, sprintCount);

        if (closed.length === 0) {
          return { content: [{ type: "text", text: JSON.stringify({
            success: true, board_id: boardId, sprints_analyzed: 0,
            message: "No closed sprints found for this board.",
          }, null, 2) }] };
        }

        // 3. For each sprint, sum committed vs completed story points.
        const perSprint: any[] = [];
        for (const sp of closed) {
          let startAt = 0, total = 0, committed = 0, completed = 0, counted = 0;
          for (let i = 0; i < 100; i++) {
            const issuesResp = await jiraRequest(`/rest/agile/1.0/sprint/${sp.id}/issue?fields=${spField},status&maxResults=100&startAt=${startAt}`);
            total = issuesResp.total ?? 0;
            const batch = issuesResp.issues ?? [];
            for (const issue of batch) {
              const pts = Number(issue.fields?.[spField]) || 0;
              committed += pts;
              counted++;
              if (issue.fields?.status?.statusCategory?.key === "done") completed += pts;
            }
            startAt += batch.length;
            if (batch.length === 0 || startAt >= total) break;
          }
          perSprint.push({
            sprint_id: sp.id,
            name: sp.name,
            completed_at: sp.completeDate || sp.endDate || null,
            issues: counted,
            committed_points: committed,
            completed_points: completed,
          });
        }

        const avg = perSprint.reduce((s, x) => s + x.completed_points, 0) / perSprint.length;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                board_id: boardId,
                story_points_field: spField,
                sprints_analyzed: perSprint.length,
                average_velocity: Math.round(avg * 100) / 100,
                sprints: perSprint,
                note: "committed = story points of all issues in the sprint at query time; completed = points in a Done status category. If points look wrong, pass the correct story_points_field.",
              }, null, 2),
            },
          ],
        };
      }

      // 27. GET BLOCKED TICKETS
      case "quinta-jira_get_blocked_tickets": {
        const { project_key } = args;
        
        const jql = `project = "${escapeJqlValue(project_key)}" AND sprint in openSprints() AND (status = Blocked OR labels = blocked)`;
        const data = await jiraRequest(
          `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=500&fields=summary,status,assignee,priority`
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                total_blocked: data.total,
                blocked_issues: data.issues.map((issue: any) =>({
                  key: issue.key,
                  summary: issue.fields.summary,
                  status: issue.fields.status?.name,
                  assignee: issue.fields.assignee?.displayName || "Unassigned",
                  priority: issue.fields.priority?.name,
                })),
              }, null, 2),
            },
          ],
        };
      }

      // 28. GET PRIORITY BREAKDOWN
      case "quinta-jira_get_priority_breakdown": {
        const { project_key } = args;
        
        const jql = `project = "${escapeJqlValue(project_key)}" AND sprint in openSprints()`;
        const { issues, total, truncated } = await searchAllIssues(jql, "priority");

        const priorities: Record<string, any> = {};
        issues.forEach((issue: any) => {
          const priority = issue.fields.priority?.name || "None";
          priorities[priority] = (priorities[priority] || 0) + 1;
        });

        const pop = issues.length || 1;
        const breakdown = Object.entries(priorities).map(([priority, count]: [string, any]) => ({
          priority,
          count,
          percentage: ((count / pop) * 100).toFixed(2) + "%",
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                total_issues: issues.length,
                total_matched: total,
                truncated,
                breakdown,
              }, null, 2),
            },
          ],
        };
      }

      // 29. GET COMPONENT BREAKDOWN
      case "quinta-jira_get_component_breakdown": {
        const { project_key } = args;
        
        const jql = `project = "${escapeJqlValue(project_key)}" AND sprint in openSprints()`;
        const { issues, total, truncated } = await searchAllIssues(jql, "components");

        const components: Record<string, any> = {};
        issues.forEach((issue: any) => {
          const comps = issue.fields.components?.map((c: any) => c.name) || ["No Component"];
          comps.forEach((comp: any) => {
            components[comp] = (components[comp] || 0) + 1;
          });
        });

        const pop = issues.length || 1;
        const breakdown = Object.entries(components)
          .map(([component, count]: [string, any]) => ({
            component,
            count,
            percentage: ((count / pop) * 100).toFixed(2) + "%",
          }))
          .sort((a: any, b: any) => (b.count as number) - (a.count as number));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                total_issues: issues.length,
                total_matched: total,
                truncated,
                breakdown,
              }, null, 2),
            },
          ],
        };
      }

      // 30. BULK TRANSITION
      case "quinta-jira_bulk_transition": {
        const { issue_keys, transition_id, fields } = args;

        if (!issue_keys || issue_keys.length === 0) {
          throw createError(
            ErrorCodes.MISSING_REQUIRED_FIELD,
            "issue_keys array is required"
          );
        }
        if (!transition_id) {
          throw createError(
            ErrorCodes.MISSING_REQUIRED_FIELD,
            "transition_id is required"
          );
        }

        // Apply the same optional transition-screen fields (e.g. resolution) to
        // every issue in the batch. Omitted when not provided (backward compatible).
        const hasFields = fields && typeof fields === "object" && Object.keys(fields).length > 0;

        const results = [];
        for (const key of issue_keys) {
          try {
            const body: any = { transition: { id: transition_id } };
            if (hasFields) body.fields = fields;
            await jiraRequest(`/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, {
              method: "POST",
              body: JSON.stringify(body),
            });
            results.push({ issue_key: key, success: true });
          } catch (error: any) {
            results.push({ issue_key: key, success: false, error: error.error_message });
          }
        }

        const failed = results.filter(r => !r.success).length;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: failed === 0,
                total_processed: issue_keys.length,
                succeeded: issue_keys.length - failed,
                failed,
                fields_set: hasFields ? Object.keys(fields) : [],
                results,
              }, null, 2),
            },
          ],
        };
      }

      // 31. GET SPRINT KPI DATA
      case "quinta-jira_get_sprint_kpi_data": {
        const { project_key, sprint_name, max_results = 1000 } = args;

        const escProject = escapeJqlValue(project_key);
        let jql = `project = "${escProject}" AND sprint in openSprints()`;
        if (sprint_name) {
          jql = `project = "${escProject}" AND sprint = "${escapeJqlValue(sprint_name)}"`;
        }

        const data = await jiraRequest(
          `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=${max_results}&fields=*all`
        );

        // Parse customfield_10302 (log work by roles) into {Developer, Tester, Reviewer} seconds map.
        // Format is one "Role seconds (display)" entry per line, e.g. "Developer 43200 (1d 4h)".
        const parseLogWorkByRoles = (cf10302: any): Record<string, number> | null => {
          if (cf10302 === null || cf10302 === undefined) return null;
          const raw = typeof cf10302 === "string" ? cf10302 : String(cf10302);
          if (!raw.trim()) return null;
          const result: Record<string, number> = { Developer: 0, Tester: 0, Reviewer: 0 };
          for (const line of raw.split("\n")) {
            const match = line.trim().match(/^(\w+)\s+(\d+)/);
            if (match) {
              result[match[1]] = parseInt(match[2], 10);
            }
          }
          return result;
        };

        // Pre-resolve all assignee-role user tokens so the map below can read
        // display names from cache synchronously.
        await prewarmRoleNames(data.issues);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                total: data.total,
                returned: data.issues.length,
                truncated: data.total > data.issues.length,
                issues: data.issues.map((issue: any) =>({
                  key: issue.key,
                  summary: issue.fields.summary,
                  status: issue.fields.status?.name,
                  priority: issue.fields.priority?.name,
                  assignee: issue.fields.assignee?.displayName || "Unassigned",
                  reporter: issue.fields.reporter?.displayName,
                  labels: issue.fields.labels || [],
                  issue_type: issue.fields.issuetype?.name,
                  story_points: issue.fields.customfield_10023,
                  time_estimate_seconds: issue.fields.timeestimate,        // DEPRECATED — use time_remaining_seconds
                  time_remaining_seconds: issue.fields.timeestimate,       // Correct name (remaining estimate)
                  time_original_estimate_seconds: issue.fields.timeoriginalestimate,  // Original estimate (never changes)
                  time_spent_seconds: issue.fields.timespent,
                  frequency_tested_ko: issue.fields.customfield_10705 || 0,
                  frequency_review_ko: issue.fields.customfield_10806 || 0,
                  time_tracking_by_roles: parseTimeLoggedByRole(issue.fields.customfield_10300),
                  assignee_roles: resolveAssigneeRolesCached(issue.fields.customfield_10301),
                  sprints: parseSprints(issue.fields.customfield_10008),
                  // --- NEW FIELDS ---
                  tester: issue.fields.customfield_10018?.displayName ?? null,
                  reviewed_by: issue.fields.customfield_10020?.displayName ?? null,
                  log_work_by_roles: parseLogWorkByRoles(issue.fields.customfield_10302),
                  created: issue.fields.created ?? null,
                  qa_status: issue.fields.customfield_10901?.value ?? null,
                  qa_validator: issue.fields.customfield_10900?.displayName ?? null,
                })),
              }, null, 2),
            },
          ],
        };
      }

      // 32. LIST BOARDS (Discovery Suite)
      case "quinta-jira_list_boards": {
        const { name, project_key } = args;
        const params = new URLSearchParams();
        
        if (name) params.append("name", name);
        if (project_key) params.append("projectKeyOrId", project_key);
        
        const data = await jiraRequest(`/rest/agile/1.0/board?${params.toString()}`);
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                total: data.values.length,
                boards: data.values.map((b: any) => ({
                  id: b.id,
                  name: b.name,
                  type: b.type,
                  location: b.location?.name,
                })),
              }, null, 2),
            },
          ],
        };
      }

      // 33. GET BOARD (Discovery Suite)
      case "quinta-jira_get_board": {
        const { board_id } = args;
        
        if (!board_id) {
          throw createError(
            ErrorCodes.MISSING_REQUIRED_FIELD,
            "board_id is required",
            { provided_args: args },
            "Provide board_id parameter (get from list_boards)"
          );
        }
        
        const data = await jiraRequest(`/rest/agile/1.0/board/${board_id}`);
        
        // Try to get configuration (may not be available for all boards)
        let config = {};
        try {
          config = await jiraRequest(`/rest/agile/1.0/board/${board_id}/configuration`);
        } catch (error: any) {
          // Configuration not available, continue without it
        }
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                board: data,
                configuration: config,
              }, null, 2),
            },
          ],
        };
      }

      // 34. GET SPRINT (Discovery Suite)
      case "quinta-jira_get_sprint": {
        const { sprint_id } = args;
        
        if (!sprint_id) {
          throw createError(
            ErrorCodes.MISSING_REQUIRED_FIELD,
            "sprint_id is required",
            { provided_args: args },
            "Provide sprint_id parameter (get from list_sprints or list_boards)"
          );
        }
        
        const data = await jiraRequest(`/rest/agile/1.0/sprint/${sprint_id}`);
        
        // Calculate duration metrics if dates are available
        let duration = null;
        if (data.startDate && data.endDate) {
          const calendarDays = Math.ceil((new Date(data.endDate).getTime() - new Date(data.startDate).getTime()) / 86400000);
          const workingDays = calculateWorkingDays(data.startDate, data.endDate);
          
          duration = {
            calendar_days: calendarDays,
            working_days: workingDays,
          };
        }
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                sprint: {
                  ...data,
                  duration_metrics: duration,
                },
              }, null, 2),
            },
          ],
        };
      }

      // 35. GET TESTER WORKLOAD
      case "quinta-jira_get_tester_workload": {
        const { project_key } = args;

        const jql = `project = "${escapeJqlValue(project_key)}" AND sprint in openSprints()`;
        const { issues, total, truncated } = await searchAllIssues(jql, "status,customfield_10018,customfield_10705,customfield_10008");

        let sprintName = "Current Sprint";
        if (issues.length > 0) {
          const sprintRaw = issues[0].fields?.customfield_10008;
          if (sprintRaw && Array.isArray(sprintRaw) && sprintRaw.length > 0) {
            const parsed = parseSprint(sprintRaw[0]);
            if (parsed?.name) sprintName = parsed.name;
          }
        }

        const testers: Record<string, any> = {};
        const unassignedTester: { total: number; frequency_tested_ko_total: number; by_status: Record<string, number> } = {
          total: 0,
          frequency_tested_ko_total: 0,
          by_status: {},
        };

        issues.forEach((issue: any) => {
          const testerName = issue.fields.customfield_10018?.displayName ?? null;
          const status = issue.fields.status?.name || "Unknown";
          const freq = issue.fields.customfield_10705 ?? 0;

          if (!testerName) {
            unassignedTester.total++;
            unassignedTester.frequency_tested_ko_total += freq;
            unassignedTester.by_status[status] = (unassignedTester.by_status[status] || 0) + 1;
          } else {
            if (!testers[testerName]) {
              testers[testerName] = { total: 0, frequency_tested_ko_total: 0, by_status: {} };
            }
            testers[testerName].total++;
            testers[testerName].frequency_tested_ko_total += freq;
            testers[testerName].by_status[status] = (testers[testerName].by_status[status] || 0) + 1;
          }
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                sprint: sprintName,
                total_issues: issues.length,
                total_matched: total,
                truncated,
                testers,
                unassigned_tester: unassignedTester,
              }, null, 2),
            },
          ],
        };
      }

      // 36. GET REVIEWER WORKLOAD
      case "quinta-jira_get_reviewer_workload": {
        const { project_key } = args;

        const jql = `project = "${escapeJqlValue(project_key)}" AND sprint in openSprints()`;
        const { issues, total, truncated } = await searchAllIssues(jql, "status,customfield_10020,customfield_10806,customfield_10008");

        let sprintName = "Current Sprint";
        if (issues.length > 0) {
          const sprintRaw = issues[0].fields?.customfield_10008;
          if (sprintRaw && Array.isArray(sprintRaw) && sprintRaw.length > 0) {
            const parsed = parseSprint(sprintRaw[0]);
            if (parsed?.name) sprintName = parsed.name;
          }
        }

        const reviewers: Record<string, any> = {};
        const unassignedReviewer: { total: number; frequency_review_ko_total: number; by_status: Record<string, number> } = {
          total: 0,
          frequency_review_ko_total: 0,
          by_status: {},
        };

        issues.forEach((issue: any) => {
          const reviewerName = issue.fields.customfield_10020?.displayName ?? null;
          const status = issue.fields.status?.name || "Unknown";
          const freq = issue.fields.customfield_10806 ?? 0;

          if (!reviewerName) {
            unassignedReviewer.total++;
            unassignedReviewer.frequency_review_ko_total += freq;
            unassignedReviewer.by_status[status] = (unassignedReviewer.by_status[status] || 0) + 1;
          } else {
            if (!reviewers[reviewerName]) {
              reviewers[reviewerName] = { total: 0, frequency_review_ko_total: 0, by_status: {} };
            }
            reviewers[reviewerName].total++;
            reviewers[reviewerName].frequency_review_ko_total += freq;
            reviewers[reviewerName].by_status[status] = (reviewers[reviewerName].by_status[status] || 0) + 1;
          }
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                sprint: sprintName,
                total_issues: issues.length,
                total_matched: total,
                truncated,
                reviewers,
                unassigned_reviewer: unassignedReviewer,
              }, null, 2),
            },
          ],
        };
      }

      // 37. GET ISSUE WORKLOGS
      case "quinta-jira_get_issue_worklogs": {
        const { issue_key } = args;

        if (!issue_key) {
          throw createError(
            ErrorCodes.MISSING_REQUIRED_FIELD,
            "issue_key is required",
            { provided_args: args },
            "Provide issue_key parameter (e.g., 'QT-14006')"
          );
        }

        let worklogData;
        try {
          worklogData = await jiraRequest(`/rest/api/2/issue/${issue_key}/worklog`);
        } catch (err: any) {
          if (err.error_code === ErrorCodes.ISSUE_NOT_FOUND) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({ success: false, error: `Issue ${issue_key} not found` }, null, 2),
              }],
            };
          }
          throw err;
        }

        const worklogs = (worklogData.worklogs || []).map((wl: any) => ({
          id: wl.id,
          author: wl.author?.displayName,
          author_key: wl.author?.key || wl.author?.name,
          time_spent_seconds: wl.timeSpentSeconds,
          time_spent_hours: Math.round((wl.timeSpentSeconds / 3600) * 100) / 100,
          time_spent_display: wl.timeSpent,
          started: wl.started,
          comment: wl.comment || null,
        }));

        const total_time_spent_seconds = worklogs.reduce((sum: number, wl: any) => sum + (wl.time_spent_seconds || 0), 0);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              issue_key,
              total_worklogs: worklogs.length,
              total_time_spent_seconds,
              total_time_spent_hours: Math.round((total_time_spent_seconds / 3600) * 100) / 100,
              worklogs,
            }, null, 2),
          }],
        };
      }

      // 38. GET BULK WORKLOGS
      case "quinta-jira_get_bulk_worklogs": {
        const { project_key, sprint_name, date_from, date_to, max_issues = 200 } = args;

        // Build JQL
        let jql: string;
        if (sprint_name) {
          jql = `project = "${escapeJqlValue(project_key)}" AND sprint = "${escapeJqlValue(sprint_name)}"`;
        } else if (date_from && date_to) {
          jql = `project = "${escapeJqlValue(project_key)}" AND worklogDate >= "${escapeJqlValue(date_from)}" AND worklogDate <= "${escapeJqlValue(date_to)}"`;
        } else {
          jql = `project = "${escapeJqlValue(project_key)}" AND sprint in openSprints()`;
        }

        // Step 1: Get issues
        const searchData = await jiraRequest(
          `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=${max_issues}&fields=key,summary,assignee,status`
        );

        const issueKeys: string[] = searchData.issues.map((i: any) => i.key);
        const issues_found = searchData.total;
        const issues_processed = issueKeys.length;

        // Step 2: Fetch worklogs per issue with concurrency limit of 8
        const worklogResults = await asyncPool(8, issueKeys, async (key: string) => {
          try {
            const wlData = await jiraRequest(`/rest/api/2/issue/${key}/worklog`);
            return { key, worklogs: wlData.worklogs || [] };
          } catch {
            return { key, worklogs: [] };
          }
        });

        // Step 3: Aggregate by author
        const byAuthorMap: Record<string, any> = {};
        let total_worklogs = 0;

        for (const { key, worklogs } of worklogResults) {
          for (const wl of worklogs) {
            total_worklogs++;
            const author = wl.author?.displayName || "Unknown";
            const author_key = wl.author?.key || wl.author?.name || "";
            const seconds = wl.timeSpentSeconds || 0;
            const day = wl.started ? wl.started.substring(0, 10) : "unknown";

            if (!byAuthorMap[author]) {
              byAuthorMap[author] = {
                author,
                author_key,
                total_seconds: 0,
                total_hours: 0,
                issues_count: 0,
                issues: [],
                daily_breakdown: {},
              };
            }

            byAuthorMap[author].total_seconds += seconds;
            if (!byAuthorMap[author].issues.includes(key)) {
              byAuthorMap[author].issues.push(key);
              byAuthorMap[author].issues_count++;
            }
            byAuthorMap[author].daily_breakdown[day] = (byAuthorMap[author].daily_breakdown[day] || 0) + seconds;
          }
        }

        // Compute hours and sort by total_hours desc
        const by_author = Object.values(byAuthorMap)
          .map((a: any) => ({
            ...a,
            total_hours: Math.round((a.total_seconds / 3600) * 100) / 100,
          }))
          .sort((a: any, b: any) => b.total_hours - a.total_hours);

        const total_hours_logged = by_author.reduce((sum: number, a: any) => sum + a.total_hours, 0);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              query: jql,
              issues_found,
              issues_processed,
              total_worklogs,
              total_hours_logged: Math.round(total_hours_logged * 100) / 100,
              by_author,
              rate_limit_note: issues_found > max_issues
                ? `Warning: ${issues_found} issues found but only ${max_issues} processed. Increase max_issues to get complete data.`
                : null,
            }, null, 2),
          }],
        };
      }

      // 39. GET ISSUE CYCLE TIME
      case "quinta-jira_get_issue_cycle_time": {
        const { project_key, sprint_name, max_issues = 100 } = args;

        // Step 1: Build JQL and get sprint issues
        let jql: string;
        if (sprint_name) {
          jql = `project = "${escapeJqlValue(project_key)}" AND sprint = "${escapeJqlValue(sprint_name)}"`;
        } else {
          jql = `project = "${escapeJqlValue(project_key)}" AND sprint in openSprints()`;
        }

        const searchData = await jiraRequest(
          `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=${max_issues}&fields=key`
        );

        const issueKeys: string[] = searchData.issues.map((i: any) => i.key);
        const issues_found = searchData.total;

        // Step 2: Fetch each issue with changelog, concurrency limit of 8
        const issueDetails = await asyncPool(8, issueKeys, async (key: string) => {
          try {
            return await jiraRequest(
              `/rest/api/2/issue/${key}?expand=changelog&fields=key,summary,status,assignee,created`
            );
          } catch {
            return null;
          }
        });

        const now = new Date();

        // Step 3: Parse changelog and compute cycle times
        const issueResults: any[] = [];
        const statusTotals: Record<string, number[]> = {};

        for (const issueData of issueDetails) {
          if (!issueData) continue;

          const key = issueData.key;
          const summary = issueData.fields?.summary || "";
          const assignee = issueData.fields?.assignee?.displayName || "Unassigned";
          const currentStatus = issueData.fields?.status?.name || "Unknown";
          const created = issueData.fields?.created;

          // Extract status transitions from changelog
          const histories: any[] = issueData.changelog?.histories || [];
          const transitions: Array<{ from: string; to: string; timestamp: string }> = [];

          for (const history of histories) {
            for (const item of (history.items || [])) {
              if (item.field === "status") {
                transitions.push({
                  from: item.fromString,
                  to: item.toString,
                  timestamp: history.created,
                });
              }
            }
          }

          // Sort transitions chronologically
          transitions.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

          // Calculate time spent in each status
          const time_in_status: Record<string, number> = {};
          const transitionRecords: any[] = [];

          // Add initial "To Do" from created to first transition (if any)
          const firstTransitionTime = transitions.length > 0 ? new Date(transitions[0].timestamp) : now;
          const initialStatus = transitions.length > 0 ? transitions[0].from : currentStatus;
          const initialHours = Math.round(((firstTransitionTime.getTime() - new Date(created).getTime()) / 3600000) * 100) / 100;
          if (initialStatus && initialHours >= 0) {
            time_in_status[initialStatus] = (time_in_status[initialStatus] || 0) + initialHours;
          }

          for (let i = 0; i < transitions.length; i++) {
            const t = transitions[i];
            const nextTime = i + 1 < transitions.length ? new Date(transitions[i + 1].timestamp) : now;
            const hoursInFromStatus = Math.round(((nextTime.getTime() - new Date(t.timestamp).getTime()) / 3600000) * 100) / 100;

            time_in_status[t.to] = (time_in_status[t.to] || 0) + hoursInFromStatus;

            transitionRecords.push({
              from: t.from,
              to: t.to,
              timestamp: t.timestamp,
              time_in_from_status_hours: hoursInFromStatus,
            });
          }

          const total_cycle_hours = Math.round((Object.values(time_in_status).reduce((s, h) => s + h, 0)) * 100) / 100;

          // Accumulate per-status totals for averages
          for (const [status, hours] of Object.entries(time_in_status)) {
            if (!statusTotals[status]) statusTotals[status] = [];
            statusTotals[status].push(hours);
          }

          issueResults.push({
            key,
            summary,
            assignee,
            status: currentStatus,
            total_cycle_hours,
            transitions: transitionRecords,
            time_in_status,
          });
        }

        // Step 4: Compute averages
        const avg_time_by_status: Record<string, number> = {};
        for (const [status, hours] of Object.entries(statusTotals)) {
          const avg = hours.reduce((s, h) => s + h, 0) / hours.length;
          avg_time_by_status[status] = Math.round(avg * 100) / 100;
        }

        // Find bottleneck (status with highest avg time)
        const bottleneck_status = Object.entries(avg_time_by_status).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

        const avg_cycle_time_hours = issueResults.length > 0
          ? Math.round((issueResults.reduce((s, i) => s + i.total_cycle_hours, 0) / issueResults.length) * 100) / 100
          : 0;

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              sprint: sprint_name || "Current Open Sprint",
              issues_found,
              issues_processed: issueResults.length,
              avg_cycle_time_hours,
              avg_time_by_status,
              bottleneck_status,
              issues: issueResults,
            }, null, 2),
          }],
        };
      }

      // 40. GET MENTIONS
      case "quinta-jira_get_mentions": {
        const username_key = args.username_key;
        if (!username_key) {
          throw createError(
            ErrorCodes.MISSING_REQUIRED_FIELD,
            "username_key is required",
            { provided_args: args },
            "Provide username_key parameter (e.g., 'jam')"
          );
        }
        const project_key = args.project_key ?? "QT";
        const sinceRaw = args.since ?? "-2w";
        const untilRaw = args.until ?? null;

        // Parse since
        let sinceDate: Date;
        const relMatch = sinceRaw.match(/^-(\d+)(d|w)$/);
        if (relMatch) {
          const n = parseInt(relMatch[1], 10);
          const unit = relMatch[2];
          sinceDate = new Date();
          sinceDate.setDate(sinceDate.getDate() - (unit === "w" ? n * 7 : n));
        } else {
          sinceDate = new Date(sinceRaw);
        }

        // Parse until
        const untilDate = untilRaw ? new Date(untilRaw) : new Date();

        // Format sinceDate for JQL as YYYY-MM-DD
        const sinceJQL = sinceDate.toISOString().slice(0, 10);

        // Step 1: Paginate through JQL results
        const jql = `project = "${escapeJqlValue(project_key)}" AND updated >= "${sinceJQL}" ORDER BY updated DESC`;
        const issueKeys: { key: string; summary: string; status: string }[] = [];
        let startAt = 0;
        const pageSize = 100;
        let total = 0;

        do {
          const searchData = await jiraRequest(
            `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=${pageSize}&startAt=${startAt}&fields=key,summary,status`
          );
          total = searchData.total;
          for (const issue of searchData.issues) {
            issueKeys.push({
              key: issue.key,
              summary: issue.fields.summary,
              status: issue.fields.status?.name || "Unknown",
            });
          }
          startAt += pageSize;
        } while (startAt < total);

        // Step 2: For each issue, fetch comments and scan for [~username_key]
        const mentionPattern = `[~${username_key}]`;
        const results: any[] = [];

        await asyncPool(5, issueKeys, async (issue) => {
          // Paginate the comment endpoint so issues with >500 comments are fully scanned.
          let cStart = 0;
          const cPage = 100;
          let cTotal = 0;
          do {
            const commentData = await jiraRequest(
              `/rest/api/2/issue/${issue.key}/comment?maxResults=${cPage}&startAt=${cStart}`
            );
            cTotal = commentData.total ?? (commentData.comments?.length ?? 0);
            const batch = commentData.comments || [];
            for (const comment of batch) {
              const commentDate = new Date(comment.created);
              if (
                commentDate >= sinceDate &&
                commentDate <= untilDate &&
                comment.body && comment.body.includes(mentionPattern)
              ) {
                results.push({
                  issue_key: issue.key,
                  issue_summary: issue.summary,
                  issue_status: issue.status,
                  comment_author: comment.author?.displayName || comment.author?.name || "Unknown",
                  comment_created: comment.created,
                  comment_body: comment.body.slice(0, 300),
                });
              }
            }
            cStart += batch.length;
            if (batch.length === 0) break;
          } while (cStart < cTotal);
        });

        // Sort by comment_created DESC
        results.sort((a, b) => new Date(b.comment_created).getTime() - new Date(a.comment_created).getTime());

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              username_key,
              project_key,
              since: sinceDate.toISOString(),
              until: untilDate.toISOString(),
              total_issues_scanned: issueKeys.length,
              total_mentions_found: results.length,
              mentions: results,
            }, null, 2),
          }],
        };
      }

      // 41. DELETE ISSUE
      case "quinta-jira_delete_issue": {
        const { issue_key, delete_subtasks = false } = args;
        const deleteUrl = `/rest/api/2/issue/${issue_key}?deleteSubtasks=${delete_subtasks}`;
        await jiraRequest(deleteUrl, { method: "DELETE" });
        return {
          content: [{ type: "text", text: JSON.stringify({
            success: true,
            message: `Issue ${issue_key} deleted${delete_subtasks ? ' (with sub-tasks)' : ''}`,
          }, null, 2) }],
        };
      }

      // 42. MOVE TO SPRINT
      case "quinta-jira_move_to_sprint": {
        const { sprint_id, issue_keys } = args;
        if (!issue_keys || issue_keys.length === 0) {
          throw createError(ErrorCodes.MISSING_REQUIRED_FIELD, "issue_keys array is required");
        }
        await jiraRequest(`/rest/agile/1.0/sprint/${sprint_id}/issue`, {
          method: "POST",
          body: JSON.stringify({ issues: issue_keys }),
        });
        return {
          content: [{ type: "text", text: JSON.stringify({
            success: true,
            message: `Moved ${issue_keys.length} issue(s) to sprint ${sprint_id}`,
            issues: issue_keys,
            sprint_id,
          }, null, 2) }],
        };
      }

      // 43. MOVE TO BACKLOG
      case "quinta-jira_move_to_backlog": {
        const { issue_keys: backlogIssues } = args;
        if (!backlogIssues || backlogIssues.length === 0) {
          throw createError(ErrorCodes.MISSING_REQUIRED_FIELD, "issue_keys array is required");
        }
        await jiraRequest(`/rest/agile/1.0/backlog/issue`, {
          method: "POST",
          body: JSON.stringify({ issues: backlogIssues }),
        });
        return {
          content: [{ type: "text", text: JSON.stringify({
            success: true,
            message: `Moved ${backlogIssues.length} issue(s) to backlog`,
            issues: backlogIssues,
          }, null, 2) }],
        };
      }

      // 44. ADD ISSUE LINK
      case "quinta-jira_add_issue_link": {
        const { link_type, inward_issue, outward_issue, comment: linkComment } = args;
        const linkPayload: any = {
          type: { name: link_type },
          inwardIssue: { key: inward_issue },
          outwardIssue: { key: outward_issue },
        };
        if (linkComment) {
          linkPayload.comment = { body: linkComment };
        }
        await jiraRequest(`/rest/api/2/issueLink`, {
          method: "POST",
          body: JSON.stringify(linkPayload),
        });
        return {
          content: [{ type: "text", text: JSON.stringify({
            success: true,
            message: `Link created: ${outward_issue} ${link_type} ${inward_issue}`,
          }, null, 2) }],
        };
      }

      // 45. ADD WATCHER
      case "quinta-jira_add_watcher": {
        const { issue_key: watchIssue, username: watchUser } = args;
        // Jira DC expects the username as a plain JSON string in the body
        await jiraRequest(`/rest/api/2/issue/${watchIssue}/watchers`, {
          method: "POST",
          body: JSON.stringify(watchUser),
        });
        return {
          content: [{ type: "text", text: JSON.stringify({
            success: true,
            message: `Added ${watchUser} as watcher on ${watchIssue}`,
          }, null, 2) }],
        };
      }

      // 46. REMOVE WATCHER
      case "quinta-jira_remove_watcher": {
        const { issue_key: unwatchIssue, username: unwatchUser } = args;
        await jiraRequest(`/rest/api/2/issue/${unwatchIssue}/watchers?username=${encodeURIComponent(unwatchUser)}`, {
          method: "DELETE",
        });
        return {
          content: [{ type: "text", text: JSON.stringify({
            success: true,
            message: `Removed ${unwatchUser} from watchers on ${unwatchIssue}`,
          }, null, 2) }],
        };
      }

      // 47. GET WATCHERS
      case "quinta-jira_get_watchers": {
        const { issue_key: watchersIssue } = args;
        const watchersData = await jiraRequest(`/rest/api/2/issue/${watchersIssue}/watchers`);
        return {
          content: [{ type: "text", text: JSON.stringify({
            success: true,
            issue_key: watchersIssue,
            watcher_count: watchersData.watchCount,
            is_watching: watchersData.isWatching,
            watchers: (watchersData.watchers || []).map((w: any) => ({
              name: w.name,
              displayName: w.displayName,
              key: w.key,
            })),
          }, null, 2) }],
        };
      }

      // 48. GET ISSUE LINK TYPES
      case "quinta-jira_get_link_types": {
        const linkTypesData = await jiraRequest(`/rest/api/2/issueLinkType`);
        return {
          content: [{ type: "text", text: JSON.stringify({
            success: true,
            link_types: (linkTypesData.issueLinkTypes || []).map((lt: any) => ({
              id: lt.id,
              name: lt.name,
              inward: lt.inward,
              outward: lt.outward,
            })),
          }, null, 2) }],
        };
      }

      // 49. ASSIGN ISSUE (dedicated endpoint)
      case "quinta-jira_assign_issue": {
        const { issue_key: assignIssue, username: assignUser } = args;
        // Use the dedicated assign endpoint — more reliable than PUT /fields/assignee on DC
        await jiraRequest(`/rest/api/2/issue/${assignIssue}/assignee`, {
          method: "PUT",
          body: JSON.stringify({ name: assignUser || null }),
        });
        return {
          content: [{ type: "text", text: JSON.stringify({
            success: true,
            message: assignUser
              ? `Issue ${assignIssue} assigned to ${assignUser}`
              : `Issue ${assignIssue} unassigned`,
          }, null, 2) }],
        };
      }

      // 50. RANK ISSUES
      case "quinta-jira_rank_issues": {
        const { issue_keys: rankIssues, rank_before, rank_after } = args;
        if (!rankIssues || rankIssues.length === 0) {
          throw createError(ErrorCodes.MISSING_REQUIRED_FIELD, "issue_keys array is required");
        }
        if (!rank_before && !rank_after) {
          throw createError(ErrorCodes.MISSING_REQUIRED_FIELD, "Either rank_before or rank_after is required");
        }
        const rankPayload: any = { issues: rankIssues };
        if (rank_before) rankPayload.rankBeforeIssue = rank_before;
        if (rank_after) rankPayload.rankAfterIssue = rank_after;
        await jiraRequest(`/rest/agile/1.0/issue/rank`, {
          method: "PUT",
          body: JSON.stringify(rankPayload),
        });
        return {
          content: [{ type: "text", text: JSON.stringify({
            success: true,
            message: `Ranked ${rankIssues.length} issue(s) ${rank_before ? 'before ' + rank_before : 'after ' + rank_after}`,
            issues: rankIssues,
          }, null, 2) }],
        };
      }

      // 51. LIST ATTACHMENTS
      case "quinta-jira_list_attachments": {
        const { issue_key: listAttIssueKey } = args;
        if (!listAttIssueKey) {
          throw createError(ErrorCodes.MISSING_REQUIRED_FIELD, "issue_key is required");
        }
        const listAttData = await jiraRequest(`/rest/api/2/issue/${listAttIssueKey}?fields=attachment`);
        const rawAttachments = listAttData.fields?.attachment || [];
        const attachments = rawAttachments.map((a: any) => ({
          id: a.id,
          filename: a.filename,
          mime_type: a.mimeType,
          size_bytes: a.size,
          author: a.author?.displayName || a.author?.name || "Unknown",
          created: a.created,
          content_url: a.content,
          thumbnail_url: a.thumbnail || null,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify({
            success: true,
            issue_key: listAttIssueKey,
            total: attachments.length,
            attachments,
          }, null, 2) }],
        };
      }

      // 52. GET ATTACHMENT
      case "quinta-jira_get_attachment": {
        const { attachment_id, max_size_mb = 10 } = args;
        if (!attachment_id) {
          throw createError(ErrorCodes.MISSING_REQUIRED_FIELD, "attachment_id is required");
        }
        const mb = Number(max_size_mb);
        const effMb = Number.isFinite(mb) && mb > 0 ? mb : 10;
        const maxBytes = effMb * 1024 * 1024;

        // Fetch metadata via standard Jira REST (returns JSON)
        const meta = await jiraRequest(`/rest/api/2/attachment/${attachment_id}`);
        const filename: string = meta.filename || "unknown";
        const mimeType: string = (meta.mimeType || "application/octet-stream").split(";")[0].trim();
        const sizeBytes: number = meta.size || 0;
        const contentUrl: string = meta.content;

        // Early size guard (before network download)
        if (sizeBytes > maxBytes) {
          throw createError(
            ErrorCodes.INVALID_PARAMETER,
            `File too large to download (${(sizeBytes / 1024 / 1024).toFixed(2)} MB). Increase max_size_mb (current: ${max_size_mb}).`,
            { size_bytes: sizeBytes, max_bytes: maxBytes, filename }
          );
        }

        const { buffer } = await fetchAttachmentBinary(contentUrl, maxBytes);

        const isImage = IMAGE_MIME_TYPES.includes(mimeType);
        const isText = (TEXT_MIME_PREFIXES.some(p => mimeType.startsWith(p)) || TEXT_MIME_EXACT.includes(mimeType))
          && buffer.length <= TEXT_SIZE_LIMIT;

        const metaLabel = `Attachment ${attachment_id}: ${filename} (${mimeType}, ${buffer.length} bytes)`;

        if (isImage) {
          // Return native MCP image block — Claude renders this directly
          return {
            content: [
              {
                type: "image",
                data: buffer.toString("base64"),
                mimeType,
              },
              {
                type: "text",
                text: metaLabel,
              },
            ],
          };
        } else if (isText) {
          return {
            content: [{ type: "text", text: `${metaLabel}\n\n${buffer.toString("utf-8")}` }],
          };
        }

        const extractedText = await extractAttachmentText(buffer, mimeType);
        if (extractedText !== null) {
          return {
            content: [{ type: "text", text: `${metaLabel}\n\n${extractedText}` }],
          };
        }

        // PDF/Office (extraction disabled or failed) and other binaries — base64 in a text block
        return {
          content: [{ type: "text", text: JSON.stringify({
            success: true,
            attachment_id,
            filename,
            mime_type: mimeType,
            size_bytes: buffer.length,
            encoding: "base64",
            note: "Binary file returned as base64. Decode to access raw content.",
            data: buffer.toString("base64"),
          }, null, 2) }],
        };
      }

      // 53. GET ISSUE ATTACHMENTS BULK
      case "quinta-jira_get_issue_attachments_bulk": {
        const { issue_key: bulkIssueKey, max_size_mb: bulkMaxMb = 10, max_images = 5 } = args;
        if (!bulkIssueKey) {
          throw createError(ErrorCodes.MISSING_REQUIRED_FIELD, "issue_key is required");
        }
        const bulkMb = Number(bulkMaxMb);
        const effBulkMb = Number.isFinite(bulkMb) && bulkMb > 0 ? bulkMb : 10;
        const bulkMaxBytes = effBulkMb * 1024 * 1024;
        const reqImages = Number(max_images);
        const imageLimit = Math.min(Number.isFinite(reqImages) && reqImages > 0 ? reqImages : 5, 5);

        const bulkData = await jiraRequest(`/rest/api/2/issue/${encodeURIComponent(bulkIssueKey)}?fields=attachment`);
        const allAttachments = bulkData.fields?.attachment || [];
        const imageAttachments = allAttachments
          .filter((a: any) => IMAGE_MIME_TYPES.includes((a.mimeType || "").split(";")[0].trim()))
          .slice(0, imageLimit);

        if (imageAttachments.length === 0) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              success: true,
              issue_key: bulkIssueKey,
              message: "No image attachments found on this issue.",
              total_attachments: allAttachments.length,
              image_attachments_found: 0,
            }, null, 2) }],
          };
        }

        const contentBlocks: any[] = [];
        const errors: any[] = [];

        // Summary text block first so context is clear
        contentBlocks.push({
          type: "text",
          text: `Issue ${bulkIssueKey}: downloading ${imageAttachments.length} image attachment(s) ` +
            `(${allAttachments.length} total attachment(s))\n` +
            imageAttachments.map((a: any, i: number) =>
              `  ${i + 1}. ${a.filename} (${a.mimeType}, ${a.size} bytes, ID: ${a.id})`
            ).join("\n"),
        });

        for (const att of imageAttachments) {
          const mimeType: string = (att.mimeType || "image/png").split(";")[0].trim();
          if (att.size > bulkMaxBytes) {
            errors.push({ id: att.id, filename: att.filename, reason: `Too large (${(att.size / 1024 / 1024).toFixed(2)} MB > ${bulkMaxMb} MB)` });
            continue;
          }
          try {
            const { buffer } = await fetchAttachmentBinary(att.content, bulkMaxBytes);
            contentBlocks.push({
              type: "image",
              data: buffer.toString("base64"),
              mimeType,
            });
          } catch (dlErr: any) {
            errors.push({ id: att.id, filename: att.filename, reason: dlErr.error_message || dlErr.message || "Download failed" });
          }
        }

        if (errors.length > 0) {
          contentBlocks.push({
            type: "text",
            text: `Skipped ${errors.length} attachment(s):\n${JSON.stringify(errors, null, 2)}`,
          });
        }

        return { content: contentBlocks };
      }

      // ─── Confluence Cases ──────────────────────────────────────────────────

      // 54. SEARCH PAGES
      case "quinta-confluence_search_pages": {
        const { cql, limit = 25, start = 0 } = args;
        if (!cql) throw createError(ConfluenceErrorCodes.MISSING_REQUIRED, "cql is required", {}, "Provide a CQL query, e.g. 'space=DEV AND type=page'");
        const data = await confluenceRequest(`/rest/api/content/search?cql=${encodeURIComponent(String(cql))}&limit=${limit}&start=${start}&expand=space,version,history,history.lastUpdated`);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              total: data.totalSize,
              returned: data.results?.length ?? 0,
              cql_query: cql,
              pages: (data.results ?? []).map((p: any) => ({
                id: p.id,
                title: p.title,
                type: p.type,
                space_key: p.space?.key,
                space_name: p.space?.name,
                version: p.version?.number,
                last_updated: p.history?.lastUpdated?.when,
                last_updated_by: p.history?.lastUpdated?.by?.displayName,
                url: CONFLUENCE_BASE_URL + (p._links?.webui ?? ''),
              })),
            }, null, 2),
          }],
        };
      }

      // 55. GET PAGE
      case "quinta-confluence_get_page": {
        const { page_id, include_body = true } = args;
        if (!page_id) throw createError(ConfluenceErrorCodes.MISSING_REQUIRED, "page_id is required");
        const expand = include_body
          ? "body.storage,version,space,history,history.lastUpdated,ancestors"
          : "version,space,history,history.lastUpdated,ancestors";
        const data = await confluenceRequest(`/rest/api/content/${page_id}?expand=${expand}`);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              page: {
                id: data.id,
                title: data.title,
                type: data.type,
                status: data.status,
                space_key: data.space?.key,
                space_name: data.space?.name,
                version: data.version?.number,
                created: data.history?.createdDate,
                created_by: data.history?.createdBy?.displayName,
                last_updated: data.history?.lastUpdated?.when,
                last_updated_by: data.history?.lastUpdated?.by?.displayName,
                parent: data.ancestors?.length ? { id: data.ancestors[data.ancestors.length - 1].id, title: data.ancestors[data.ancestors.length - 1].title } : null,
                body: include_body ? extractConfluenceText(data.body?.storage?.value ?? '') : undefined,
                url: CONFLUENCE_BASE_URL + (data._links?.webui ?? ''),
              },
            }, null, 2),
          }],
        };
      }

      // 56. GET PAGE BY TITLE
      case "quinta-confluence_get_page_by_title": {
        const { space_key, title } = args;
        if (!space_key) throw createError(ConfluenceErrorCodes.MISSING_REQUIRED, "space_key is required");
        if (!title) throw createError(ConfluenceErrorCodes.MISSING_REQUIRED, "title is required");
        const cql = `space="${escapeCqlValue(space_key)}" AND title="${escapeCqlValue(String(title))}" AND type=page`;
        const data = await confluenceRequest(`/rest/api/content/search?cql=${encodeURIComponent(cql)}&expand=body.storage,version,space,history,history.lastUpdated,ancestors&limit=5`);
        if (!data.results?.length) {
          return { content: [{ type: "text", text: JSON.stringify({ success: false, message: `No page found with title "${title}" in space ${space_key}` }, null, 2) }] };
        }
        const p = data.results[0];
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              page: {
                id: p.id,
                title: p.title,
                space_key: p.space?.key,
                version: p.version?.number,
                last_updated: p.history?.lastUpdated?.when,
                last_updated_by: p.history?.lastUpdated?.by?.displayName,
                parent: p.ancestors?.length ? { id: p.ancestors[p.ancestors.length - 1].id, title: p.ancestors[p.ancestors.length - 1].title } : null,
                body: extractConfluenceText(p.body?.storage?.value ?? ''),
                url: CONFLUENCE_BASE_URL + (p._links?.webui ?? ''),
              },
            }, null, 2),
          }],
        };
      }

      // 57. GET CHILD PAGES
      case "quinta-confluence_get_child_pages": {
        const { page_id, limit = 25 } = args;
        if (!page_id) throw createError(ConfluenceErrorCodes.MISSING_REQUIRED, "page_id is required");
        const data = await confluenceRequest(`/rest/api/content/${page_id}/child/page?expand=version,space&limit=${limit}`);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              parent_id: page_id,
              total: data.size,
              children: (data.results ?? []).map((p: any) => ({
                id: p.id,
                title: p.title,
                version: p.version?.number,
                space_key: p.space?.key,
                url: CONFLUENCE_BASE_URL + (p._links?.webui ?? ''),
              })),
            }, null, 2),
          }],
        };
      }

      // 58. LIST SPACES
      case "quinta-confluence_list_spaces": {
        const { limit = 50, type } = args;
        const typeFilter = type ? `&type=${encodeURIComponent(String(type))}` : '';
        const data = await confluenceRequest(`/rest/api/space?expand=description.plain&limit=${limit}${typeFilter}`);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              total: data.size,
              spaces: (data.results ?? []).map((s: any) => ({
                key: s.key,
                name: s.name,
                type: s.type,
                status: s.status,
                description: s.description?.plain?.value ?? '',
                url: CONFLUENCE_BASE_URL + (s._links?.webui ?? ''),
              })),
            }, null, 2),
          }],
        };
      }

      // 59. GET SPACE
      case "quinta-confluence_get_space": {
        const { space_key } = args;
        if (!space_key) throw createError(ConfluenceErrorCodes.MISSING_REQUIRED, "space_key is required");
        const data = await confluenceRequest(`/rest/api/space/${space_key}?expand=description.plain,homepage`);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              space: {
                key: data.key,
                name: data.name,
                type: data.type,
                status: data.status,
                description: data.description?.plain?.value ?? '',
                homepage_id: data.homepage?.id,
                homepage_title: data.homepage?.title,
                url: CONFLUENCE_BASE_URL + (data._links?.webui ?? ''),
              },
            }, null, 2),
          }],
        };
      }

      // 60. GET PAGE LABELS
      case "quinta-confluence_get_page_labels": {
        const { page_id } = args;
        if (!page_id) throw createError(ConfluenceErrorCodes.MISSING_REQUIRED, "page_id is required");
        const data = await confluenceRequest(`/rest/api/content/${page_id}/label`);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              page_id,
              labels: (data.results ?? []).map((l: any) => ({ name: l.name, prefix: l.prefix })),
            }, null, 2),
          }],
        };
      }

      // 61. SEARCH BY LABEL
      case "quinta-confluence_search_by_label": {
        const { label, space_key, limit = 25 } = args;
        if (!label) throw createError(ConfluenceErrorCodes.MISSING_REQUIRED, "label is required");
        const spaceFilter = space_key ? ` AND space="${escapeCqlValue(space_key)}"` : '';
        const cql = `label="${escapeCqlValue(label)}" AND type=page${spaceFilter}`;
        const data = await confluenceRequest(`/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${limit}&expand=space,version,history,history.lastUpdated`);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              label,
              total: data.totalSize,
              returned: data.results?.length ?? 0,
              pages: (data.results ?? []).map((p: any) => ({
                id: p.id,
                title: p.title,
                space_key: p.space?.key,
                version: p.version?.number,
                last_updated: p.history?.lastUpdated?.when,
                url: CONFLUENCE_BASE_URL + (p._links?.webui ?? ''),
              })),
            }, null, 2),
          }],
        };
      }

      // 62. GET PAGE COMMENTS
      case "quinta-confluence_get_page_comments": {
        const { page_id, limit = 50 } = args;
        if (!page_id) throw createError(ConfluenceErrorCodes.MISSING_REQUIRED, "page_id is required");
        const data = await confluenceRequest(`/rest/api/content/${page_id}/child/comment?expand=body.storage,version,history&limit=${limit}`);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              page_id,
              total: data.size,
              comments: (data.results ?? []).map((c: any) => ({
                id: c.id,
                body: extractConfluenceText(c.body?.storage?.value ?? ''),
                author: c.history?.createdBy?.displayName,
                created: c.history?.createdDate,
                last_updated: c.version?.when,
              })),
            }, null, 2),
          }],
        };
      }

      // 63. GET PAGE HISTORY
      case "quinta-confluence_get_page_history": {
        const { page_id, limit = 10 } = args;
        if (!page_id) throw createError(ConfluenceErrorCodes.MISSING_REQUIRED, "page_id is required");

        // Try /version endpoint first (Confluence Cloud + some DC versions)
        // Fall back to /history endpoint (Confluence Server 7.x)
        let versions: any[] = [];
        let source = "version";
        try {
          const data = await confluenceRequest(`/rest/api/content/${page_id}/version?limit=${limit}`);
          versions = (data.results ?? []).map((v: any) => ({
            version: v.number,
            message: v.message ?? '',
            minor_edit: v.minorEdit,
            when: v.when,
            author: v.by?.displayName,
          }));
        } catch (versionErr: any) {
          // Older Confluence Server versions lack the /version sub-resource and may
          // answer 404 (PAGE_NOT_FOUND) or 405/other (API_ERROR). Fall back in both
          // cases, but still surface auth failures (401/403).
          if (
            versionErr.error_code === ConfluenceErrorCodes.PAGE_NOT_FOUND ||
            versionErr.error_code === ConfluenceErrorCodes.API_ERROR
          ) {
            // /version endpoint not available — fall back to /history
            source = "history";
            const hist = await confluenceRequest(
              `/rest/api/content/${page_id}?expand=version,history,history.previousVersion,history.lastUpdated`
            );
            // Build a version list from what the history endpoint gives us
            const current = hist.version;
            const lastUpdated = hist.history?.lastUpdated;
            const created = hist.history;
            if (current) {
              versions.push({
                version: current.number,
                message: current.message ?? '',
                minor_edit: current.minorEdit ?? false,
                when: lastUpdated?.when ?? null,
                author: lastUpdated?.by?.displayName ?? created?.createdBy?.displayName,
              });
            }
            if (created && current?.number > 1) {
              versions.push({
                version: 1,
                message: '',
                minor_edit: false,
                when: created.createdDate,
                author: created.createdBy?.displayName,
              });
            }
          } else {
            throw versionErr;
          }
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              page_id,
              source,
              note: source === "history"
                ? "Full version list unavailable on this Confluence Server version — showing current and initial versions only"
                : undefined,
              versions,
            }, null, 2),
          }],
        };
      }

      // 64. GET CURRENT USER
      case "quinta-confluence_get_current_user": {
        const data = await confluenceRequest(`/rest/api/user/current`);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              user: {
                username: data.username,
                display_name: data.displayName,
                user_key: data.userKey,
                status: data.status,
                confluence_url: CONFLUENCE_BASE_URL,
              },
            }, null, 2),
          }],
        };
      }

      // 65. CREATE PAGE
      case "quinta-confluence_create_page": {
        const { space_key, title, body, parent_id } = args;
        if (!space_key) throw createError(ConfluenceErrorCodes.MISSING_REQUIRED, "space_key is required");
        if (!title) throw createError(ConfluenceErrorCodes.MISSING_REQUIRED, "title is required");
        if (!body) throw createError(ConfluenceErrorCodes.MISSING_REQUIRED, "body is required");

        const payload: any = {
          type: "page",
          title: String(title),
          space: { key: String(space_key) },
          body: { storage: { value: String(body), representation: "storage" } },
        };
        if (parent_id) payload.ancestors = [{ id: String(parent_id) }];

        const data = await confluenceRequest(`/rest/api/content`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              page_id: data.id,
              title: data.title,
              version: data.version?.number,
              url: CONFLUENCE_BASE_URL + (data._links?.webui ?? ''),
            }, null, 2),
          }],
        };
      }

      // 66. UPDATE PAGE
      case "quinta-confluence_update_page": {
        const { page_id, title, body, version, version_message } = args;
        if (!page_id) throw createError(ConfluenceErrorCodes.MISSING_REQUIRED, "page_id is required");
        if (!title) throw createError(ConfluenceErrorCodes.MISSING_REQUIRED, "title is required");
        if (!body) throw createError(ConfluenceErrorCodes.MISSING_REQUIRED, "body is required");
        if (!version) throw createError(ConfluenceErrorCodes.MISSING_REQUIRED, "version is required — get it from quinta-confluence_get_page first");

        const payload: any = {
          id: String(page_id),
          type: "page",
          title: String(title),
          version: { number: Number(version), ...(version_message ? { message: String(version_message) } : {}) },
          body: { storage: { value: String(body), representation: "storage" } },
        };

        const data = await confluenceRequest(`/rest/api/content/${page_id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              page_id: data.id,
              title: data.title,
              version: data.version?.number,
              url: CONFLUENCE_BASE_URL + (data._links?.webui ?? ''),
            }, null, 2),
          }],
        };
      }

      // 67. ADD PAGE COMMENT
      case "quinta-confluence_add_page_comment": {
        const { page_id, body } = args;
        if (!page_id) throw createError(ConfluenceErrorCodes.MISSING_REQUIRED, "page_id is required");
        if (!body) throw createError(ConfluenceErrorCodes.MISSING_REQUIRED, "body is required");

        const data = await confluenceRequest(`/rest/api/content`, {
          method: "POST",
          body: JSON.stringify({
            type: "comment",
            container: { id: String(page_id), type: "page" },
            body: { storage: { value: toConfluenceStorage(String(body)), representation: "storage" } },
          }),
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              comment_id: data.id,
              page_id,
              url: CONFLUENCE_BASE_URL + (data._links?.webui ?? ''),
            }, null, 2),
          }],
        };
      }

      // 68. ADD PAGE LABEL
      case "quinta-confluence_add_page_label": {
        const { page_id, label } = args;
        if (!page_id) throw createError(ConfluenceErrorCodes.MISSING_REQUIRED, "page_id is required");
        if (!label) throw createError(ConfluenceErrorCodes.MISSING_REQUIRED, "label is required");

        const data = await confluenceRequest(`/rest/api/content/${page_id}/label`, {
          method: "POST",
          body: JSON.stringify([{ prefix: "global", name: String(label).toLowerCase().replace(/\s+/g, '-') }]),
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              page_id,
              labels: (data.results ?? []).map((l: any) => l.name),
            }, null, 2),
          }],
        };
      }

      // 69. MOVE PAGE
      case "quinta-confluence_move_page": {
        const { page_id, target_space_key, target_parent_id } = args;
        if (!page_id) throw createError(ConfluenceErrorCodes.MISSING_REQUIRED, "page_id is required");
        if (!target_space_key && !target_parent_id) {
          throw createError(ConfluenceErrorCodes.MISSING_REQUIRED, "Provide at least target_space_key or target_parent_id");
        }

        // Fetch current page to determine current space and get required fields for PUT
        const current = await confluenceRequest(
          `/rest/api/content/${page_id}?expand=body.storage,version,space,ancestors`
        );

        const currentSpaceKey = current.space?.key;
        const isCrossSpaceMove = target_space_key && target_space_key !== currentSpaceKey;

        if (isCrossSpaceMove) {
          // Confluence Server 7.x does not support cross-space moves via REST API.
          // The /move endpoint is Cloud-only (404 on Server).
          // The PUT /rest/api/content/{id} space change returns 403 on Server.
          // Cross-space moves must be done via the Confluence UI:
          //   Space Tools → Content Tools → Reorder Pages, or drag in page tree.
          throw createError(
            ConfluenceErrorCodes.FORBIDDEN,
            `Cross-space moves are not supported by the Confluence Server REST API. Cannot move page from space '${currentSpaceKey}' to '${target_space_key}' via API.`,
            {
              page_id,
              current_space: currentSpaceKey,
              target_space: target_space_key,
              workaround: "Ask the page owner or a Confluence admin to move it via the UI: open the page → ··· menu → Move, or use Space Tools → Reorder Pages",
            },
            "Use the Confluence UI to perform cross-space moves: open the page → click ··· → Move"
          );
        }

        // Same-space parent change — use PUT with updated ancestors
        const newVersion = (current.version?.number ?? 1) + 1;
        const payload: any = {
          id: String(page_id),
          type: "page",
          title: current.title,
          version: { number: newVersion },
          space: { key: currentSpaceKey },
          body: current.body,
        };

        if (target_parent_id) {
          payload.ancestors = [{ id: String(target_parent_id) }];
        } else {
          // Keep existing parent
          if (current.ancestors?.length) {
            payload.ancestors = [{ id: current.ancestors[current.ancestors.length - 1].id }];
          }
        }

        const data = await confluenceRequest(`/rest/api/content/${page_id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              page_id: data.id,
              title: data.title,
              space: data.space?.key,
              new_version: data.version?.number,
              url: CONFLUENCE_BASE_URL + (data._links?.webui ?? ''),
            }, null, 2),
          }],
        };
      }

      default:
        throw createError(
          ErrorCodes.INVALID_PARAMETER,
          `Unknown tool: ${name}`,
          { tool_name: name },
          "Check tool name spelling. Tools start with quinta-jira_ or quinta-confluence_"
        );
    }
  } catch (error: any) {
    // If it's already a structured error, return it as-is
    if (error.error_code) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(error, null, 2),
          },
        ],
        isError: true,
      };
    }

    // Otherwise, wrap it in a structured error.
    // Log the stack to stderr (server-side) instead of returning it to the client,
    // to avoid disclosing absolute paths / internals over the tool result.
    console.error("Unexpected error handling tool call:", error?.stack ?? error);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            createError(
              ErrorCodes.JIRA_API_ERROR,
              `Unexpected error: ${error.message}`,
              { original_error: error.message }
            ),
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`QuickText Jira+Confluence MCP Server v5.0.0 running on stdio (Confluence: ${confluenceEnabled ? 'enabled' : 'disabled — set CONFLUENCE_BASE_URL + CONFLUENCE_API_TOKEN'})`);
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
