# MCP Server — Full Code Review

_Method: 8 dimension reviewers → 78 raw findings → independent adversarial verification of each (72 confirmed / 6 rejected) → synthesis & dedupe. Read-only; no code changed._

**Verification funnel:** 78 raw → 72 confirmed, 6 rejected false-positive. After dedupe: **41 distinct Confirmed**, **23 Discuss**.

## Executive summary

The codebase is a functional stdio MCP server for self-hosted Jira/Confluence Data Center, but the review surfaces three structural problem clusters. (1) A pervasive, systemic correctness pattern: ~18 aggregation/search handlers issue a single unpaginated /rest/api/2/search and compute counts/percentages over the returned page while reporting data.total, so results are silently truncated and statistically inconsistent once a result set exceeds the page cap. (2) The entire HTTP/SSE transport is broken and insecure (POST /messages never routes to the transport, single shared server collides across connections, no cleanup, wildcard CORS + zero auth) — though it is currently dead code reachable only if wired in. (3) A large dead-code island (JiraApiService v3/ADF, its subclass, type files) means the ONLY test suite validates out-of-scope Cloud code while CI auto-posts "ready for review" on green, giving false confidence with zero coverage of the live v2 handlers. The two genuinely actionable high-severity, non-breaking defects are the misplaced `default:` label that routes unknown tools into move_page (real mutation risk) and the absence of any request timeout/AbortController. Parked attachment items and latent/dead-code-gated transport issues are routed to DISCUSS.

## CONFIRMED — code-proven, safe (non-breaking) to fix (41)


### HIGH

- **Misplaced default: label causes unknown tools to silently run move_page (possible unintended page mutation)**  
  `src/index.ts:4633-4714` · breaking risk: low  
  Impact: Any unknown/misspelled tool name falls into the move_page case body instead of returning 'Unknown tool'; the real unknown-tool throw is unreachable dead code, and if a page_id is supplied a real page move/version bump can occur.  
  Fix: Delete the stray `default:` at line 4633 so the move_page case stands alone, and add a standalone `default: { throw createError(ErrorCodes.INVALID_PARAMETER, `Unknown tool: ${name}`, { tool_name: name }, 'Check tool name spelling'); }` after the move_page case's closing brace (line 4707).

- **No request timeout / AbortController on any fetch — a hung server blocks the tool invocation indefinitely**  
  `src/index.ts:123-133 (also confluenceRequest 221-231)` · breaking risk: low  
  Impact: If the self-hosted server accepts the TCP connection but never responds, await fetch() hangs forever with no recovery, hanging the MCP tool call. undici fetch has no default response/body timeout.  
  Fix: Wrap each fetch with an AbortController + configurable timeout (const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS); pass signal: ctrl.signal; clearTimeout(t) in finally). Map AbortError to a TIMEOUT/NETWORK_ERROR structured error. Apply to jiraRequest and confluenceRequest. (Apply to fetchAttachmentBinary only with owner sign-off — parked.)

- **get_all_labels enumerates project-wide labels from a single truncated 1000-issue page**  
  `src/index.ts:2194-2225` · breaking risk: low  
  Impact: jql is project-wide (no sprint scope) yet only the first page is fetched, so for any non-trivial project labels on issues past the cap are silently omitted and per-label counts undercount, contradicting the tool's 'discover all labels' contract.  
  Fix: Paginate via a startAt loop (mirroring get_mentions at 3775-3788) to enumerate labels project-wide; at minimum add a `truncated: true` flag when data.total > data.issues.length.


### MEDIUM

- **get_status_distribution truncates counts at 1000 and computes percentages against data.total**  
  `src/index.ts:2841-2873` · breaking risk: low  
  Impact: Counts come from the returned page but percentages divide by the full data.total, so above the cap per-status counts undercount and percentages neither sum to 100% nor reflect reality.  
  Fix: Paginate via startAt before aggregating, or as a minimal interim fix compute percentages against data.issues.length and add a `truncated`/`warning` field when data.total > data.issues.length (pattern at get_bulk_worklogs 3586).

- **get_reporter_stats truncates reporter counts at 1000 and mis-computes percentages**  
  `src/index.ts:2876-2911` · breaking risk: low  
  Impact: Reporter counts and unique_reporters come from the first page while percentages divide by data.total; reporters appearing only past the cap are dropped and percentages are wrong.  
  Fix: Paginate all pages before aggregating, or divide by data.issues.length and emit a truncation warning when data.total > data.issues.length.

- **get_priority_breakdown undercounts and mis-computes percentages on a truncated result set**  
  `src/index.ts:3031-3062` · breaking risk: low  
  Impact: Priority counts built only from the returned page while percentages divide by data.total and total_issues reports the full total; above the cap counts are truncated and percentages understated.  
  Fix: Paginate before aggregating, or compute percentages against data.issues.length and emit a truncation warning when data.total > data.issues.length.

