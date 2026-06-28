#!/usr/bin/env node
/**
 * Live integration test suite for the QuickText Jira + Confluence MCP server.
 *
 * Drives the BUILT server (build/index.js) over the real MCP stdio protocol
 * using your real credentials, and exercises the tool handlers end-to-end
 * against a live Jira/Confluence Data Center instance.
 *
 * SAFETY MODEL
 *   - Read-only tools run by default and never mutate anything.
 *   - Mutating tools are OFF unless you opt in:
 *       RUN_WRITES=1            -> Jira write flow (creates a throwaway issue,
 *                                  exercises comment/label/attachment/transition,
 *                                  then DELETES it in cleanup).
 *       RUN_CONFLUENCE_WRITES=1 -> Confluence write flow (creates a page +
 *                                  comment + label). NOTE: there is no delete-page
 *                                  tool, so the created page must be removed by
 *                                  hand. Use a throwaway space.
 *
 * USAGE
 *   1. npm run build
 *   2. Put creds + test targets in .env (see tests/live/.env.live.example)
 *   3. node --env-file=.env tests/live/run-live-suite.mjs
 *      (add RUN_WRITES=1 to include the Jira write flow)
 *
 * Exit code is non-zero if any test FAILs (SKIPs do not fail the run).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const SERVER = resolve(ROOT, "build", "index.js");

const env = process.env;
const cfg = {
  projectKey: env.TEST_PROJECT_KEY,
  issueKey: env.TEST_ISSUE_KEY,
  boardId: env.TEST_BOARD_ID,
  sprintId: env.TEST_SPRINT_ID,
  epicKey: env.TEST_EPIC_KEY,
  attachmentId: env.TEST_ATTACHMENT_ID,
  usernameKey: env.TEST_USERNAME_KEY,
  assigneeName: env.TEST_ASSIGNEE_NAME,
  spaceKey: env.TEST_SPACE_KEY,
  pageId: env.TEST_PAGE_ID,
  pageTitle: env.TEST_PAGE_TITLE,
  label: env.TEST_LABEL || "mcp-livetest",
  cql: env.TEST_CQL,
  runWrites: env.RUN_WRITES === "1",
  runConfluenceWrites: env.RUN_CONFLUENCE_WRITES === "1",
  reqTimeoutMs: Number(env.LIVE_TEST_TIMEOUT_MS) > 0 ? Number(env.LIVE_TEST_TIMEOUT_MS) : 60000,
};

// ── tiny MCP stdio client ───────────────────────────────────────────────────
function startServer() {
  if (!existsSync(SERVER)) {
    console.error(`build/index.js not found — running 'npm run build' first...`);
    const b = spawnSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
    if (b.status !== 0) { console.error("Build failed."); process.exit(2); }
  }
  const child = spawn("node", [SERVER], { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", (d) => {
    const s = d.toString();
    if (/error|exception|unhandled/i.test(s)) process.stderr.write(`[server] ${s}`);
  });
  return child;
}

let _id = 0;
const pending = new Map();
function rpc(child, method, params) {
  const id = ++_id;
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  child.stdin.write(msg);
  return new Promise((res, rej) => {
    const t = setTimeout(() => { pending.delete(id); rej(new Error(`RPC timeout: ${method}`)); }, cfg.reqTimeoutMs);
    pending.set(id, { res, rej, t });
  });
}
function wireReader(child) {
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.t); p.res(m);
      }
    }
  });
}

// Interpret a tools/call response: returns { ok, payload, note }
function classify(resp) {
  if (resp.error) return { ok: false, note: `JSON-RPC error: ${resp.error.message}` };
  const content = resp.result?.content;
  if (!Array.isArray(content) || content.length === 0) return { ok: false, note: "empty content" };
  const first = content[0];
  if (first.type === "image") return { ok: true, payload: { type: "image" }, note: "image block" };
  let parsed; try { parsed = JSON.parse(first.text); } catch { return { ok: true, payload: first.text, note: "text" }; }
  if (parsed && parsed.error_code) return { ok: false, payload: parsed, note: `${parsed.error_code}: ${parsed.error_message}` };
  return { ok: true, payload: parsed, note: "ok" };
}

// ── test registry ─────────────────────────────────────────────────────────
// Each test: { name, tool, args, needs:[cfgKeys] } ; readonly unless in writes flow.
const readTests = [
  // no-arg
  { name: "rate limits", tool: "quicktext-jira_get_rate_limits", args: {} },
  { name: "custom fields", tool: "quicktext-jira_get_custom_fields", args: {} },
  { name: "list boards", tool: "quicktext-jira_list_boards", args: {} },
  { name: "link types", tool: "quicktext-jira_get_link_types", args: {} },
  // project-scoped (exercises the new pagination paths)
  { name: "team workload", tool: "quicktext-jira_get_team_workload", args: { project_key: cfg.projectKey }, needs: ["projectKey"] },
  { name: "status distribution", tool: "quicktext-jira_get_status_distribution", args: { project_key: cfg.projectKey }, needs: ["projectKey"] },
  { name: "reporter stats", tool: "quicktext-jira_get_reporter_stats", args: { project_key: cfg.projectKey }, needs: ["projectKey"] },
  { name: "priority breakdown", tool: "quicktext-jira_get_priority_breakdown", args: { project_key: cfg.projectKey }, needs: ["projectKey"] },
  { name: "component breakdown", tool: "quicktext-jira_get_component_breakdown", args: { project_key: cfg.projectKey }, needs: ["projectKey"] },
  { name: "all labels", tool: "quicktext-jira_get_all_labels", args: { project_key: cfg.projectKey }, needs: ["projectKey"] },
  { name: "unassigned by role", tool: "quicktext-jira_get_unassigned_by_role", args: { project_key: cfg.projectKey }, needs: ["projectKey"] },
  { name: "time metrics", tool: "quicktext-jira_get_time_metrics", args: { project_key: cfg.projectKey }, needs: ["projectKey"] },
  { name: "time in status", tool: "quicktext-jira_get_time_in_status", args: { project_key: cfg.projectKey }, needs: ["projectKey"] },
  { name: "tester workload", tool: "quicktext-jira_get_tester_workload", args: { project_key: cfg.projectKey }, needs: ["projectKey"] },
  { name: "reviewer workload", tool: "quicktext-jira_get_reviewer_workload", args: { project_key: cfg.projectKey }, needs: ["projectKey"] },
  { name: "list sprints", tool: "quicktext-jira_list_sprints", args: { project_key: cfg.projectKey }, needs: ["projectKey"] },
  { name: "search sprint issues", tool: "quicktext-jira_search_sprint_issues", args: { project_key: cfg.projectKey, max_results: 5 }, needs: ["projectKey"] },
  { name: "analyze hotfixes", tool: "quicktext-jira_analyze_hotfixes", args: { project_key: cfg.projectKey }, needs: ["projectKey"] },
  { name: "sprint kpi data", tool: "quicktext-jira_get_sprint_kpi_data", args: { project_key: cfg.projectKey, max_results: 5 }, needs: ["projectKey"] },
  { name: "blocked tickets", tool: "quicktext-jira_get_blocked_tickets", args: { project_key: cfg.projectKey }, needs: ["projectKey"] },
  { name: "bulk worklogs", tool: "quicktext-jira_get_bulk_worklogs", args: { project_key: cfg.projectKey }, needs: ["projectKey"] },
  { name: "sprint velocity", tool: "quicktext-jira_get_sprint_velocity", args: { project_key: cfg.projectKey }, needs: ["projectKey"] },
  { name: "issue cycle time", tool: "quicktext-jira_get_issue_cycle_time", args: { project_key: cfg.projectKey }, needs: ["projectKey"] },
  { name: "search by labels", tool: "quicktext-jira_search_by_labels", args: { project_key: cfg.projectKey, labels: [cfg.label] }, needs: ["projectKey"] },
  { name: "search by assignee", tool: "quicktext-jira_search_by_assignee", args: { project_key: cfg.projectKey, assignee_names: [cfg.assigneeName] }, needs: ["projectKey", "assigneeName"] },
  // issue-scoped
  { name: "full issue", tool: "quicktext-jira_get_full_issue", args: { issue_key: cfg.issueKey }, needs: ["issueKey"] },
  { name: "transitions", tool: "quicktext-jira_get_transitions", args: { issue_key: cfg.issueKey }, needs: ["issueKey"] },
  { name: "issue links", tool: "quicktext-jira_get_issue_links", args: { issue_key: cfg.issueKey }, needs: ["issueKey"] },
  { name: "issue history", tool: "quicktext-jira_get_issue_history", args: { issue_key: cfg.issueKey }, needs: ["issueKey"] },
  { name: "issue worklogs", tool: "quicktext-jira_get_issue_worklogs", args: { issue_key: cfg.issueKey }, needs: ["issueKey"] },
  { name: "watchers", tool: "quicktext-jira_get_watchers", args: { issue_key: cfg.issueKey }, needs: ["issueKey"] },
  { name: "list attachments", tool: "quicktext-jira_list_attachments", args: { issue_key: cfg.issueKey }, needs: ["issueKey"] },
  { name: "issue attachments bulk", tool: "quicktext-jira_get_issue_attachments_bulk", args: { issue_key: cfg.issueKey, max_images: 2 }, needs: ["issueKey"] },
  // misc read
  { name: "search advanced", tool: "quicktext-jira_search_advanced", args: { jql: cfg.projectKey ? `project = "${cfg.projectKey}" ORDER BY created DESC` : "ORDER BY created DESC", max_results: 3 }, needs: ["projectKey"] },
  { name: "epic children", tool: "quicktext-jira_get_epic_children", args: { epic_key: cfg.epicKey }, needs: ["epicKey"] },
  { name: "mentions", tool: "quicktext-jira_get_mentions", args: { username_key: cfg.usernameKey, project_key: cfg.projectKey, since: "-1w" }, needs: ["usernameKey"] },
  { name: "get board", tool: "quicktext-jira_get_board", args: { board_id: cfg.boardId }, needs: ["boardId"] },
  { name: "get sprint", tool: "quicktext-jira_get_sprint", args: { sprint_id: cfg.sprintId }, needs: ["sprintId"] },
  { name: "get attachment", tool: "quicktext-jira_get_attachment", args: { attachment_id: cfg.attachmentId }, needs: ["attachmentId"] },
  // Confluence reads
  { name: "conf: list spaces", tool: "quicktext-confluence_list_spaces", args: {} },
  { name: "conf: current user", tool: "quicktext-confluence_get_current_user", args: {} },
  { name: "conf: search pages", tool: "quicktext-confluence_search_pages", args: { cql: cfg.cql || (cfg.spaceKey ? `space="${cfg.spaceKey}" AND type=page` : "type=page"), limit: 5 } },
  { name: "conf: get space", tool: "quicktext-confluence_get_space", args: { space_key: cfg.spaceKey }, needs: ["spaceKey"] },
  { name: "conf: get page", tool: "quicktext-confluence_get_page", args: { page_id: cfg.pageId }, needs: ["pageId"] },
  { name: "conf: page by title", tool: "quicktext-confluence_get_page_by_title", args: { space_key: cfg.spaceKey, title: cfg.pageTitle }, needs: ["spaceKey", "pageTitle"] },
  { name: "conf: child pages", tool: "quicktext-confluence_get_child_pages", args: { page_id: cfg.pageId }, needs: ["pageId"] },
  { name: "conf: page labels", tool: "quicktext-confluence_get_page_labels", args: { page_id: cfg.pageId }, needs: ["pageId"] },
  { name: "conf: page comments", tool: "quicktext-confluence_get_page_comments", args: { page_id: cfg.pageId }, needs: ["pageId"] },
  { name: "conf: page history", tool: "quicktext-confluence_get_page_history", args: { page_id: cfg.pageId, limit: 5 }, needs: ["pageId"] },
  { name: "conf: search by label", tool: "quicktext-confluence_search_by_label", args: { label: cfg.label, space_key: cfg.spaceKey } },
];

const results = [];
function record(name, status, note) { results.push({ name, status, note });
  const tag = status === "PASS" ? "\x1b[32mPASS\x1b[0m" : status === "FAIL" ? "\x1b[31mFAIL\x1b[0m" : "\x1b[33mSKIP\x1b[0m";
  console.log(`  ${tag}  ${name}${note ? "  — " + note : ""}`);
}

async function runTest(child, t) {
  const missing = (t.needs || []).filter((k) => !cfg[k]);
  if (missing.length) { record(t.name, "SKIP", `set ${missing.map(m => "TEST_" + m.replace(/([A-Z])/g, "_$1").toUpperCase()).join(", ")}`); return; }
  try {
    const resp = await rpc(child, "tools/call", { name: t.tool, arguments: t.args });
    const c = classify(resp);
    record(t.name, c.ok ? "PASS" : "FAIL", c.note);
    return c;
  } catch (e) {
    record(t.name, "FAIL", e.message);
  }
}

async function main() {
  const child = startServer();
  wireReader(child);
  child.on("exit", (code) => {
    for (const [, p] of pending) { clearTimeout(p.t); p.rej(new Error(`server exited (code ${code})`)); }
  });

  await rpc(child, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "live-suite", version: "1.0.0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await rpc(child, "tools/list", {});
  const toolCount = list.result?.tools?.length ?? 0;
  console.log(`\nConnected. Server advertises ${toolCount} tools.\n`);
  console.log("── READ-ONLY TESTS ─────────────────────────────────────────");
  for (const t of readTests) await runTest(child, t);

  if (cfg.runWrites) {
    console.log("\n── JIRA WRITE FLOW (RUN_WRITES=1) ──────────────────────────");
    if (!cfg.projectKey) {
      record("write flow", "SKIP", "set TEST_PROJECT_KEY");
    } else {
      let createdKey = null;
      try {
        const create = await rpc(child, "tools/call", { name: "quicktext-jira_create_issue", arguments: { project_key: cfg.projectKey, summary: "[MCP LIVE TEST] safe to delete", issue_type: env.TEST_ISSUE_TYPE || "Task", labels: [cfg.label] } });
        const cc = classify(create);
        record("create issue", cc.ok ? "PASS" : "FAIL", cc.note);
        createdKey = cc.ok ? (cc.payload?.issue_key) : null;
        if (createdKey) {
          await runTest(child, { name: "add comment", tool: "quicktext-jira_add_comment", args: { issue_key: createdKey, body: "MCP live-test comment" } });
          await runTest(child, { name: "update issue", tool: "quicktext-jira_update_issue", args: { issue_key: createdKey, fields: { summary: "[MCP LIVE TEST] updated" } } });
          await runTest(child, { name: "add attachment", tool: "quicktext-jira_add_attachment", args: { issue_key: createdKey, filename: "livetest.txt", content_base64: Buffer.from("hello from mcp live test").toString("base64") } });
          await runTest(child, { name: "list attachments (created)", tool: "quicktext-jira_list_attachments", args: { issue_key: createdKey } });
        }
      } finally {
        if (createdKey) {
          const del = await rpc(child, "tools/call", { name: "quicktext-jira_delete_issue", arguments: { issue_key: createdKey } });
          const dc = classify(del);
          record(`cleanup: delete ${createdKey}`, dc.ok ? "PASS" : "FAIL", dc.ok ? "deleted" : dc.note + " (DELETE MANUALLY)");
        }
      }
    }
  } else {
    console.log("\n(skipping Jira write flow — set RUN_WRITES=1 to enable)");
  }

  if (cfg.runConfluenceWrites) {
    console.log("\n── CONFLUENCE WRITE FLOW (RUN_CONFLUENCE_WRITES=1) ─────────");
    if (!cfg.spaceKey) {
      record("conf write flow", "SKIP", "set TEST_SPACE_KEY");
    } else {
      const pageTitle = `MCP live test page ${new Date().toISOString()}`;
      const create = await rpc(child, "tools/call", { name: "quicktext-confluence_create_page", arguments: { space_key: cfg.spaceKey, title: pageTitle, body: "<p>MCP live test — safe to delete</p>" } });
      const cc = classify(create);
      record("conf: create page", cc.ok ? "PASS" : "FAIL", cc.note);
      const pid = cc.ok ? cc.payload?.page_id : null;
      if (pid) {
        await runTest(child, { name: "conf: add comment", tool: "quicktext-confluence_add_page_comment", args: { page_id: pid, body: "MCP live-test comment" } });
        await runTest(child, { name: "conf: add label", tool: "quicktext-confluence_add_page_label", args: { page_id: pid, label: cfg.label } });
        record("conf: cleanup", "SKIP", `no delete-page tool — remove page ${pid} manually`);
      }
    }
  } else {
    console.log("\n(skipping Confluence write flow — set RUN_CONFLUENCE_WRITES=1 to enable)");
  }

  const pass = results.filter(r => r.status === "PASS").length;
  const fail = results.filter(r => r.status === "FAIL").length;
  const skip = results.filter(r => r.status === "SKIP").length;
  console.log(`\n── SUMMARY ──────────────────────────────────────────────────`);
  console.log(`  PASS ${pass}   FAIL ${fail}   SKIP ${skip}`);
  if (fail) {
    console.log("\n  Failures:");
    for (const r of results.filter(r => r.status === "FAIL")) console.log(`   - ${r.name}: ${r.note}`);
  }
  child.stdin.end();
  child.kill();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(2); });
