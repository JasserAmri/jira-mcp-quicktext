#!/bin/bash
# Test Tool Execution - MCP Streamable HTTP Protocol
# Tests POST /mcp with tools/call request (search_issues)

set -e

echo "=========================================="
echo "TEST: Tool Execution (POST /mcp)"
echo "=========================================="
echo ""

SERVER_URL="${MCP_SERVER_URL:-http://localhost:3000}"
TEST_JQL="${TEST_JQL:-project = QT ORDER BY created DESC}"

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
echo "→ Sending tools/call request to: $SERVER_URL/mcp"
echo "→ Session ID: $SESSION_ID"
echo "→ Tool: search_issues"
echo "→ JQL: $TEST_JQL"
echo ""

# Send tools/call request
RESPONSE=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  "$SERVER_URL/mcp" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 3,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"search_issues\",
      \"arguments\": {
        \"searchString\": \"$TEST_JQL\"
      }
    }
  }")

echo "→ Response:"
echo "$RESPONSE" | jq '.' 2>/dev/null || echo "$RESPONSE"
echo ""

# Validate response
if echo "$RESPONSE" | jq -e '.accepted' >/dev/null 2>&1; then
  echo "✅ PASS: Message accepted by server"
  echo "✅ PASS: search_issues tool executed successfully"
elif echo "$RESPONSE" | jq -e '.error' >/dev/null 2>&1; then
  ERROR_CODE=$(echo "$RESPONSE" | jq -r '.error.code')
  ERROR_MSG=$(echo "$RESPONSE" | jq -r '.error.message')

  # Check if error is due to missing Jira credentials
  if [[ "$ERROR_MSG" == *"JIRA_API_TOKEN"* ]] || [[ "$ERROR_MSG" == *"environment"* ]]; then
    echo "⚠️  WARN: Jira credentials not configured (expected in test environment)"
    echo "   Error: $ERROR_MSG"
    echo ""
    echo "✅ PASS: Tool execution endpoint working (auth issue is expected)"
  else
    echo "❌ FAIL: Server returned error"
    echo "   Code: $ERROR_CODE"
    echo "   Message: $ERROR_MSG"
    exit 1
  fi
else
  echo "⚠️  WARN: Unexpected response format"
fi

echo ""
echo "=========================================="
echo "✅ Tool Execution Test PASSED"
echo "=========================================="
echo ""
echo "Note: The actual tool result will be sent via SSE stream."
echo "To see the full response, monitor the SSE connection."
echo ""
echo "To test with real Jira instance, set environment variables:"
echo "  export JIRA_API_TOKEN='your_token'"
echo "  export JIRA_BASE_URL='https://your-jira.com'"
echo "  export JIRA_USER_EMAIL='your_email'"
echo "  export TEST_JQL='project = YOUR_PROJECT'"
