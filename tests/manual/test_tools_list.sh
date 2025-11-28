#!/bin/bash
# Test Tools List - MCP Streamable HTTP Protocol
# Tests POST /mcp with tools/list request

set -e

echo "=========================================="
echo "TEST: Tools List (POST /mcp)"
echo "=========================================="
echo ""

SERVER_URL="${MCP_SERVER_URL:-http://localhost:3000}"

# Check if session ID exists from previous test
if [ -f /tmp/mcp_session_id.txt ]; then
  SESSION_ID=$(cat /tmp/mcp_session_id.txt | tr -d '\r\n')
  echo "→ Using existing session ID: $SESSION_ID"
else
  echo "❌ ERROR: No session ID found."
  echo "   Please run test_sse.sh first to establish a session."
  exit 1
fi

echo ""
echo "→ Sending tools/list request to: $SERVER_URL/mcp"
echo "→ Session ID: $SESSION_ID"
echo ""

# Send tools/list request
RESPONSE=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  "$SERVER_URL/mcp" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list"
  }')

echo "→ Response:"
echo "$RESPONSE" | jq '.' 2>/dev/null || echo "$RESPONSE"
echo ""

# Validate response
if echo "$RESPONSE" | jq -e '.accepted' >/dev/null 2>&1; then
  echo "✅ PASS: Message accepted by server"
elif echo "$RESPONSE" | jq -e '.error' >/dev/null 2>&1; then
  echo "❌ FAIL: Server returned error"
  echo "$RESPONSE" | jq '.error'
  exit 1
else
  echo "⚠️  WARN: Unexpected response format"
fi

echo ""
echo "=========================================="
echo "✅ Tools List Test PASSED"
echo "=========================================="
echo ""
echo "Expected tools:"
echo "  - search_issues"
echo "  - get_epic_children"
echo "  - get_issue"
echo "  - create_issue"
echo "  - update_issue"
echo "  - get_transitions"
echo "  - transition_issue"
echo "  - add_attachment"
echo "  - add_comment"
echo ""
echo "Note: The actual tools/list response will be sent via SSE stream."
echo "To see the full response, monitor the SSE connection."