- **get_component_breakdown undercounts components on a truncated result set**  
  `src/index.ts:3066-3101` · breaking risk: low  
  Impact: Component counts built only from the returned page while percentage denominator and total_issues use data.total; components present only in the un-returned tail are omitted with no signal.  
  Fix: Paginate to fetch all matching issues before aggregating, or divide by data.issues.length and surface a truncation warning when data.total > data.issues.length.

- **get_unassigned_by_role percentages divide by full total while counting only the first 1000 issues**  
  `src/index.ts:2094-2127` · breaking risk: low  
  Impact: unassignedDev/unassignedTest are counted over the first page but percentages divide by data.total, systematically understating the unassigned percentages; the raw counts are themselves truncated.  
  Fix: Paginate to count over all matching issues, or compute against data.issues.length and add a truncation warning when data.total > data.issues.length.

- **get_team_workload truncates at 1000 with no pagination while reporting full total_issues**  
  `src/index.ts:1924-1957` · breaking risk: low  
  Impact: Per-assignee workload and by_status counts cover only the first page yet total_issues reports data.total, so per-member numbers will not sum to total_issues and assignees past the cap are missing.  
  Fix: Paginate over all matching issues before aggregating, or emit a truncation warning and report the counted population size when data.total > data.issues.length.

- **get_tester_workload truncates at 1000 and infers sprint name from a possibly-truncated first issue**  
  `src/index.ts:3324-3380` · breaking risk: low  
  Impact: testers map, unassignedTester, and frequency_tested_ko_total sums are built only from the first page while total_issues reports data.total; sprintName is also read from data.issues[0] with no ORDER BY.  
  Fix: Paginate over all pages before aggregating, or add a truncation warning and reconcile total_issues with the counted population.

- **get_reviewer_workload truncates at 1000 with no pagination while reporting full total_issues**  
  `src/index.ts:3384-3441` · breaking risk: low  
  Impact: reviewers map, unassignedReviewer, and frequency_review_ko_total are built only from the first page while total_issues reports data.total; reviewers past the cap are silently undercounted.  
  Fix: Paginate over all matching issues before aggregating, or add a truncation warning and reconcile total_issues with the counted population.

- **get_time_metrics role totals summed over a truncated 1000-issue page**  
  `src/index.ts:2047-2090` · breaking risk: low  
  Impact: sprint_totals for Developer/Tester/Reviewer and the per-ticket array cover only the first page; for sprints above the cap the role time totals are silently understated and the response omits data.total entirely so truncation is undetectable.  
  Fix: Paginate over all matching issues before summing, or surface data.total/returned and a truncation warning when data.total > data.issues.length.

- **get_time_in_status averages computed over a truncated 1000-issue page**  
  `src/index.ts:2228-2278` · breaking risk: low  
  Impact: Per-status average durations and issue_count are computed only over the first page (with expand=changelog) and the response never surfaces data.total, so averages reflect a partial sample with no truncation signal.  
  Fix: Paginate over all matching issues, or at minimum return data.total and a truncation warning when data.total > data.issues.length.

- **search_by_labels reports per-label count=data.total but status_breakdown and issues are truncated at 1000**  
  `src/index.ts:2131-2171` · breaking risk: low  
  Impact: Per label, count uses data.total while status_breakdown and the issues array come from the first page, so they disagree and the issues list is silently incomplete when a label exceeds the cap.  
  Fix: Paginate per label before building status_breakdown/issues, or add a per-label `truncated` flag when data.total > data.issues.length.

- **analyze_hotfixes by_component undercounts while total_hotfixes reports the full total**  
  `src/index.ts:1961-1999` · breaking risk: low  
  Impact: hotfix_ratio is internally consistent (both sides use data.total), but by_component is built only from the truncated page, so above 1000 hotfixes the per-component breakdown sums to fewer than total_hotfixes within the same response.  
  Fix: Paginate the hotfix search before building by_component, or compute total_hotfixes from the summed by_component population and add a truncation warning when data.total > data.issues.length.

- **search_by_assignee reports count=data.total but issues list truncated at 500 with no pagination**  
  `src/index.ts:2802-2838` · breaking risk: low  
  Impact: Per assignee, count uses data.total but issues is capped at 500 with no startAt, so for an assignee with >500 matching issues count and the returned list silently disagree.  
  Fix: Paginate to fetch all matching issues, or add a per-assignee `truncated` flag when data.total > data.issues.length.

- **list_sprints fallback derives the sprint list from a single issue (maxResults=1)**  
  `src/index.ts:2281-2320` · breaking risk: low  
  Impact: When board_id is absent, the fallback extracts open sprints from only one issue's customfield_10008, so projects with multiple concurrent open sprints silently omit all sprints not on that one issue; result is labeled extracted_from_issues with no partial-list indication.  
  Fix: Raise maxResults (e.g. to a few hundred) and/or paginate so the fallback scans enough issues to discover all open sprints (dedup by sprint id already exists); optionally annotate the response as a sampled best-effort list.

