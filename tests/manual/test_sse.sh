#!/bin/bash
# Test SSE Connection - MCP Streamable HTTP Protocol
# Tests GET /mcp endpoint and validates SSE headers + session ID

set -e

echo "=========================================="
echo "TEST: SSE Connection (GET /mcp)"
echo "=========================================="
echo ""

SERVER_URL="${MCP_SERVER_URL:-http://localhost:3000}"

echo "→ Testing SSE connection to: $SERVER_URL/mcp"
echo "→ Expected: SSE stream with Mcp-Session-Id header"
echo ""

# Test SSE connection and capture headers
echo "→ Sending request..."
RESPONSE=$(curl -N -v \
  -H "Accept: text/event-stream" \
  "$SERVER_URL/mcp" \
  2>&1 | head -n 30)

echo "$RESPONSE"
echo ""

# Validate response
if echo "$RESPONSE" | grep -q "Content-Type: text/event-stream"; then
  echo "✅ PASS: Content-Type is text/event-stream"
else
  echo "❌ FAIL: Missing Content-Type: text/event-stream"
  exit 1
fi

if echo "$RESPONSE" | grep -q "Mcp-Session-Id:"; then
  SESSION_ID=$(echo "$RESPONSE" | grep "Mcp-Session-Id:" | cut -d' ' -f3 | tr -d '\r')
  echo "✅ PASS: Mcp-Session-Id header present: $SESSION_ID"

  # Export session ID for other tests
  echo "$SESSION_ID" > /tmp/mcp_session_id.txt
  echo ""
  echo "→ Session ID saved to: /tmp/mcp_session_id.txt"
else
  echo "❌ FAIL: Missing Mcp-Session-Id header"
  exit 1
fi

if echo "$RESPONSE" | grep -q "Connection: keep-alive"; then
  echo "✅ PASS: Connection: keep-alive header present"
else
  echo "⚠️  WARN: Missing Connection: keep-alive header"
fi

if echo "$RESPONSE" | grep -q "Cache-Control: no-cache"; then
  echo "✅ PASS: Cache-Control: no-cache header present"
else
  echo "⚠️  WARN: Missing Cache-Control: no-cache header"
fi

echo ""
echo "=========================================="
echo "✅ SSE Connection Test PASSED"
echo "=========================================="
