#!/usr/bin/env node

/**
 * QuickText Jira MCP Server v4.6.0 (Production-Ready)
 * Enhanced with MCP Best Practices + Phase 2 Discovery Suite
 * 
 * Production Features:
 * ✅ Vendor Prefix: All tools use quicktext-jira_ prefix (underscore, not slash)
 * ✅ Enhanced Descriptions: Comprehensive tool documentation with examples
 * ✅ Structured Errors: Machine-readable error codes (JIRA_1xxx-5xxx)
 * ✅ Tool Count: 53 tools (50 core + 3 Attachment Suite)
 * ✅ Structured Outputs: JSON schemas with validation
 * ✅ Jira Agile API: Uses /rest/agile/1.0/ for board/sprint discovery
 * ✅ Data Center Compatible: Tested on Jira v9.4.5
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Jira configuration — read from environment variables (set via .env or MCP client config)
const JIRA_BASE_URL = process.env.JIRA_BASE_URL ?? '';
const JIRA_PAT = process.env.JIRA_API_TOKEN ?? '';
const JIRA_AUTH_TYPE = process.env.JIRA_AUTH_TYPE ?? 'bearer';
const JIRA_USER_EMAIL = process.env.JIRA_USER_EMAIL ?? '';

if (!JIRA_BASE_URL || !JIRA_PAT) {
  console.error('ERROR: Missing required environment variables.');
  console.error('  JIRA_BASE_URL and JIRA_API_TOKEN must be set.');
  console.error('  Copy .env.example to .env and fill in your values,');
  console.error('  or set them in your MCP client configuration (claude_desktop_config.json).');
  process.exit(1);
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

// Rate limit tracking
let rateLimitInfo = {
  remaining: null,
  limit: null,
  reset: null,
};

// Create server
const server = new Server(
  {
    name: "jira-enhanced-quicktext",
    version: "4.7.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Structured error helper
function createError(code, message, details = {}, suggestedAction = null) {
  return {
    error_code: code,
    error_message: message,
    details,
    suggested_action: suggestedAction,
    timestamp: new Date().toISOString(),
  };
}

// Jira API helper with rate limit tracking and error handling
async function jiraRequest(endpoint, options = {}) {
  const url = `${JIRA_BASE_URL}${endpoint}`;
  
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        "Authorization": JIRA_AUTH_TYPE === 'basic'
          ? `Basic ${Buffer.from(`${JIRA_USER_EMAIL}:${JIRA_PAT}`).toString('base64')}`
          : `Bearer ${JIRA_PAT}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...options.headers,
      },
    });

    // Track rate limits
    if (response.headers.has("X-RateLimit-Remaining")) {
      rateLimitInfo.remaining = parseInt(response.headers.get("X-RateLimit-Remaining"));
    }
    if (response.headers.has("X-RateLimit-Limit")) {
      rateLimitInfo.limit = parseInt(response.headers.get("X-RateLimit-Limit"));
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
        throw createError(
          ErrorCodes.ISSUE_NOT_FOUND,
          "Resource not found",
          { status: response.status, endpoint },
          "Verify issue key, project key, or sprint name is correct"
        );
      } else if (response.status === 429) {
        throw createError(
          ErrorCodes.RATE_LIMIT_EXCEEDED,
          "Rate limit exceeded",
          { status: response.status, rate_limit: rateLimitInfo },
          "Wait before retrying. Check X-RateLimit-Reset header"
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
    return text ? JSON.parse(text) : {};
  } catch (error) {
    if (error.error_code) {
      throw error; // Already a structured error
    }
    
    throw createError(
      ErrorCodes.NETWORK_ERROR,
      `Network error: ${error.message}`,
      { endpoint, original_error: error.message },
      "Check network connectivity and Jira server status"
    );
  }
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
    const sizeMb = (parseInt(contentLength) / 1024 / 1024).toFixed(2);
    const maxMb = (maxBytes / 1024 / 1024).toFixed(0);
    throw createError(
      ErrorCodes.INVALID_PARAMETER,
      `File too large to download (${sizeMb} MB). Increase max_size_mb (current: ${maxMb}).`,
      { size_bytes: parseInt(contentLength), max_bytes: maxBytes }
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.length > maxBytes) {
    const sizeMb = (buffer.length / 1024 / 1024).toFixed(2);
    const maxMb = (maxBytes / 1024 / 1024).toFixed(0);
    throw createError(
      ErrorCodes.INVALID_PARAMETER,
      `File too large to download (${sizeMb} MB). Increase max_size_mb (current: ${maxMb}).`,
      { size_bytes: buffer.length, max_bytes: maxBytes }
    );
  }

  return { buffer, contentType };
}

// Helper: Parse time logged by role from customfield_10300
function parseTimeLoggedByRole(customfield10300) {
  const roles = { Developer: 0, Tester: 0, Reviewer: 0 };
  
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
function parseAssigneeRoles(customfield10301) {
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

// Helper: Parse sprint from Jira's Java toString() format
// Format: "com.atlassian.greenhopper.service.sprint.Sprint@xxx[id=304,rapidViewId=4,state=ACTIVE,name=QUIC Sprint 197,startDate=2026-01-27T15:17:00.000Z,endDate=2026-02-10T15:17:00.000Z,...]"
function parseSprint(sprintData) {
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
function parseSprints(customfield10008) {
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
        name: "quicktext-jira_get_full_issue",
        description: "Get COMPLETE issue details including descriptions, comments, assignee names, priority, and all custom fields. Example: quicktext-jira_get_full_issue({issue_key: 'QT-14006'})",
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
        name: "quicktext-jira_search_sprint_issues",
        description: "Search all issues in current or specific sprint with FULL field data including assignees, priorities, descriptions. Returns paginated results with total count. Example: quicktext-jira_search_sprint_issues({project_key: 'QT', max_results: 500})",
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
              type: "number",
              description: "Maximum results to return (default: 500)",
              default: 500,
            },
          },
          required: ["project_key"],
        },
      },
      
      // 3. TEAM WORKLOAD
      {
        name: "quicktext-jira_get_team_workload",
        description: "Analyze team workload distribution for current sprint with assignee names and ticket counts grouped by status. Includes unassigned tickets. Example: quicktext-jira_get_team_workload({project_key: 'QT'})",
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
        name: "quicktext-jira_analyze_hotfixes",
        description: "Analyze all HOTFIX tickets in current sprint - groups by component, identifies patterns, calculates ratio vs total tickets. Detects 'HOTFIX' and 'HTOFIX' typo variants. Example: quicktext-jira_analyze_hotfixes({project_key: 'QT'})",
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
        name: "quicktext-jira_search_advanced",
        description: "Advanced JQL search with custom field selection. Supports complex queries with AND/OR logic, custom fields, date ranges. Example: quicktext-jira_search_advanced({jql: 'project = QT AND status = \"In Progress\"', max_results: 100})",
        inputSchema: {
          type: "object",
          properties: {
            jql: {
              type: "string",
              description: "JQL query string (e.g., 'project = QT AND assignee = currentUser()')",
            },
            max_results: {
              type: "number",
              description: "Maximum results (default: 100)",
              default: 100,
            },
          },
          required: ["jql"],
        },
      },
      
      // 6. TIME METRICS
      {
        name: "quicktext-jira_get_time_metrics",
        description: "Extract time estimates and logged time BY ROLE (dev/test/review) for current sprint. Includes ticket-level breakdown and sprint totals in hours/days. Example: quicktext-jira_get_time_metrics({project_key: 'QT'})",
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
        name: "quicktext-jira_get_unassigned_by_role",
        description: "Count tickets unassigned for DEVELOPER vs TESTER roles separately. Helps identify bottlenecks in role-based assignment workflow. Example: quicktext-jira_get_unassigned_by_role({project_key: 'QT'})",
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
        name: "quicktext-jira_search_by_labels",
        description: "Search tickets by specific labels (rg for regressions, SprintGoal, etc.) with status breakdown. Returns count, status distribution, and ticket list per label. Example: quicktext-jira_search_by_labels({project_key: 'QT', labels: ['rg', 'SprintGoal']})",
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
        name: "quicktext-jira_get_rate_limits",
        description: "Check current API rate limit status and remaining quota. Returns limit, remaining requests, reset time, and status (OK/WARNING). Example: quicktext-jira_get_rate_limits({})",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      
      // 10. GET ALL LABELS
      {
        name: "quicktext-jira_get_all_labels",
        description: "Discover all labels used in project with usage counts. Helps identify available labels for filtering. Example: quicktext-jira_get_all_labels({project_key: 'QT'})",
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
      
      // 11. TIME IN STATUS
      {
        name: "quicktext-jira_get_time_in_status",
        description: "Calculate average time issues spend in each status (To Do, In Progress, Done, etc.). Identifies workflow bottlenecks. Example: quicktext-jira_get_time_in_status({project_key: 'QT'})",
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
        name: "quicktext-jira_list_sprints",
        description: "List all sprints in project with status (active/closed/future), start/end dates, and goal. Example: quicktext-jira_list_sprints({project_key: 'QT', board_id: 58})",
        inputSchema: {
          type: "object",
          properties: {
            project_key: {
              type: "string",
              description: "Project key (e.g., 'QT')",
              default: "QT",
            },
            board_id: {
              type: "number",
              description: "Board ID to fetch sprints from",
            },
          },
          required: ["project_key"],
        },
      },
      
      // 13. CREATE ISSUE
      {
        name: "quicktext-jira_create_issue",
        description: "Create new Jira issue with full field support. User fields (assignee, tester, reviewer) use Jira DC username (the 'name' field, e.g. 'osg', 'hga'). Example: quicktext-jira_create_issue({project_key: 'QT', summary: 'Bug found', issue_type: 'Bug', assignee: 'osg'})",
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
              type: "number",
              description: "Sprint ID to assign the issue to (use list_sprints to find IDs)",
            },
            story_points: {
              type: "number",
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
        name: "quicktext-jira_update_issue",
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
Example: quicktext-jira_update_issue({issue_key: 'QT-123', fields: {assignee: {name: 'osg'}}})`,
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
        name: "quicktext-jira_transition_issue",
        description: "Change issue status (To Do → In Progress → Done, etc.). Use get_transitions to see available transitions first. Example: quicktext-jira_transition_issue({issue_key: 'QT-123', transition_id: '31'})",
        inputSchema: {
          type: "object",
          properties: {
            issue_key: {
              type: "string",
              description: "Issue key (e.g., 'QT-14006')",
            },
            transition_id: {
              type: "string",
              description: "Transition ID (get from quicktext-jira_get_transitions)",
            },
          },
          required: ["issue_key", "transition_id"],
        },
      },
      
      // 16. ADD COMMENT
      {
        name: "quicktext-jira_add_comment",
        description: "Add comment to issue. Supports markdown formatting. Returns comment ID. Example: quicktext-jira_add_comment({issue_key: 'QT-123', body: 'This is fixed now'})",
        inputSchema: {
          type: "object",
          properties: {
            issue_key: {
              type: "string",
              description: "Issue key (e.g., 'QT-14006')",
            },
            body: {
              type: "string",
              description: "Comment text (supports markdown)",
            },
          },
          required: ["issue_key", "body"],
        },
      },
      
      // 17. ADD ATTACHMENT
      {
        name: "quicktext-jira_add_attachment",
        description: "Add file attachment to issue. Requires file path or base64 content. Example: quicktext-jira_add_attachment({issue_key: 'QT-123', filename: 'screenshot.png', content_base64: '...'})",
        inputSchema: {
          type: "object",
          properties: {
            issue_key: {
              type: "string",
              description: "Issue key (e.g., 'QT-14006')",
            },
            filename: {
              type: "string",
              description: "Filename with extension",
            },
            content_base64: {
              type: "string",
              description: "Base64 encoded file content",
            },
          },
          required: ["issue_key", "filename", "content_base64"],
        },
      },
      
      // 18. GET EPIC CHILDREN
      {
        name: "quicktext-jira_get_epic_children",
        description: "Get all issues linked to an epic with full details. Includes story points, assignees, status. Example: quicktext-jira_get_epic_children({epic_key: 'QT-1000'})",
        inputSchema: {
          type: "object",
          properties: {
            epic_key: {
              type: "string",
              description: "Epic issue key (e.g., 'QT-1000')",
            },
            max_results: {
              type: "number",
              description: "Maximum child issues to return (default: 100)",
              default: 100,
            },
          },
          required: ["epic_key"],
        },
      },
      
      // 19. GET TRANSITIONS
      {
        name: "quicktext-jira_get_transitions",
        description: "Get available status transitions for an issue (what statuses it can move to). Required before calling transition_issue. Example: quicktext-jira_get_transitions({issue_key: 'QT-123'})",
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
        name: "quicktext-jira_get_custom_fields",
        description: "Discover all custom field IDs and names in QuickText Jira. Useful for understanding field mapping (customfield_10023 = Story point estimate, etc.). Example: quicktext-jira_get_custom_fields({})",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      
      // 21. SEARCH BY ASSIGNEE
      {
        name: "quicktext-jira_search_by_assignee",
        description: "Find all tickets assigned to specific user(s) in current sprint. Supports multiple assignees. Example: quicktext-jira_search_by_assignee({project_key: 'QT', assignee_names: ['John Doe']})",
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
        name: "quicktext-jira_get_status_distribution",
        description: "Analyze ticket distribution across statuses (To Do, In Progress, Done, etc.) for current sprint. Shows percentages and counts. Example: quicktext-jira_get_status_distribution({project_key: 'QT'})",
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
        name: "quicktext-jira_get_reporter_stats",
        description: "Analyze who creates the most tickets (reporters) in current sprint. Shows counts, percentages, and top reporters. Example: quicktext-jira_get_reporter_stats({project_key: 'QT'})",
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
        name: "quicktext-jira_get_issue_links",
        description: "Get all linked issues (blocks, is blocked by, relates to, duplicates, etc.). Shows relationship types and linked issue details. Example: quicktext-jira_get_issue_links({issue_key: 'QT-123'})",
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
        name: "quicktext-jira_get_issue_history",
        description: "Get complete change history for an issue (who changed what and when). Includes field changes, status transitions, assignments. Example: quicktext-jira_get_issue_history({issue_key: 'QT-123'})",
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
        name: "quicktext-jira_get_sprint_velocity",
        description: "Calculate sprint velocity (story points completed per sprint) over last N sprints. Helps with capacity planning. Example: quicktext-jira_get_sprint_velocity({project_key: 'QT', sprint_count: 5})",
        inputSchema: {
          type: "object",
          properties: {
            project_key: {
              type: "string",
              description: "Project key (e.g., 'QT')",
              default: "QT",
            },
            sprint_count: {
              type: "number",
              description: "Number of past sprints to analyze (default: 3)",
              default: 3,
            },
          },
          required: ["project_key"],
        },
      },
      {
        name: "quicktext-jira_get_blocked_tickets",
        description: "Find all tickets currently blocked or with 'blocked' status. Critical for identifying sprint impediments. Example: quicktext-jira_get_blocked_tickets({project_key: 'QT'})",
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
        name: "quicktext-jira_get_priority_breakdown",
        description: "Analyze ticket distribution by priority (Highest, High, Medium, Low). Shows counts and percentages. Example: quicktext-jira_get_priority_breakdown({project_key: 'QT'})",
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
        name: "quicktext-jira_get_component_breakdown",
        description: "Analyze tickets by component (Backend, Frontend, QA, etc.). Identifies which components have most issues. Example: quicktext-jira_get_component_breakdown({project_key: 'QT'})",
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
        name: "quicktext-jira_bulk_transition",
        description: "Transition multiple issues to same status at once. Efficient for batch operations. Example: quicktext-jira_bulk_transition({issue_keys: ['QT-1', 'QT-2'], transition_id: '31'})",
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
          },
          required: ["issue_keys", "transition_id"],
        },
      },
      
      // 31. GET SPRINT KPI DATA
      {
        name: "quicktext-jira_get_sprint_kpi_data",
        description: "Fetch comprehensive sprint KPI data including time tracking, test/review frequencies, and role assignments. Returns all data needed for sprint analytics dashboards. Example: quicktext-jira_get_sprint_kpi_data({project_key: 'QT', sprint_name: 'Sprint 191'})",
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
              type: "number",
              description: "Maximum results (default: 1000)",
              default: 1000,
            },
          },
          required: ["project_key"],
        },
      },
      
      // 32. LIST BOARDS (Discovery Suite)
      {
        name: "quicktext-jira_list_boards",
        description: "Discover Scrum/Kanban boards. Use this to find board_ids. Filters: name, project_key. Example: quicktext-jira_list_boards({name: 'QT Board', project_key: 'QT'})",
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
        name: "quicktext-jira_get_board",
        description: "Get configuration and column details for a specific board. Returns board type, location, and configuration including workflow columns. Example: quicktext-jira_get_board({board_id: 58})",
        inputSchema: {
          type: "object",
          properties: {
            board_id: {
              type: "number",
              description: "Board ID (get from list_boards)",
            },
          },
          required: ["board_id"],
        },
      },
      
      // 34. GET SPRINT (Discovery Suite)
      {
        name: "quicktext-jira_get_sprint",
        description: "Get full details of a specific sprint including duration metrics and state. Returns sprint dates, goal, state (active/closed/future), and calculated working days. Example: quicktext-jira_get_sprint({sprint_id: 184})",
        inputSchema: {
          type: "object",
          properties: {
            sprint_id: {
              type: "number",
              description: "Sprint ID (get from list_sprints or list_boards)",
            },
          },
          required: ["sprint_id"],
        },
      },

      // 35. GET TESTER WORKLOAD
      {
        name: "quicktext-jira_get_tester_workload",
        description: "Show workload distribution across testers in the current sprint, grouped by tester name. Reads customfield_10018 (Tester field). Example: quicktext-jira_get_tester_workload({project_key: 'QT'})",
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
        name: "quicktext-jira_get_reviewer_workload",
        description: "Show workload distribution across reviewers in the current sprint, grouped by reviewer name. Reads customfield_10020 (Reviewed By field). Example: quicktext-jira_get_reviewer_workload({project_key: 'QT'})",
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
        name: "quicktext-jira_get_issue_worklogs",
        description: "Get all work log entries for a specific issue showing who logged time, how much, and when. Returns individual worklog records with author details and time spent. Example: quicktext-jira_get_issue_worklogs({issue_key: 'QT-14006'})",
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
        name: "quicktext-jira_get_bulk_worklogs",
        description: "Get worklogs across multiple issues aggregated by author. Shows who actually logged time (not just ticket assignee). Supports filtering by sprint name or date range. WARNING: Makes one API call per issue, use max_issues to limit. Example: quicktext-jira_get_bulk_worklogs({project_key: 'QT', sprint_name: 'QUIC Sprint 198'})",
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
              type: "number",
              description: "Max issues to fetch worklogs for (default: 200). Use small values for testing",
              default: 200,
            },
          },
          required: ["project_key"],
        },
      },

      // 39. GET ISSUE CYCLE TIME
      {
        name: "quicktext-jira_get_issue_cycle_time",
        description: "Calculate cycle time and time-in-status for sprint issues using changelog data. Shows how long tickets spent in each status, identifies bottleneck statuses, and provides per-assignee cycle times. WARNING: Makes one API call per issue. Example: quicktext-jira_get_issue_cycle_time({project_key: 'QT', sprint_name: 'QUIC Sprint 198'})",
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
              type: "number",
              description: "Max issues to process (default: 100). Use small values for testing",
              default: 100,
            },
          },
          required: ["project_key"],
        },
      },
      {
        name: "quicktext-jira_get_mentions",
        description: "Find all issues where a user was @mentioned in comments within a time window. Uses two-step approach: JQL candidate fetch + comment-level [~username] markup scan. Required because Jira DC 9.4 has no native JQL mention operator. Default window: last 2 weeks. Example: quicktext-jira_get_mentions({username_key: 'jam', project_key: 'QT', since: '-2w'})",
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
        name: "quicktext-jira_delete_issue",
        description: "Delete an issue from Jira. Use with caution — this is irreversible. Example: quicktext-jira_delete_issue({issue_key: 'QT-99999', delete_subtasks: true})",
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
        name: "quicktext-jira_move_to_sprint",
        description: "Move one or more issues to a sprint using the Agile API. Use list_sprints to find sprint IDs. Example: quicktext-jira_move_to_sprint({sprint_id: 308, issue_keys: ['QT-123', 'QT-456']})",
        inputSchema: {
          type: "object",
          properties: {
            sprint_id: {
              type: "number",
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
        name: "quicktext-jira_move_to_backlog",
        description: "Move issues to the backlog (remove from any sprint). Example: quicktext-jira_move_to_backlog({issue_keys: ['QT-123']})",
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
        name: "quicktext-jira_add_issue_link",
        description: "Create a link between two issues. Link types: 'Blocks' (outward: blocks / inward: is blocked by), 'Duplicate' (outward: duplicates / inward: is duplicated by), 'Relates' (relates to). Example: quicktext-jira_add_issue_link({link_type: 'Blocks', inward_issue: 'QT-100', outward_issue: 'QT-200'})",
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
        name: "quicktext-jira_add_watcher",
        description: "Add a user as watcher to an issue. Example: quicktext-jira_add_watcher({issue_key: 'QT-123', username: 'osg'})",
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
        name: "quicktext-jira_remove_watcher",
        description: "Remove a user from watchers of an issue. Example: quicktext-jira_remove_watcher({issue_key: 'QT-123', username: 'osg'})",
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
        name: "quicktext-jira_get_watchers",
        description: "Get all watchers of an issue. Example: quicktext-jira_get_watchers({issue_key: 'QT-123'})",
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
        name: "quicktext-jira_get_link_types",
        description: "Get all available issue link types (Blocks, Duplicate, Relates, etc.). Use before add_issue_link to find correct link type names.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },

      // 49. ASSIGN ISSUE
      {
        name: "quicktext-jira_assign_issue",
        description: "Assign an issue to a user using Jira DC's dedicated assignment endpoint. More reliable than update_issue for assignee changes. Use username=null to unassign. Example: quicktext-jira_assign_issue({issue_key: 'QT-123', username: 'osg'})",
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
        name: "quicktext-jira_rank_issues",
        description: "Reorder issues in the backlog/sprint by ranking them before or after another issue. Example: quicktext-jira_rank_issues({issue_keys: ['QT-100'], rank_before: 'QT-200'})",
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
        name: "quicktext-jira_list_attachments",
        description: "List all attachments on a Jira issue with metadata (id, filename, mime_type, size_bytes, download URL, thumbnail URL). Returns empty array when the issue has no attachments. Example: quicktext-jira_list_attachments({issue_key: 'QT-15415'})",
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
        name: "quicktext-jira_get_attachment",
        description: "Download a specific attachment by its ID. Images (PNG/JPEG/GIF/WEBP) are returned as native MCP image blocks so Claude can see them directly. Small text files are returned as decoded text. PDFs and other binaries are returned as base64 in a text block. Example: quicktext-jira_get_attachment({attachment_id: '202820'})",
        inputSchema: {
          type: "object",
          properties: {
            attachment_id: {
              type: "string",
              description: "Attachment ID from quicktext-jira_list_attachments (e.g., '202820')",
            },
            max_size_mb: {
              type: "number",
              description: "Maximum file size to download in MB (default: 10)",
              default: 10,
            },
          },
          required: ["attachment_id"],
        },
      },

      // 53. GET ISSUE ATTACHMENTS BULK
      {
        name: "quicktext-jira_get_issue_attachments_bulk",
        description: "Download all image attachments from an issue in one call (up to 5 images). Returns native MCP image blocks so Claude can see the images directly. Ideal for viewing all visual specs on a ticket. Example: quicktext-jira_get_issue_attachments_bulk({issue_key: 'QT-15415'})",
        inputSchema: {
          type: "object",
          properties: {
            issue_key: {
              type: "string",
              description: "Issue key (e.g., 'QT-15415')",
            },
            max_size_mb: {
              type: "number",
              description: "Max size per image in MB (default: 10)",
              default: 10,
            },
            max_images: {
              type: "number",
              description: "Maximum number of images to download (default: 5, hard cap: 5)",
              default: 5,
            },
          },
          required: ["issue_key"],
        },
      },
    ],
  };
});


// Tool request handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // 1. GET FULL ISSUE
      case "quicktext-jira_get_full_issue": {
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
          `/rest/api/2/issue/${issue_key}?expand=changelog,renderedFields`
        );

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
                  comments: data.fields.comment?.comments?.map(c => ({
                    author: c.author.displayName,
                    body: c.body,
                    created: c.created,
                  })) || [],
                  labels: data.fields.labels || [],
                  components: data.fields.components?.map(c => c.name) || [],
                  story_points: data.fields.customfield_10023,
                  time_estimate: data.fields.timeestimate,
                  time_logged: data.fields.timespent,
                  custom_fields: {
                    customfield_10300: data.fields.customfield_10300, // Time logged by role
                    customfield_10301: data.fields.customfield_10301, // Assignee roles
                  },
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
      case "quicktext-jira_search_sprint_issues": {
        const { project_key, sprint_name, max_results = 500 } = args;
        
        let jql = `project = "${project_key}" AND sprint in openSprints()`;
        
        if (sprint_name) {
          jql = `project = "${project_key}" AND sprint = "${sprint_name}"`;
        }
        
        jql += " ORDER BY created DESC";

        const data = await jiraRequest(
          `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=${max_results}&fields=*all`
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                total: data.total,
                returned: data.issues.length,
                max_results,
                issues: data.issues.map(issue => ({
                  key: issue.key,
                  summary: issue.fields.summary,
                  status: issue.fields.status?.name,
                  priority: issue.fields.priority?.name,
                  assignee: issue.fields.assignee?.displayName || "Unassigned",
                  reporter: issue.fields.reporter?.displayName,
                  created: issue.fields.created,
                  updated: issue.fields.updated,
                  labels: issue.fields.labels || [],
                  components: issue.fields.components?.map(c => c.name) || [],
                  story_points: issue.fields.customfield_10023,
                  assignee_roles: parseAssigneeRoles(issue.fields.customfield_10301),
                  sprints: parseSprints(issue.fields.customfield_10008),
                })),
              }, null, 2),
            },
          ],
        };
      }

      // 3. TEAM WORKLOAD
      case "quicktext-jira_get_team_workload": {
        const { project_key } = args;
        
        const jql = `project = "${project_key}" AND sprint in openSprints() ORDER BY assignee ASC`;
        const data = await jiraRequest(
          `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=1000&fields=assignee,status`
        );

        const workload = {};
        data.issues.forEach(issue => {
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
                total_issues: data.total,
                team_members: Object.keys(workload).length,
                workload,
              }, null, 2),
            },
          ],
        };
      }

      // 4. ANALYZE HOTFIXES
      case "quicktext-jira_analyze_hotfixes": {
        const { project_key } = args;
        
        const jql = `project = "${project_key}" AND sprint in openSprints() AND (summary ~ "HOTFIX" OR summary ~ "HTOFIX") ORDER BY created DESC`;
        const data = await jiraRequest(
          `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=1000&fields=summary,components,status,created`
        );

        const byComponent = {};
        data.issues.forEach(issue => {
          const components = issue.fields.components?.map(c => c.name) || ["No Component"];
          components.forEach(comp => {
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

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                total_hotfixes: data.total,
                by_component: byComponent,
                hotfix_ratio: (data.total / (await jiraRequest(
                  `/rest/api/2/search?jql=${encodeURIComponent(`project = "${project_key}" AND sprint in openSprints()`)}&maxResults=0`
                )).total * 100).toFixed(2) + "%",
              }, null, 2),
            },
          ],
        };
      }

      // 5. ADVANCED SEARCH
      case "quicktext-jira_search_advanced": {
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
                issues: data.issues.map(issue => ({
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
      case "quicktext-jira_get_time_metrics": {
        const { project_key } = args;
        
        const jql = `project = "${project_key}" AND sprint in openSprints()`;
        const data = await jiraRequest(
          `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=1000&fields=summary,timeestimate,customfield_10300`
        );

        const totals = { Developer: 0, Tester: 0, Reviewer: 0 };
        const tickets = data.issues.map(issue => {
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
      case "quicktext-jira_get_unassigned_by_role": {
        const { project_key } = args;
        
        const jql = `project = "${project_key}" AND sprint in openSprints()`;
        const data = await jiraRequest(
          `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=1000&fields=customfield_10301`
        );

        let unassignedDev = 0;
        let unassignedTest = 0;

        data.issues.forEach(issue => {
          const roles = parseAssigneeRoles(issue.fields.customfield_10301);
          if (!roles.dev) unassignedDev++;
          if (!roles.test) unassignedTest++;
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                total_issues: data.total,
                unassigned_developer: unassignedDev,
                unassigned_tester: unassignedTest,
                unassigned_percentage: {
                  developer: ((unassignedDev / data.total) * 100).toFixed(2) + "%",
                  tester: ((unassignedTest / data.total) * 100).toFixed(2) + "%",
                },
              }, null, 2),
            },
          ],
        };
      }

      // 8. SEARCH BY LABELS
      case "quicktext-jira_search_by_labels": {
        const { project_key, labels } = args;
        
        if (!labels || labels.length === 0) {
          throw createError(
            ErrorCodes.MISSING_REQUIRED_FIELD,
            "labels array is required and must not be empty",
            { provided_args: args }
          );
        }

        const results = {};

        for (const label of labels) {
          const jql = `project = "${project_key}" AND sprint in openSprints() AND labels = "${label}"`;
          const data = await jiraRequest(
            `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=1000&fields=status,summary`
          );

          const statusBreakdown = {};
          data.issues.forEach(issue => {
            const status = issue.fields.status?.name || "Unknown";
            statusBreakdown[status] = (statusBreakdown[status] || 0) + 1;
          });

          results[label] = {
            count: data.total,
            status_breakdown: statusBreakdown,
            issues: data.issues.map(i => ({ key: i.key, summary: i.fields.summary })),
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
      case "quicktext-jira_get_rate_limits": {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                rate_limit: {
                  limit: rateLimitInfo.limit || "Unknown",
                  remaining: rateLimitInfo.remaining || "Unknown",
                  reset: rateLimitInfo.reset || "Unknown",
                  status: rateLimitInfo.remaining && rateLimitInfo.remaining < 10 ? "WARNING" : "OK",
                },
              }, null, 2),
            },
          ],
        };
      }

      // 10. GET ALL LABELS
      case "quicktext-jira_get_all_labels": {
        const { project_key } = args;
        
        const jql = `project = "${project_key}"`;
        const data = await jiraRequest(
          `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=1000&fields=labels`
        );

        const labelCounts = {};
        data.issues.forEach(issue => {
          (issue.fields.labels || []).forEach(label => {
            labelCounts[label] = (labelCounts[label] || 0) + 1;
          });
        });

        const sortedLabels = Object.entries(labelCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([label, count]) => ({ label, count }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                total_unique_labels: sortedLabels.length,
                labels: sortedLabels,
              }, null, 2),
            },
          ],
        };
      }

      // 11. TIME IN STATUS
      case "quicktext-jira_get_time_in_status": {
        const { project_key } = args;
        
        const jql = `project = "${project_key}" AND sprint in openSprints()`;
        const data = await jiraRequest(
          `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=1000&fields=status&expand=changelog`
        );

        const statusTimes = {};

        data.issues.forEach(issue => {
          const changelog = issue.changelog?.histories || [];
          let currentStatus = issue.fields.status?.name;
          let currentTime = new Date(issue.fields.created).getTime();

          changelog.forEach(history => {
            const statusChange = history.items.find(item => item.field === "status");
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

        const averages = Object.entries(statusTimes).map(([status, data]) => ({
          status,
          average_hours: (data.total_ms / data.count / 1000 / 3600).toFixed(2),
          issue_count: data.count,
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                averages,
              }, null, 2),
            },
          ],
        };
      }

      // 12. LIST SPRINTS
      case "quicktext-jira_list_sprints": {
        const { project_key, board_id } = args;
        
        if (!board_id) {
          // Fallback: Extract sprint info from issues when board_id is not provided
          const jql = `project = "${project_key}" AND sprint in openSprints()`;
          const data = await jiraRequest(
            `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=1&fields=customfield_10008`
          );
          
          const sprintsMap = new Map();
          data.issues.forEach(issue => {
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
                sprints: data.values.map(sprint => ({
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
      case "quicktext-jira_create_issue": {
        const {
          project_key, summary, description, issue_type = "Task", priority,
          assignee, labels, time_estimate, reviewer_key, tester_key,
          components, fix_versions, due_date, epic_link, parent_key,
          sprint_id, story_points, epic_name,
          // Legacy support
          time_estimate_seconds,
        } = args;

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
        }

        return {
          content: [{ type: "text", text: JSON.stringify(createResult, null, 2) }],
        };
      }

      // 14. UPDATE ISSUE
      case "quicktext-jira_update_issue": {
        const { issue_key, fields } = args;

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
      case "quicktext-jira_transition_issue": {
        const { issue_key, transition_id } = args;
        
        if (!transition_id) {
          throw createError(
            ErrorCodes.MISSING_REQUIRED_FIELD,
            "transition_id is required",
            {},
            "Use quicktext-jira_get_transitions to get available transition IDs"
          );
        }

        await jiraRequest(`/rest/api/2/issue/${issue_key}/transitions`, {
          method: "POST",
          body: JSON.stringify({
            transition: { id: transition_id },
          }),
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: `Issue ${issue_key} transitioned successfully`,
              }, null, 2),
            },
          ],
        };
      }

      // 16. ADD COMMENT
      case "quicktext-jira_add_comment": {
        const { issue_key, body } = args;
        
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
                author: data.author.displayName,
                created: data.created,
              }, null, 2),
            },
          ],
        };
      }

      // 17. ADD ATTACHMENT
      case "quicktext-jira_add_attachment": {
        const { issue_key, filename, content_base64 } = args;

        if (!filename || !content_base64) {
          throw createError(
            ErrorCodes.MISSING_REQUIRED_FIELD,
            "filename and content_base64 are required"
          );
        }

        const fileBuffer = Buffer.from(content_base64, "base64");

        // Build proper multipart/form-data manually (Jira DC requires field name "file")
        const boundary = `----JiraMCPBoundary${Date.now()}`;
        const CRLF = "\r\n";
        const multipartParts = [
          `--${boundary}${CRLF}`,
          `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}`,
          `Content-Type: application/octet-stream${CRLF}`,
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
                message: `Attachment ${filename} added to ${issue_key}`,
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
      case "quicktext-jira_get_epic_children": {
        const { epic_key, max_results = 100 } = args;
        
        const jql = `"Epic Link" = ${epic_key}`;
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
                children: data.issues.map(issue => ({
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
      case "quicktext-jira_get_transitions": {
        const { issue_key } = args;
        
        const data = await jiraRequest(`/rest/api/2/issue/${issue_key}/transitions`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                issue_key,
                available_transitions: data.transitions.map(t => ({
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
      case "quicktext-jira_get_custom_fields": {
        const data = await jiraRequest("/rest/api/2/field");

        const customFields = data
          .filter(field => field.id.startsWith("customfield_"))
          .map(field => ({
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
      case "quicktext-jira_search_by_assignee": {
        const { project_key, assignee_names } = args;
        
        if (!assignee_names || assignee_names.length === 0) {
          throw createError(
            ErrorCodes.MISSING_REQUIRED_FIELD,
            "assignee_names array is required"
          );
        }

        const results = {};

        for (const name of assignee_names) {
          const jql = `project = "${project_key}" AND sprint in openSprints() AND assignee = "${name}"`;
          const data = await jiraRequest(
            `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=500&fields=summary,status`
          );

          results[name] = {
            count: data.total,
            issues: data.issues.map(i => ({
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
      case "quicktext-jira_get_status_distribution": {
        const { project_key } = args;
        
        const jql = `project = "${project_key}" AND sprint in openSprints()`;
        const data = await jiraRequest(
          `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=1000&fields=status`
        );

        const distribution = {};
        data.issues.forEach(issue => {
          const status = issue.fields.status?.name || "Unknown";
          distribution[status] = (distribution[status] || 0) + 1;
        });

        const stats = Object.entries(distribution).map(([status, count]) => ({
          status,
          count,
          percentage: ((count / data.total) * 100).toFixed(2) + "%",
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                total_issues: data.total,
                distribution: stats,
              }, null, 2),
            },
          ],
        };
      }

      // 23. GET REPORTER STATS
      case "quicktext-jira_get_reporter_stats": {
        const { project_key } = args;
        
        const jql = `project = "${project_key}" AND sprint in openSprints()`;
        const data = await jiraRequest(
          `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=1000&fields=reporter`
        );

        const reporterCounts = {};
        data.issues.forEach(issue => {
          const reporter = issue.fields.reporter?.displayName || "Unknown";
          reporterCounts[reporter] = (reporterCounts[reporter] || 0) + 1;
        });

        const stats = Object.entries(reporterCounts)
          .map(([reporter, count]) => ({
            reporter,
            count,
            percentage: ((count / data.total) * 100).toFixed(2) + "%",
          }))
          .sort((a, b) => b.count - a.count);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                total_issues: data.total,
                unique_reporters: stats.length,
                reporters: stats,
              }, null, 2),
            },
          ],
        };
      }

      // 24. GET ISSUE LINKS
      case "quicktext-jira_get_issue_links": {
        const { issue_key } = args;
        
        const data = await jiraRequest(`/rest/api/2/issue/${issue_key}`);

        const links = (data.fields.issuelinks || []).map(link => {
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
      case "quicktext-jira_get_issue_history": {
        const { issue_key } = args;
        
        const data = await jiraRequest(`/rest/api/2/issue/${issue_key}?expand=changelog`);

        const history = (data.changelog?.histories || []).map(change => ({
          author: change.author.displayName,
          created: change.created,
          changes: change.items.map(item => ({
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
      case "quicktext-jira_get_sprint_velocity": {
        const { project_key, sprint_count = 3 } = args;
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: "Sprint velocity calculation requires board_id and historical sprint data",
                note: "Use list_sprints to get sprint IDs, then query each sprint for story points",
              }, null, 2),
            },
          ],
        };
      }

      // 27. GET BLOCKED TICKETS
      case "quicktext-jira_get_blocked_tickets": {
        const { project_key } = args;
        
        const jql = `project = "${project_key}" AND sprint in openSprints() AND (status = Blocked OR labels = blocked)`;
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
                blocked_issues: data.issues.map(issue => ({
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
      case "quicktext-jira_get_priority_breakdown": {
        const { project_key } = args;
        
        const jql = `project = "${project_key}" AND sprint in openSprints()`;
        const data = await jiraRequest(
          `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=1000&fields=priority`
        );

        const priorities = {};
        data.issues.forEach(issue => {
          const priority = issue.fields.priority?.name || "None";
          priorities[priority] = (priorities[priority] || 0) + 1;
        });

        const breakdown = Object.entries(priorities).map(([priority, count]) => ({
          priority,
          count,
          percentage: ((count / data.total) * 100).toFixed(2) + "%",
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                total_issues: data.total,
                breakdown,
              }, null, 2),
            },
          ],
        };
      }

      // 29. GET COMPONENT BREAKDOWN
      case "quicktext-jira_get_component_breakdown": {
        const { project_key } = args;
        
        const jql = `project = "${project_key}" AND sprint in openSprints()`;
        const data = await jiraRequest(
          `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=1000&fields=components`
        );

        const components = {};
        data.issues.forEach(issue => {
          const comps = issue.fields.components?.map(c => c.name) || ["No Component"];
          comps.forEach(comp => {
            components[comp] = (components[comp] || 0) + 1;
          });
        });

        const breakdown = Object.entries(components)
          .map(([component, count]) => ({
            component,
            count,
            percentage: ((count / data.total) * 100).toFixed(2) + "%",
          }))
          .sort((a, b) => b.count - a.count);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                total_issues: data.total,
                breakdown,
              }, null, 2),
            },
          ],
        };
      }

      // 30. BULK TRANSITION
      case "quicktext-jira_bulk_transition": {
        const { issue_keys, transition_id } = args;
        
        if (!issue_keys || issue_keys.length === 0) {
          throw createError(
            ErrorCodes.MISSING_REQUIRED_FIELD,
            "issue_keys array is required"
          );
        }

        const results = [];
        for (const key of issue_keys) {
          try {
            await jiraRequest(`/rest/api/2/issue/${key}/transitions`, {
              method: "POST",
              body: JSON.stringify({
                transition: { id: transition_id },
              }),
            });
            results.push({ issue_key: key, success: true });
          } catch (error) {
            results.push({ issue_key: key, success: false, error: error.error_message });
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                total_processed: issue_keys.length,
                results,
              }, null, 2),
            },
          ],
        };
      }

      // 31. GET SPRINT KPI DATA
      case "quicktext-jira_get_sprint_kpi_data": {
        const { project_key, sprint_name, max_results = 1000 } = args;

        let jql = `project = "${project_key}" AND sprint in openSprints()`;
        if (sprint_name) {
          jql = `project = "${project_key}" AND sprint = "${sprint_name}"`;
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

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                total: data.total,
                returned: data.issues.length,
                issues: data.issues.map(issue => ({
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
                  assignee_roles: parseAssigneeRoles(issue.fields.customfield_10301),
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
      case "quicktext-jira_list_boards": {
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
                boards: data.values.map(b => ({
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
      case "quicktext-jira_get_board": {
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
        } catch (error) {
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
      case "quicktext-jira_get_sprint": {
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
          const calendarDays = Math.ceil((new Date(data.endDate) - new Date(data.startDate)) / 86400000);
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
      case "quicktext-jira_get_tester_workload": {
        const { project_key } = args;

        const jql = `project = "${project_key}" AND sprint in openSprints()`;
        const data = await jiraRequest(
          `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=1000&fields=status,customfield_10018,customfield_10705,customfield_10008`
        );

        let sprintName = "Current Sprint";
        if (data.issues.length > 0) {
          const sprintRaw = data.issues[0].fields?.customfield_10008;
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

        data.issues.forEach(issue => {
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
                total_issues: data.total,
                testers,
                unassigned_tester: unassignedTester,
              }, null, 2),
            },
          ],
        };
      }

      // 36. GET REVIEWER WORKLOAD
      case "quicktext-jira_get_reviewer_workload": {
        const { project_key } = args;

        const jql = `project = "${project_key}" AND sprint in openSprints()`;
        const data = await jiraRequest(
          `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=1000&fields=status,customfield_10020,customfield_10806,customfield_10008`
        );

        let sprintName = "Current Sprint";
        if (data.issues.length > 0) {
          const sprintRaw = data.issues[0].fields?.customfield_10008;
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

        data.issues.forEach(issue => {
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
                total_issues: data.total,
                reviewers,
                unassigned_reviewer: unassignedReviewer,
              }, null, 2),
            },
          ],
        };
      }

      // 37. GET ISSUE WORKLOGS
      case "quicktext-jira_get_issue_worklogs": {
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
      case "quicktext-jira_get_bulk_worklogs": {
        const { project_key, sprint_name, date_from, date_to, max_issues = 200 } = args;

        // Build JQL
        let jql: string;
        if (sprint_name) {
          jql = `project = "${project_key}" AND sprint = "${sprint_name}"`;
        } else if (date_from && date_to) {
          jql = `project = "${project_key}" AND worklogDate >= "${date_from}" AND worklogDate <= "${date_to}"`;
        } else {
          jql = `project = "${project_key}" AND sprint in openSprints()`;
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
      case "quicktext-jira_get_issue_cycle_time": {
        const { project_key, sprint_name, max_issues = 100 } = args;

        // Step 1: Build JQL and get sprint issues
        let jql: string;
        if (sprint_name) {
          jql = `project = "${project_key}" AND sprint = "${sprint_name}"`;
        } else {
          jql = `project = "${project_key}" AND sprint in openSprints()`;
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
      case "quicktext-jira_get_mentions": {
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
        const jql = `project = "${project_key}" AND updated >= "${sinceJQL}" ORDER BY updated DESC`;
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
          const commentData = await jiraRequest(
            `/rest/api/2/issue/${issue.key}/comment?maxResults=500`
          );
          for (const comment of commentData.comments || []) {
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
      case "quicktext-jira_delete_issue": {
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
      case "quicktext-jira_move_to_sprint": {
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
      case "quicktext-jira_move_to_backlog": {
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
      case "quicktext-jira_add_issue_link": {
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
      case "quicktext-jira_add_watcher": {
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
      case "quicktext-jira_remove_watcher": {
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
      case "quicktext-jira_get_watchers": {
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
      case "quicktext-jira_get_link_types": {
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
      case "quicktext-jira_assign_issue": {
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
      case "quicktext-jira_rank_issues": {
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
      case "quicktext-jira_list_attachments": {
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
      case "quicktext-jira_get_attachment": {
        const { attachment_id, max_size_mb = 10 } = args;
        if (!attachment_id) {
          throw createError(ErrorCodes.MISSING_REQUIRED_FIELD, "attachment_id is required");
        }
        const maxBytes = (max_size_mb || 10) * 1024 * 1024;

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

        const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"];
        const TEXT_MIME_PREFIXES = ["text/"];
        const TEXT_MIME_EXACT = ["application/json", "application/xml"];
        const TEXT_SIZE_LIMIT = 500 * 1024;

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
        } else {
          // PDF and other binaries — base64 in a text block
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
      }

      // 53. GET ISSUE ATTACHMENTS BULK
      case "quicktext-jira_get_issue_attachments_bulk": {
        const { issue_key: bulkIssueKey, max_size_mb: bulkMaxMb = 10, max_images = 5 } = args;
        if (!bulkIssueKey) {
          throw createError(ErrorCodes.MISSING_REQUIRED_FIELD, "issue_key is required");
        }
        const bulkMaxBytes = (bulkMaxMb || 10) * 1024 * 1024;
        const imageLimit = Math.min(max_images || 5, 5);
        const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"];

        const bulkData = await jiraRequest(`/rest/api/2/issue/${bulkIssueKey}?fields=attachment`);
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

      default:
        throw createError(
          ErrorCodes.INVALID_PARAMETER,
          `Unknown tool: ${name}`,
          { tool_name: name },
          "Check tool name spelling and ensure it starts with quicktext-jira_"
        );
    }
  } catch (error) {
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

    // Otherwise, wrap it in a structured error
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            createError(
              ErrorCodes.JIRA_API_ERROR,
              `Unexpected error: ${error.message}`,
              { original_error: error.message, stack: error.stack }
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
  console.error("QuickText Jira MCP Server v4.1 running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