- **get_epic_children reports total_children=data.total but children truncated at max_results (default 100)**  
  `src/index.ts:2722-2748` · breaking risk: low  
  Impact: children is limited to the first page while total_children reports the full count, so epics with more than max_results children return a partial list contradicting both total_children and the documented 'get all issues linked to an epic' contract.  
  Fix: Paginate over all children, or add a `truncated` flag/warning when data.total > data.issues.length so callers know to raise max_results.

- **search_sprint_issues caps at max_results (default 500) with no pagination path or warning**  
  `src/index.ts:1878-1921` · breaking risk: low  
  Impact: Truncation is observable via returned vs total but there is no startAt to fetch beyond the first page and no explicit warning, so sprints exceeding the cap silently omit issues.  
  Fix: Accept a start_at parameter and/or paginate internally, and emit an explicit truncated warning when data.total > data.issues.length (pattern at bulk_worklogs 3586).

- **get_sprint_kpi_data caps at max_results (default 1000) with no pagination, clamped by server cap**  
  `src/index.ts:3145-3211` · breaking risk: low  
  Impact: Reports total and returned but offers no pagination path and no explicit warning; sprints above the server search cap silently lose issues from the KPI feed, corrupting downstream aggregates.  
  Fix: Add startAt-based pagination (the file already uses this pattern at 3771-3788), or add an explicit truncated warning when data.total > data.issues.length.

- **search_pages omits history.lastUpdated expansion, so last_updated/last_updated_by are always null**  
  `src/index.ts:4196-4213` · breaking risk: none  
  Impact: The mapper reads p.history?.lastUpdated?.when/.by while the request expands only space,version,history; on Confluence DC lastUpdated is a nested expansion not populated by history alone, so both fields are always null.  
  Fix: Change expand to `space,version,history,history.lastUpdated` (matching get_page at 4226). Purely additive.

- **search_by_label omits history.lastUpdated expansion, so last_updated is always null**  
  `src/index.ts:4383-4397` · breaking risk: none  
  Impact: Identical to search_pages: expands only space,version,history but reads p.history?.lastUpdated?.when, so last_updated is always null.  
  Fix: Change expand to `space,version,history,history.lastUpdated` (matching the proven pattern at 4226/4452).

- **get_page_by_title omits history.lastUpdated expansion, so last_updated/last_updated_by are null**  
  `src/index.ts:4261-4277` · breaking risk: none  
  Impact: Expands body.storage,version,space,history,ancestors but reads p.history?.lastUpdated?.when/.by, so both metadata fields come back null.  
  Fix: Add history.lastUpdated to the expand list: `body.storage,version,space,history,history.lastUpdated,ancestors`.

- **Success-path JSON.parse is unguarded and mislabels non-JSON 200 responses as NETWORK_ERROR**  
  `src/index.ts:190-204 (also confluenceRequest 255-256)` · breaking risk: low  
  Impact: Self-hosted DC behind SSO/reverse-proxy commonly returns HTTP 200 with an HTML login/interstitial; JSON.parse throws a SyntaxError that, lacking error_code, is wrapped as NETWORK_ERROR, sending users down the wrong troubleshooting path.  
  Fix: Wrap the success-path parse in its own try/catch and emit a distinct JIRA_API_ERROR with content-type, status, and a body preview ('possible SSO/proxy login page'). Mirror in confluenceRequest.


### LOW

- **create_issue partial field failures returned as success:true with no machine-readable partial flag**  
  `src/index.ts:2467-2481` · breaking risk: none  
  Impact: Failed post-creation field updates (assignee, labels, reviewer, etc.) are pushed into warnings while the result stays success:true with no partial_success flag, so a caller checking only success believes fields were applied when they were not — inconsistent with update_issue's partial_success/failed_fields contract.  
  Fix: When warnings.length > 0, also set createResult.partial_success = true (keeping success: true for backward compatibility) so callers can detect dropped fields. Additive.

- **add_comment dereferences data.author.displayName without a null guard**  
  `src/index.ts:2636-2645` · breaking risk: none  
  Impact: If a POST /comment response omits author (anonymous-allowed/impersonation configs), data.author.displayName throws TypeError, turning a successful comment creation into an error; inconsistent with sibling sites that use optional chaining.  
  Fix: Use optional chaining: `author: data.author?.displayName ?? null`.

- **add_comment advertises markdown support but sends the body verbatim (no conversion)**  
  `src/index.ts:839-851, 2631-2634` · breaking risk: none  
  Impact: Description claims 'supports markdown' but the body is sent unchanged to the v2 comment endpoint, which interprets it as Jira wiki markup, so Markdown like **bold**, # heading, and [text](url) renders incorrectly.  
  Fix: Lowest-risk: correct the descriptions to state the body is sent as Jira wiki markup (Server/DC). Optionally add a markdown->wiki conversion step.

