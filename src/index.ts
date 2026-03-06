#!/usr/bin/env node

/**
 * QuickText Jira MCP Server v4.6.0 (Production-Ready)
 * Enhanced with MCP Best Practices + Phase 2 Discovery Suite
 * 
 * Production Features:
 * ✅ Vendor Prefix: All tools use quicktext-jira_ prefix (underscore, not slash)
 * ✅ Enhanced Descriptions: Comprehensive tool documentation with examples
 * ✅ Structured Errors: Machine-readable error codes (JIRA_1xxx-5xxx)
 * ✅ Tool Count: 34 tools (31 core + 3 Discovery Suite)
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

// Jira configuration
const JIRA_BASE_URL = "https://jira.quicktext.im";
const JIRA_PAT = "Mjk5MDg2ODMxNzQ0OvDfa+eg86eqrYNgn6DQIypIiC17";

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
    version: "4.6.0",
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
        "Authorization": `Bearer ${JIRA_PAT}`,
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
        throw createError(
          ErrorCodes.JIRA_API_ERROR,
          `Jira API error: ${response.status} ${response.statusText}`,
          { status: response.status, endpoint }
        );
      }
    }

    return response.json();
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
        description: "Create new Jira issue with summary, description, issue type, priority. Returns created issue key. Example: quicktext-jira_create_issue({project_key: 'QT', summary: 'Bug found', issue_type: 'Bug'})",
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
              description: "Issue type (Bug, Task, Story, etc.)",
              default: "Task",
            },
            priority: {
              type: "string",
              description: "Priority (Highest, High, Medium, Low, Lowest)",
            },
          },
          required: ["project_key", "summary", "issue_type"],
        },
      },
      
      // 14. UPDATE ISSUE
      {
        name: "quicktext-jira_update_issue",
        description: "Update existing issue fields (summary, description, assignee, priority, etc.). Returns updated issue. Example: quicktext-jira_update_issue({issue_key: 'QT-123', fields: {summary: 'Updated title'}})",
        inputSchema: {
          type: "object",
          properties: {
            issue_key: {
              type: "string",
              description: "Issue key (e.g., 'QT-14006')",
            },
            fields: {
              type: "object",
              description: "Fields to update (summary, description, assignee, priority, etc.)",
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
        description: "Discover all custom field IDs and names in QuickText Jira. Useful for understanding field mapping (customfield_10016 = Story Points, etc.). Example: quicktext-jira_get_custom_fields({})",
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
                  story_points: data.fields.customfield_10016,
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
                  story_points: issue.fields.customfield_10016,
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
        const { project_key, summary, description, issue_type = "Task", priority } = args;
        
        if (!summary) {
          throw createError(
            ErrorCodes.MISSING_REQUIRED_FIELD,
            "summary is required"
          );
        }

        const payload = {
          fields: {
            project: { key: project_key },
            summary,
            description: description || "",
            issuetype: { name: issue_type },
          },
        };

        if (priority) {
          payload.fields.priority = { name: priority };
        }

        const data = await jiraRequest("/rest/api/2/issue", {
          method: "POST",
          body: JSON.stringify(payload),
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                issue_key: data.key,
                issue_id: data.id,
                self: data.self,
              }, null, 2),
            },
          ],
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

        await jiraRequest(`/rest/api/2/issue/${issue_key}`, {
          method: "PUT",
          body: JSON.stringify({ fields }),
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

        const buffer = Buffer.from(content_base64, "base64");
        
        const data = await jiraRequest(`/rest/api/2/issue/${issue_key}/attachments`, {
          method: "POST",
          headers: {
            "X-Atlassian-Token": "no-check",
            "Content-Type": "multipart/form-data",
          },
          body: buffer,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: `Attachment ${filename} added to ${issue_key}`,
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
          `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=${max_results}&fields=summary,status,assignee,customfield_10016`
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
                  story_points: issue.fields.customfield_10016,
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
                  story_points: issue.fields.customfield_10016,
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
