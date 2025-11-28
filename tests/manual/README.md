# MCP Streamable HTTP Transport - Manual Tests

This directory contains manual test scripts for validating the MCP Streamable HTTP transport implementation (protocol version 2025-03-26).

## Test Scripts

### 1. `test_sse.sh` - SSE Connection Test
Tests the SSE connection establishment and validates:
- ✅ SSE headers (Content-Type, Cache-Control, Connection)
- ✅ `Mcp-Session-Id` header presence
- ✅ Session ID format (UUID)

**Usage:**
```bash
./test_sse.sh
```

**Expected Output:**
- Session ID saved to `/tmp/mcp_session_id.txt`
- All header validation checks pass

---

### 2. `test_initialize.sh` - Initialize Handshake Test
Tests the MCP initialize handshake:
- ✅ POST /mcp with session ID
- ✅ Initialize request format (JSON-RPC 2.0)
- ✅ Protocol version: 2025-03-26
- ✅ Message acceptance

**Usage:**
```bash
# After running test_sse.sh
./test_initialize.sh
```

**Expected Output:**
- Message accepted (HTTP 202)
- Initialize response sent via SSE (check SSE stream)

---

### 3. `test_tools_list.sh` - Tools List Test
Tests the tools/list request:
- ✅ POST /mcp with valid session
- ✅ tools/list method
- ✅ Response with available tools

**Usage:**
```bash
./test_tools_list.sh
```

**Expected Tools:**
- search_issues
- get_epic_children
- get_issue
- create_issue
- update_issue
- get_transitions
- transition_issue
- add_attachment
- add_comment

---

### 4. `test_tool_execution.sh` - Tool Execution Test
Tests actual tool execution (search_issues):
- ✅ POST /mcp with tools/call
- ✅ Tool parameter validation
- ✅ Jira API integration

**Usage:**
```bash
# With Jira credentials configured
export JIRA_API_TOKEN="your_token"
export JIRA_BASE_URL="https://your-jira.com"
export JIRA_USER_EMAIL="your_email"
export TEST_JQL="project = QT"

./test_tool_execution.sh
```

**Expected Output:**
- Message accepted
- Tool execution result sent via SSE
- Jira search results

---

### 5. `postman_collection.json` - Postman Test Collection
Complete Postman collection with:
- ✅ All endpoint tests
- ✅ Automated session ID capture
- ✅ Validation scripts
- ✅ Error case testing

**Import to Postman:**
1. Open Postman
2. Click **Import**
3. Select `postman_collection.json`
4. Set environment variables:
   - `base_url`: `http://localhost:3000`

**Test Execution:**
Run tests in order:
1. Health Check
2. Establish SSE Connection
3. Initialize
4. List Tools
5. Call Tool
6. Test Invalid Session
7. Test Missing Session ID
8. Delete Session

---

## Running All Tests

To run all tests in sequence:

```bash
#!/bin/bash
# Run all MCP transport tests

echo "Starting MCP Streamable HTTP tests..."

# 1. Start the server (in another terminal first!)
# export TRANSPORT_MODE=http
# bun run build/index.js

# 2. Wait for server to start
sleep 2

# 3. Run tests
cd tests/manual

echo "Test 1: SSE Connection"
./test_sse.sh

echo ""
echo "Test 2: Initialize Handshake"
./test_initialize.sh

echo ""
echo "Test 3: Tools List"
./test_tools_list.sh

echo ""
echo "Test 4: Tool Execution"
./test_tool_execution.sh

echo ""
echo "✅ All tests completed!"
```

---

## Environment Variables

### Required for Server
```bash
JIRA_API_TOKEN="your_api_token"
JIRA_BASE_URL="https://your-jira.com"
JIRA_USER_EMAIL="your_email@domain.com"
JIRA_TYPE="server"           # or "cloud"
JIRA_AUTH_TYPE="basic"       # or "bearer"
TRANSPORT_MODE="http"
HTTP_PORT="3000"
```

### Optional for Tests
```bash
MCP_SERVER_URL="http://localhost:3000"  # Override default URL
TEST_JQL="project = QT"                 # Override default JQL query
```

---

## Troubleshooting

### Issue: "No session ID found"
**Solution:** Run `test_sse.sh` first to establish a session.

### Issue: "Invalid or expired session"
**Solution:** Sessions expire after 1 hour. Re-run `test_sse.sh` to create a new session.

### Issue: "Connection refused"
**Solution:** Ensure the MCP server is running:
```bash
export TRANSPORT_MODE=http
bun run build/index.js
```

### Issue: "Jira authentication error"
**Solution:** Verify Jira credentials:
```bash
echo $JIRA_API_TOKEN
echo $JIRA_BASE_URL
echo $JIRA_USER_EMAIL
```

---

## Protocol Compliance

These tests validate compliance with:
- ✅ MCP Specification 2025-03-26
- ✅ Streamable HTTP transport
- ✅ JSON-RPC 2.0 protocol
- ✅ Session management requirements
- ✅ SSE streaming requirements
- ✅ MCP Inspector v0.15.x compatibility
- ✅ Postman MCP Client compatibility

---

## Test Results

Document test results:

| Test | Status | Date | Notes |
|------|--------|------|-------|
| SSE Connection | ✅ PASS | YYYY-MM-DD | Session ID: xxx |
| Initialize | ✅ PASS | YYYY-MM-DD | Protocol: 2025-03-26 |
| Tools List | ✅ PASS | YYYY-MM-DD | 9 tools available |
| Tool Execution | ✅ PASS | YYYY-MM-DD | search_issues working |
| Postman Collection | ✅ PASS | YYYY-MM-DD | All 7 tests pass |

---

## Additional Resources

- [MCP Specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
- [Postman MCP Client](https://www.postman.com)
- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