- **get_mentions per-issue comment scan caps at maxResults=500 with no pagination**  
  `src/index.ts:3790-3815` · breaking risk: low  
  Impact: The issue-list loop is correctly paginated, but the per-issue /comment fetch uses maxResults=500 with no startAt loop, so mentions in comments beyond the 500th on a heavily-commented issue are silently missed and total_mentions_found undercounts.  
  Fix: Paginate the comment endpoint via startAt until startAt >= commentData.total, mirroring the issue-level loop at 3775-3788.

- **Rate-limit header parsing stores NaN into rateLimitInfo on malformed/empty headers**  
  `src/index.ts:136-144` · breaking risk: none  
  Impact: parseInt on a present-but-empty/non-numeric X-RateLimit-* header yields NaN stored into rateLimitInfo.remaining/limit; the health check at 2185 treats NaN as falsy and reports 'OK', and NaN serializes to null in 429 error details, masking a corrupt value.  
  Fix: Parse into a temp and assign only when finite: `const n = parseInt(v ?? '', 10); if (Number.isFinite(n)) rateLimitInfo.remaining = n;` (and same for limit).

- **429 handling ignores the standard Retry-After header**  
  `src/index.ts:168-174 (also confluenceRequest 249)` · breaking risk: none  
  Impact: On 429 the code surfaces only X-RateLimit-* info, never the canonical Retry-After header that many reverse proxies fronting Jira DC send, so callers get no machine-readable backoff hint.  
  Fix: Read response.headers.get('Retry-After') and include it in details (e.g. retry_after). Optionally surface for 503. Mirror in confluenceRequest.

- **404 always mapped to ISSUE_NOT_FOUND even for project/sprint/board/attachment endpoints**  
  `src/index.ts:161-167` · breaking risk: none  
  Impact: Every 404 maps to ISSUE_NOT_FOUND; the declared PROJECT_NOT_FOUND/SPRINT_NOT_FOUND codes (60-61) are never used, so error_code is unreliable for machine consumers on non-issue endpoints.  
  Fix: Branch on the endpoint string (e.g. /project -> PROJECT_NOT_FOUND, /sprint or /board -> SPRINT_NOT_FOUND, keep /issue -> ISSUE_NOT_FOUND) or use a neutral RESOURCE_NOT_FOUND. Keep /issue path mapping intact (get_issue_worklogs at 3460 relies on it).

- **max_size_mb / max_images accepted as string and used in arithmetic without coercion (NaN bypasses size guard)**  
  `src/index.ts:4054 (also 4127-4128)` · breaking risk: none  
  Impact: Schema declares type [number,string]; a non-numeric string coerces maxBytes to NaN, making the `sizeBytes > maxBytes` guard always false (silently bypassed) and Math.min(NaN,5)/slice(0,NaN) misbehaving in the bulk path. (Classification/guard logic, not parked binary handling.)  
  Fix: Coerce defensively: `const mb = Number(max_size_mb); const effMb = Number.isFinite(mb) && mb > 0 ? mb : 10; const maxBytes = effMb * 1024 * 1024;` Apply same to bulkMaxMb and max_images.

- **update_issue handler does not validate issue_key despite it being required**  
  `src/index.ts:2485-2493` · breaking risk: none  
  Impact: Only fields is validated; a missing issue_key produces a `/rest/api/2/issue/undefined` URL and an opaque Jira 404 instead of a clean MISSING_REQUIRED_FIELD; inconsistent with sibling handlers (e.g. 3449-3451).  
  Fix: Add `if (!issue_key) throw createError(ErrorCodes.MISSING_REQUIRED_FIELD, 'issue_key is required');` before the fields check. Additive.

- **transition_issue and add_comment do not validate issue_key despite it being required**  
  `src/index.ts:2589-2598, 2622-2629` · breaking risk: none  
  Impact: These write handlers validate their secondary field but not issue_key, so a missing key is interpolated into the URL as the literal 'undefined', yielding a generic 404 instead of a clear MISSING_REQUIRED_FIELD; inconsistent with read handlers (1817). (add_attachment same issue is parked-adjacent — see DISCUSS.)  
  Fix: Add `if (!issue_key) throw createError(ErrorCodes.MISSING_REQUIRED_FIELD, 'issue_key is required');` at the top of each handler. Additive.

- **create_issue does not validate project_key before building payload**  
  `src/index.ts:2355-2366` · breaking risk: none  
  Impact: summary is validated but project_key is not; an omitted project_key produces project:{key:undefined}, JSON.stringify drops it to project:{}, and Jira returns an opaque field-level error instead of a clear MISSING_REQUIRED_FIELD.  
  Fix: Add `if (!project_key) throw createError(ErrorCodes.MISSING_REQUIRED_FIELD, 'project_key is required');` alongside the existing summary check. Additive.

