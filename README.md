# JIRA MCP Server

A Model Context Protocol (MCP) server implementation that provides access to JIRA data with relationship tracking, optimized data payloads, and data cleaning for AI context windows.

ℹ️ There is a separate MCP server [for Confluence](https://github.com/cosmix/confluence-mcp)

---

## Jira Cloud & Jira Server (Data Center) Support

This MCP server supports both **Jira Cloud** and **Jira Server (Data Center)** instances. You can select which type to use by setting the `JIRA_TYPE` environment variable:

- `cloud` (default): For Jira Cloud (Atlassian-hosted)
- `server`: For Jira Server/Data Center (self-hosted)

The server will automatically use the correct API version and authentication method for the selected type.

---

## Features

- Search JIRA issues using JQL (maximum 50 results per request)
- Retrieve epic children with comment history and optimized payloads (maximum 100 issues per request)
- Get detailed issue information including comments and related issues
- Create, update, and manage JIRA issues
- Add comments to issues
- Extract issue mentions from Atlassian Document Format
- Track issue relationships (mentions, links, parent/child, epics)
- Clean and transform rich JIRA content for AI context efficiency
- Support for file attachments with secure multipart upload handling
- **Supports both Jira Cloud and Jira Server (Data Center) APIs**
- **Dual transport modes: STDIO (default) and Streamable HTTP (MCP 2025-03-26) for tools like Postman and MCP Inspector**

## Prerequisites

- [Bun](https://bun.sh) (v1.0.0 or higher)
- JIRA account with API access

## Environment Variables

```bash
JIRA_API_TOKEN=your_api_token            # API token for Cloud, PAT or password for Server/DC
JIRA_BASE_URL=your_jira_instance_url     # e.g., https://your-domain.atlassian.net
JIRA_USER_EMAIL=your_email               # Your Jira account email
JIRA_TYPE=cloud                          # 'cloud' or 'server' (optional, defaults to 'cloud')
JIRA_AUTH_TYPE=basic                     # 'basic' or 'bearer' (optional, defaults to 'basic')
TRANSPORT_MODE=stdio                     # 'stdio' or 'http' (optional, defaults to 'stdio')
HTTP_PORT=3000                           # Port for HTTP transport (optional, defaults to 3000)
```

### Authentication Methods

- **Jira Cloud**: Use API tokens with Basic authentication
  - Create an API token at: <https://id.atlassian.com/manage-profile/security/api-tokens>
  - Set `JIRA_AUTH_TYPE=basic` (default)
  
- **Jira Server/Data Center**:
  - **Basic Auth**: Use username/password or API tokens
    - Set `JIRA_AUTH_TYPE=basic` (default)
  - **Bearer Auth**: Use Personal Access Tokens (PATs) - available in Data Center 8.14.0+
    - Create a PAT in your profile settings
    - Set `JIRA_AUTH_TYPE=bearer`
    - Use the PAT as your `JIRA_API_TOKEN`

## Installation & Setup

### 1. Clone the repository

```bash
git clone [repository-url]
cd jira-mcp
```

### 2. Install dependencies and build

```bash
bun install
bun run build
```

### 3. Configure the MCP server

The server supports two transport modes: **STDIO** (default, for Claude Desktop/Cline) and **HTTP** (for Postman and other HTTP-based clients).

#### Option A: STDIO Transport (Default - Claude Desktop/Cline)

Edit the appropriate configuration file:

**macOS:**

- Cline: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json`

**Windows:**

- Cline: `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`
- Claude Desktop: `%APPDATA%\Claude Desktop\claude_desktop_config.json`

**Linux:**

- Cline: `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- Claude Desktop: _sadly doesn't exist yet_

Add the following configuration under the `mcpServers` object:

```json
{
  "mcpServers": {
    "jira": {
      "command": "node",
      "args": ["/absolute/path/to/jira-mcp/build/index.js"],
      "env": {
        "JIRA_API_TOKEN": "your_api_token",
        "JIRA_BASE_URL": "your_jira_instance_url",
        "JIRA_USER_EMAIL": "your_email",
        "JIRA_TYPE": "cloud",
        "JIRA_AUTH_TYPE": "basic"
      }
    }
  }
}
```

#### Option B: Streamable HTTP Transport (MCP Inspector & Postman)

1. **Start the server in HTTP mode:**

```bash
# Set environment variables
export JIRA_API_TOKEN="your_api_token"
export JIRA_BASE_URL="your_jira_instance_url"
export JIRA_USER_EMAIL="your_email"
export TRANSPORT_MODE="http"
export HTTP_PORT="3000"  # optional, defaults to 3000

# Run the server
bun run build/index.js
```

Or use a `.env` file:

```bash
# .env
JIRA_API_TOKEN=your_api_token
JIRA_BASE_URL=your_jira_instance_url
JIRA_USER_EMAIL=your_email
JIRA_TYPE=cloud
JIRA_AUTH_TYPE=basic
TRANSPORT_MODE=http
HTTP_PORT=3000
```

2. **The server will start with Streamable HTTP endpoint:**

```
╔════════════════════════════════════════════════════════════╗
║  🚀 JIRA MCP Server - Streamable HTTP Transport           ║
╠════════════════════════════════════════════════════════════╣
║  Protocol:        MCP 2025-03-26 (Streamable HTTP)       ║
║  Endpoint:        http://localhost:3000/mcp               ║
║  Health Check:    http://localhost:3000/health            ║
║                                                            ║
║  🔧 Supported Methods:                                     ║
║     GET /mcp     → Establish SSE connection               ║
║     POST /mcp    → Send JSON-RPC message                  ║
║     DELETE /mcp  → Terminate session                      ║
╚════════════════════════════════════════════════════════════╝
```

3. **Configure MCP Inspector:**

In MCP Inspector v0.15.x+, add a new server connection:
```json
{
  "mcpServers": {
    "jira": {
      "type": "sse",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

4. **Configure Postman MCP Client:**

In Postman, add a new MCP server connection:
- **URL**: `http://localhost:3000/mcp`
- **Method**: GET
- **Transport**: SSE (Server-Sent Events)

Or import the provided Postman collection: `tests/manual/postman_collection.json`

The server implements the MCP Streamable HTTP protocol (2025-03-26) with full session management and is compatible with MCP Inspector v0.15.x and Postman MCP Client.

### 4. Restart the MCP server

**For STDIO mode**: Within Cline's MCP settings, restart the MCP server. Restart Claude Desktop to load the new MCP server.

**For HTTP mode**: Simply run the server with `TRANSPORT_MODE=http` environment variable set.

## Development

Run tests:

```bash
bun test
```

Watch mode for development:

```bash
bun run dev
```

To rebuild after changes:

```bash
bun run build
```

## Available MCP Tools

### search_issues

Search JIRA issues using JQL. Returns up to 50 results per request.

Input Schema:

```typescript
{
  searchString: string; // JQL search string
}
```

### get_epic_children

Get all child issues in an epic including their comments and relationship data. Limited to 100 issues per request.

Input Schema:

```typescript
{
  epicKey: string; // The key of the epic issue
}
```

### get_issue

Get detailed information about a specific JIRA issue including comments and all relationships.

Input Schema:

```typescript
{
  issueId: string; // The ID or key of the JIRA issue
}
```

### create_issue

Create a new JIRA issue with specified fields.

Input Schema:

```typescript
{
  projectKey: string, // The project key where the issue will be created
  issueType: string, // The type of issue (e.g., "Bug", "Story", "Task")
  summary: string, // The issue summary/title
  description?: string, // Optional issue description
  fields?: { // Optional additional fields
    [key: string]: any
  }
}
```

### update_issue

Update fields of an existing JIRA issue.

Input Schema:

```typescript
{
  issueKey: string, // The key of the issue to update
  fields: { // Fields to update
    [key: string]: any
  }
}
```

### add_attachment

Add a file attachment to a JIRA issue.

Input Schema:

```typescript
{
  issueKey: string, // The key of the issue
  fileContent: string, // Base64 encoded file content
  filename: string // Name of the file to be attached
}
```

### add_comment

Add a comment to a JIRA issue. Accepts plain text and converts it to the required Atlassian Document Format internally.

Input Schema:

```typescript
{
  issueIdOrKey: string, // The ID or key of the issue to add the comment to
  body: string // The content of the comment (plain text)
}
```

## Data Cleaning Features

- Extracts text from Atlassian Document Format
- Tracks issue mentions in descriptions and comments
- Maintains formal issue links with relationship types
- Preserves parent/child relationships
- Tracks epic associations
- Includes comment history with author information
- Removes unnecessary metadata from responses
- Recursively processes content nodes for mentions
- Deduplicates issue mentions

## Technical Details

- Built with TypeScript in strict mode
- Uses Bun runtime for improved performance
- Vite for optimized builds
- **Dual transport support:**
  - **STDIO**: For Claude Desktop and Cline (default)
  - **Streamable HTTP (MCP 2025-03-26)**: For MCP Inspector v0.15.x+ and Postman MCP Client
- Session management with automatic cleanup (1-hour expiry)
- UUID-based session tracking with `Mcp-Session-Id` headers
- Uses JIRA REST API v3 (Cloud) or v2 (Server/Data Center)
- Supports multiple authentication methods:
  - Basic authentication with API tokens or username/password
  - Bearer authentication with Personal Access Tokens (PATs)
- Batched API requests for related data
- Optimized response payloads for AI context windows
- Efficient transformation of complex Atlassian structures
- Robust error handling
- Rate limiting considerations
- Maximum limits:
  - Search results: 50 issues per request
  - Epic children: 100 issues per request
- Support for multipart form data for secure file attachments
- Automatic content type detection and validation
- CORS enabled for cross-origin requests in HTTP mode

## Error Handling

The server implements a comprehensive error handling strategy:

- Network error detection and appropriate messaging
- HTTP status code handling (especially 404 for issues)
- Detailed error messages with status codes
- Error details logging to console
- Input validation for all parameters
- Safe error propagation through MCP protocol
- Specialized handling for common JIRA API errors
- Base64 validation for attachments
- Multipart request failure handling
- Rate limit detection
- Attachment parameter validation

## Transport Modes Comparison

| Feature | STDIO Transport | Streamable HTTP Transport |
|---------|----------------|---------------------------|
| **Use Case** | Claude Desktop, Cline | MCP Inspector, Postman, HTTP clients |
| **Protocol** | MCP over stdio | MCP Streamable HTTP (2025-03-26) |
| **Configuration** | MCP config file | Environment variables |
| **Connection** | Process stdin/stdout | HTTP + Server-Sent Events |
| **Default Port** | N/A | 3000 |
| **Session Management** | N/A | Yes (UUID-based, 1-hour expiry) |
| **Endpoints** | N/A | GET/POST/DELETE `/mcp` |
| **CORS Support** | N/A | Yes |
| **Health Check** | No | Yes (`/health` endpoint) |
| **Best For** | Production AI assistants | Development, testing, debugging |
| **Inspector Compatibility** | N/A | v0.15.x+ |

### Manual Testing

The `tests/manual/` directory contains comprehensive test scripts:
- `test_sse.sh` - Test SSE connection and session establishment
- `test_initialize.sh` - Test initialize handshake
- `test_tools_list.sh` - Test tools/list request
- `test_tool_execution.sh` - Test tool execution (search_issues)
- `postman_collection.json` - Complete Postman test collection
- `README.md` - Detailed testing instructions

Run all tests:
```bash
cd tests/manual
./test_sse.sh
./test_initialize.sh
./test_tools_list.sh
./test_tool_execution.sh
```

## LICENCE

This project is licensed under the MIT License - see the [LICENCE](LICENCE) file for details.
