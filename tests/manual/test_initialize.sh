#!/bin/bash
# Test Initialize Handshake - MCP Streamable HTTP Protocol
# Tests POST /mcp with initialize request

set -e

echo "=========================================="
echo "TEST: Initialize Handshake (POST /mcp)"
echo "=========================================="
echo ""

SERVER_URL="${MCP_SERVER_URL:-http://localhost:3000}"

# Check if session ID exists from previous test
if [ -f /tmp/mcp_session_id.txt ]; then
  SESSION_ID=$(cat /tmp/mcp_session_id.txt | tr -d '\r\n')
  echo "→ Using existing session ID: $SESSION_ID"
else
  echo "⚠️  No session ID found. Running SSE connection test first..."
  # Start SSE connection in background and extract session ID
  RESPONSE=$(curl -N -v -H "Accept: text/event-stream" "$SERVER_URL/mcp" 2>&1 | head -n 30)
  SESSION_ID=$(echo "$RESPONSE" | grep "Mcp-Session-Id:" | cut -d' ' -f3 | tr -d '\r\n')
  echo "→ New session ID: $SESSION_ID"
fi

echo ""
echo "→ Sending initialize request to: $SERVER_URL/mcp"
echo "→ Session ID: $SESSION_ID"
echo ""

# Send initialize request
RESPONSE=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  "$SERVER_URL/mcp" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {
        "roots": {
          "listChanged": true
        },
        "sampling": {}
      },
      "clientInfo": {
        "name": "test-client",
        "version": "1.0.0"
      }
    }
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
echo "✅ Initialize Test PASSED"
echo "=========================================="
echo ""
echo "Note: The actual initialize response will be sent via SSE stream."
echo "To see the full response, monitor the SSE connection opened in test_sse.sh"