- **issue_key interpolated into request URLs without encodeURIComponent in write handlers**  
  `src/index.ts:2418, 2515, 2600, 2631, 2677` · breaking risk: none  
  Impact: issue_key is interpolated raw into the path with no encoding anywhere; valid keys are safe, but a malformed key containing space/#/?// silently corrupts the path or query and produces confusing failures rather than a clean error.  
  Fix: Validate issue_key against /^[A-Z][A-Z0-9_]+-\d+$/i at handler entry, or wrap with encodeURIComponent when building the path. Additive.

- **add_attachment description claims a 'file path' param the schema does not define**  
  `src/index.ts:860-877` · breaking risk: none  
  Impact: Description says 'Requires file path or base64 content' but the schema only declares issue_key/filename/content_base64 and the handler only reads content_base64, misleading the model into supplying a non-existent file_path. (Pure documentation text, not parked binary handling.)  
  Fix: Reword the description to remove the false 'file path' option, e.g. 'Add file attachment to issue from base64-encoded content.' No schema/handler change.

- **JIRA_BASE_URL is not trailing-slash-normalized while CONFLUENCE_BASE_URL is**  
  `src/index.ts:26` · breaking risk: none  
  Impact: CONFLUENCE_BASE_URL strips a trailing slash but JIRA_BASE_URL does not, so a trailing slash yields double-slash URLs (https://host//rest/api/2/...) that some reverse proxies reject; the two config paths behave inconsistently.  
  Fix: Mirror the Confluence normalization: `const JIRA_BASE_URL = (process.env.JIRA_BASE_URL ?? '').replace(/\/$/, '');`

- **AUTH_TYPE comparison is case-sensitive with no validation of allowed values**  
  `src/index.ts:28` · breaking risk: none  
  Impact: JIRA_AUTH_TYPE is compared with strict === 'basic', so 'Basic'/'BASIC' silently falls through to Bearer with no warning; no validation that the value is a supported scheme.  
  Fix: Normalize at read time: `const JIRA_AUTH_TYPE = (process.env.JIRA_AUTH_TYPE ?? 'bearer').toLowerCase();` optionally warn on unknown values. Same for Confluence.

- **Auth header construction duplicated across multiple call sites**  
  `src/index.ts:126-128 (also 224-226 Confluence; parked copies at 278-280, 2681-2683)` · breaking risk: low  
  Impact: The Basic/Bearer auth expression is copy-pasted; any change to auth logic must be made in every copy and the attachment copies could drift.  
  Fix: Extract module-level jiraAuthHeader()/confluenceAuthHeader() helpers and call them from the non-parked sites (jiraRequest 126-128, confluenceRequest 224-226); rewire the parked attachment copies only with owner sign-off.

- **IMAGE_MIME_TYPES (and TEXT_MIME constants) duplicated across two handler cases**  
  `src/index.ts:4074 (duplicate at 4129)` · breaking risk: none  
  Impact: The image-MIME classification array is declared byte-identically in get_attachment and get_issue_attachments_bulk; if the supported set changes the two tools can diverge. (Classification metadata, not parked binary fetch.)  
  Fix: Hoist a single module-level const IMAGE_MIME_TYPES (and the TEXT_* constants) above the handler switch and reference it in both cases.

## DISCUSS — needs an owner decision / runtime confirmation / parked (23)

- **Test suite covers ONLY dead v3/ADF code; zero coverage of live v2 handlers — CI green is misleading**  
  `src/services/__tests__/jira-api.test.ts:1-716; .github/workflows/pr-test-runner.yml:31-49`  
  Why not auto-confirmed: Verifier-rated high and the facts are confirmed (the only test file instantiates JiraApiService and asserts /rest/api/3 endpoints; no test imports index.ts; CI posts 'All tests passed! This PR is ready for review.' on green). It is not a single safe code edit but a process/structural decision: meaningful remediation requires extracting jiraRequest/confluenceRequest into an importable module and adding new tests, plus an owner call on whether to delete the v3 test alongside the dead class and reword the CI comment.  
  Recommendation: Owner decision: (a) add a new test file exercising the real request helpers against a mocked fetch (assert /rest/api/2 URLs and 401/403/404/429 mapping), (b) retire the v3 test with the dead class, and (c) stop the CI auto-comment from asserting 'ready for review' purely on the current suite. Non-breaking but multi-step.

- **Entire JiraApiService (Cloud v3/ADF) is dead production code and wrong-for-target**  
  `src/services/jira-api.ts:10-554`  
  Why not auto-confirmed: Confirmed dead (imported only by the test and by JiraServerApiService, which is itself never instantiated) and wrong-for-target (every method hits /rest/api/3 and builds ADF). Deleting code / changing tsconfig is a structural removal best made as an explicit owner decision rather than an inline defensive edit, and it is entangled with the test-suite finding above.  
  Recommendation: Either delete src/services/jira-api.ts (and its test), or keep it as reference with a top-of-file DEAD CODE comment and exclude src/services/** from the build via tsconfig so the out-of-scope Cloud code does not ship. Non-breaking either way.

- **JiraServerApiService is dead and its v3->v2 rewrite is never reachable**  
  `src/services/jira-server-api.ts:5-27`  
  Why not auto-confirmed: Confirmed never instantiated; the DC-correct path is reimplemented in jiraRequest(). Same dead-code-removal class of change as above — a deliberate delete/annotate decision rather than a defensive code fix.  
  Recommendation: Delete the file, or annotate `// DEAD CODE: not instantiated; live DC server uses jiraRequest() in src/index.ts`. Non-breaking.

- **Dead type files: types/jira.ts reachable only from dead v3 class; types/confluence.ts imported by nobody**  
  `src/types/jira.ts:1-86; src/types/confluence.ts`  
  Why not auto-confirmed: Confirmed dead (types/jira.ts imported only by jira-api.ts; types/confluence.ts imported nowhere; AdfDoc/AdfNode encode out-of-scope Cloud ADF). Removal is part of the same dead-code-island decision; alternatively the Confluence interfaces could be applied to the currently-`any` handlers, which is a larger typing effort.  
  Recommendation: Remove both type files with the dead service, or productively apply ConfluencePage/etc to the inline-`any` Confluence handlers in index.ts. Owner decision.

- **POST /messages never routes to the SSE transport — bidirectional MCP over HTTP is completely broken**  
  `src/transports/http-transport.ts:59-65`  
  Why not auto-confirmed: Verifier-confirmed high as code, but createHttpTransport is dead code (never imported; main() uses stdio), so the defect is latent. Fixing it (session map keyed by sessionId, calling transport.handlePostMessage) is part of a larger transport rework that the owner has not signaled is in scope.  
  Recommendation: If/when the HTTP transport is enabled: maintain a sessionId->transport map, read req.query.sessionId in /messages, and call `await transport.handlePostMessage(req, res, req.body)`, returning 404 on miss. Coordinate with the other transport findings.

- **SSE transport instance never tracked/cleaned up; single shared McpServer collides across concurrent connections; async route rejections swallowed**  
  `src/transports/http-transport.ts:46-54 (concurrency/cleanup), 46-54 (async rejection)`  
  Why not auto-confirmed: Merged cluster of transport robustness defects (no res.on('close') teardown, no try/catch around server.connect, one shared Server re-connected per /sse so a second concurrent connect throws 'Already connected'). All latent — the transport is dead code — and remediation requires per-session McpServer isolation, a structural design change rather than a safe additive edit.  
  Recommendation: Before enabling HTTP: construct a fresh McpServer per session via a factory, track transports in a sessionId map, register res.on('close') teardown, and wrap server.connect in try/catch (send 500 / clean up on failure). Verifier note: the SDK does clear _transport on close, so the 'leaks accumulate forever' framing is partly inaccurate, but the concurrency and error-handling defects are real.

- **HTTP transport: wildcard CORS and no authentication on any endpoint**  
  `src/transports/http-transport.ts:19-28, 46-65`  
  Why not auto-confirmed: Verifier rated this medium (downgraded from high) precisely because createHttpTransport is currently unwired (latent). It is a security-hardening design decision requiring new env-gated config (origin allow-list, Host validation, shared-secret auth, bind 127.0.0.1), not a single safe inline fix, and it is entangled with the dead-code transport decision.  
  Recommendation: If the HTTP transport is ever enabled: require a shared secret (e.g. MCP_HTTP_AUTH_TOKEN) on /sse and /messages returning 401 on mismatch, replace wildcard CORS with an env-driven origin allow-list, validate the Host header against an allow-list, and bind to 127.0.0.1 by default. All additive and env-gated. Until then it is latent.

- **createHttpTransport is dead code; SSE is the legacy MCP HTTP scheme**  
  `src/transports/http-transport.ts:12-89`  
  Why not auto-confirmed: Confirmed never imported (main() is stdio-only) and internally broken per the findings above. Whether to wire it behind an env flag (after fixing routing/cleanup/auth) or delete it and drop the express dependency is an owner product decision, not a defensive fix.  
  Recommendation: Owner decision: either wire it in behind an env flag in main() after fixing the routing/cleanup/auth defects, or remove the file and its express dependency. Do not enable as-is given the broken /messages routing.

- **Unexpected-error handler returns full stack trace to the MCP client**  
  `src/index.ts:4730-4747`  
  Why not auto-confirmed: Confirmed low: the top-level catch serializes error.stack into the client-facing result, disclosing absolute paths/internals. The fix is safe and additive, but its impact is materially tied to whether the unauthenticated HTTP transport is ever enabled; over stdio the consumer is trusted. Grouping with the transport-exposure decision.  
  Recommendation: Drop error.stack from client-facing details and log it to stderr via console.error instead (consistent with the rest of the file). Safe to apply now if desired; impact is gated on transport exposure.

- **Jira/Confluence upstream error bodies echoed verbatim into client-facing error details**  
  `src/index.ts:176-186 (also confluenceRequest 251; attachment 2690-2696 parked)`  
  Why not auto-confirmed: Verifier confidence medium; the upstream is the trusted configured server so this is information passthrough rather than secret leakage. Whether full passthrough is desirable (useful diagnostics) vs should be gated behind a DEBUG flag is an owner preference, and its risk is again tied to transport authentication.  
  Recommendation: Optionally truncate/summarize the upstream body or gate full passthrough behind a DEBUG env var while always logging it to stderr; preserve the structured error shape. Owner preference.

- **JQL built from user-supplied fields with only ad-hoc quoting (JQL injection / query breakout)**  
  `src/index.ts:2815 (representative; also 1881/1884, 2145, 2725 unquoted epic_key, 3148/3150, 3508)`  
  Why not auto-confirmed: Verifier confidence medium. URL-encoding does not prevent JQL-level breakout, but JQL executes under the caller's own permissions so impact is query-semantics corruption / breakage on quote-containing values, not cross-user exfiltration. The fix touches many interpolation sites (incl. unquoted epic_key) and warrants an owner-reviewed escaping helper rather than a piecemeal edit.  
  Recommendation: Add an escapeJqlValue(v) helper (escape backslash and double-quote, matching the existing CQL escape at 4260) and apply it to every interpolated user value in quoted JQL literals; for epic_key at 2725 wrap in quotes and escape. Additive and behavior-preserving for well-formed inputs.

- **CQL built from user-supplied space_key and label without escaping (CQL injection / query breakout)**  
  `src/index.ts:4382 (label and space_key via spaceFilter)`  
  Why not auto-confirmed: Verifier confidence medium; same class as the JQL finding. Read-only, runs under caller permissions, so impact is broadening/narrowing search results, not privilege escalation. The safe pattern exists in-file (4260); applying it is straightforward but pairs naturally with the JQL escaping decision.  
  Recommendation: Escape label and space_key with the same .replace(/"/g,'\\"') (and backslash) escaping used at line 4260 before interpolation. Additive, non-breaking for normal inputs.

- **No retry/backoff on transient failures (429, 502/503/504, network errors)**  
  `src/index.ts:119-205 (and confluenceRequest 207-261)`  
  Why not auto-confirmed: Verifier corrected severity to enhancement. The happy path and permanent-error path both work; this is resilience hardening, not a defect. Adding a retry wrapper is a design choice (which methods are idempotent, backoff/jitter policy, honoring Retry-After) better made deliberately.  
  Recommendation: Optionally add an opt-in bounded retry wrapper (e.g. retries=2, exponential backoff with jitter) gated to idempotent GETs, retrying on 429/502/503/504 and network/AbortError, honoring Retry-After. Keep POST/PUT/DELETE un-retried. Additive and gated.

- **Tool handler args typed as Record<string,any> — all tool inputs unchecked at the type level**  
  `src/index.ts:1809 (and jiraRequest:119, hot path e.g. 1933)`  
  Why not auto-confirmed: Verifier corrected severity to low and characterized it as latent fragility / maintainability rather than an active bug. The incremental typing improvement is real and non-breaking but is a broad, judgment-driven refactor (where to introduce generics/interfaces) better owned deliberately than applied as a defensive edit.  
  Recommendation: Incrementally: add a narrow JiraSearchResponse interface and a `jiraRequest<T = any>()` generic overload (default any preserves all call sites), typing the search call sites; keep explicit required-field validation in handlers. No behavior change.

- **Basic-auth selected without validating JIRA_USER_EMAIL / CONFLUENCE_USER_EMAIL is set**  
  `src/index.ts:126-128 (email read at 29/35; startup guard 38)`  
  Why not auto-confirmed: Confirmed low and the fix is additive, but it adds a process.exit(1) startup gate, which changes startup behavior for a (mis)configured deployment and could surprise an operator relying on the current silent behavior. Worth an owner nod before adding a hard fail.  
  Recommendation: Add a startup check: `if (JIRA_AUTH_TYPE === 'basic' && !JIRA_USER_EMAIL) { console.error('JIRA_USER_EMAIL is required when JIRA_AUTH_TYPE=basic'); process.exit(1); }` and a Confluence equivalent gated on confluenceEnabled. Non-breaking for correctly-configured deployments.

- **PARKED: Multipart Content-Disposition filename vulnerable to CRLF/quote header injection**  
  `src/index.ts:2664-2675`  
  Why not auto-confirmed: Attachment handling is intentionally left as-is by owner decision. The caller-supplied filename is interpolated raw into a hand-built multipart Content-Disposition header with no sanitization, allowing injection of additional MIME headers/parts. Genuine injection-class defect but PARKED and not to be fixed now; blast radius is self-inflicted (caller's own credentials, single configured instance).  
  Recommendation: PARKED. If revisited: strip CR/LF and escape/strip double-quotes (or use RFC 5987 filename* encoding), or use a vetted multipart builder. Additive, non-breaking.

- **PARKED: fetchAttachmentBinary buffers entire body via arrayBuffer() before size check (OOM risk)**  
  `src/index.ts:297-320`  
  Why not auto-confirmed: Attachment path, PARKED. The maxBytes guard only fires on an honest Content-Length; absent/understated Content-Length lets arrayBuffer() buffer the full body before the post-hoc check. Verifier downgraded to low: both callers pre-reject on server-reported meta.size, the URL comes from trusted Jira metadata, and exploitation requires the trusted backing server itself to lie. breaking_risk medium (streaming rewrite).  
  Recommendation: PARKED. If revisited: stream response.body and enforce maxBytes incrementally, aborting once cumulative bytes exceed the cap. Coordinate with owner; touches attachment path.

- **PARKED: fetchAttachmentBinary non-OK path discards response body, losing diagnostics**  
  `src/index.ts:286-293`  
  Why not auto-confirmed: Attachment path, PARKED. Unlike jiraRequest/confluenceRequest, the non-OK branch throws using only response.status and never reads the body, discarding 403/HTML proxy error details and leaving the connection un-drained. Low-severity diagnostics gap.  
  Recommendation: PARKED. If revisited: defensively read and slice the body before throwing (mirroring jiraRequest) and include it in details. Additive.

- **PARKED: Attachment binary fetched from server-provided content URL with PAT attached (SSRF surface)**  
  `src/index.ts:277-284`  
  Why not auto-confirmed: Attachment path, PARKED. fetchAttachmentBinary attaches the PAT to a URL string with no host/origin validation against JIRA_BASE_URL. In-scope callers pass trusted meta.content from Jira's own API, so current SSRF risk is low; the concern is a future/other caller passing an untrusted URL.  
  Recommendation: PARKED. If revisited: assert `new URL(url).origin === new URL(JIRA_BASE_URL).origin` before attaching the Authorization header. Additive guard.

- **PARKED: hardcoded Content-Type application/octet-stream for all attachments**  
  `src/index.ts:2670`  
  Why not auto-confirmed: Attachment path, PARKED. Every attachment is sent with a generic Content-Type regardless of real type, so Jira stores an incorrect mimeType. Low impact (Jira often re-sniffs on download).  
  Recommendation: PARKED. If revisited: derive Content-Type from the filename extension, defaulting to application/octet-stream. Additive.

- **add_attachment handler does not validate issue_key (parked-adjacent input validation)**  
  `src/index.ts:2653-2660`  
  Why not auto-confirmed: The validation gap itself is a safe additive fix (not parked binary logic), but it sits inside the add_attachment handler the owner has parked, so the fix should be coordinated with the parked attachment work rather than applied in isolation. Verifier downgraded to low (call still fails safely; only a degraded error message).  
  Recommendation: Add `if (!issue_key) throw createError(ErrorCodes.MISSING_REQUIRED_FIELD, 'issue_key is required');` before building the URL (and extend the existing message to cover all three required fields). Additive; coordinate with the parked attachment review.

- **get_page_history fallback relies on 404->PAGE_NOT_FOUND to detect a missing /version endpoint**  
  `src/index.ts:4438-4478`  
  Why not auto-confirmed: Verifier confidence medium. The fallback to /history reconstruction triggers only on PAGE_NOT_FOUND (HTTP 404); older Confluence Server versions lacking the /version sub-resource may return 405/other (mapped to API_ERROR), causing a rethrow instead of fallback. Whether the broadened trigger is correct depends on actual server-version behavior, so it warrants owner confirmation against target deployments.  
  Recommendation: Broaden the fallback to also trigger on API_ERROR / method-not-allowed (e.g. 404/405 or any non-auth error) while continuing to rethrow on 401/403. Additive; confirm against the Server versions in use.

- **PAT/credentials passed via env and embedded into every request; no central redaction helper**  
  `src/index.ts:26-36`  
  Why not auto-confirmed: Verifier corrected severity to enhancement. This is the standard, acceptable DC pattern and the verifier confirmed there is no proven secret-leakage path into returned errors or logs. No change is strictly required today; adding a redaction helper is purely defensive future-proofing.  
  Recommendation: Optional: add a shared redaction helper for any future logging and ensure Authorization headers are never spread into logged objects. No change required today.

