# Jira/Confluence MCP — Chat-Mode Test Plan

Run each prompt in your **Claude Desktop** chat (where the `jira-confluence-quicktext`
connector is enabled). After each, note PASS / FAIL and paste anything odd back to
the developer session.

**Before you start**
- Pull + build the branch and fully restart Claude Desktop (so the new tool schemas load).
- Substitute the placeholders with real values from your instance:
  - `<PROJ>` = a project key you have (e.g. `QS`)
  - `<BIGPROJ>` = your largest project (to stress pagination)
  - `<ISSUE>` = an existing issue key (e.g. `QS-7915`)
  - `<SPACE>` = a Confluence space key
  - `<PAGE_ID>` = an existing Confluence page id
  - `<SANDBOX>` = a throwaway project/space safe to mutate
- "Show me the raw JSON" in a prompt = ask Claude to paste the tool's raw output so we can inspect fields.

Legend: ✅ pass · ❌ fail · ⚠️ works but wrong data

---

## 0. Sanity / connectivity
| # | Prompt to paste | Expected | Result |
|---|---|---|---|
| 0.1 | "Using the jira MCP, get the rate limits. Show raw JSON." | Returns a `rate_limit` object, no error | |
| 0.2 | "List the custom fields in Jira." | Returns a list, no error | |
| 0.3 | "List the Confluence spaces. Show raw JSON." | Returns spaces (or a clear CONF error if Confluence creds are off) | |

## 1. PR #19 — pagination & truncation (the big refactor)
These aggregation tools were rewritten to paginate and now return `total_matched` + `truncated`.
| # | Prompt | Expected | Result |
|---|---|---|---|
| 1.1 | "Get the status distribution for project `<PROJ>`. Show raw JSON." | JSON has `total_issues`, **`total_matched`**, **`truncated`**; percentages add up to ~100% | |
| 1.2 | "Get the priority breakdown for `<PROJ>`. Show raw JSON." | Same 3 fields present; counts sum to `total_issues` | |
| 1.3 | "Get the component breakdown for `<PROJ>`. Show raw JSON." | `total_matched`/`truncated` present | |
| 1.4 | "Get the reporter stats for `<PROJ>`. Show raw JSON." | `unique_reporters` + `truncated` present | |
| 1.5 | "Get all labels for `<PROJ>`. Show raw JSON." | `issues_scanned`, `total_matched`, `truncated` present | |
| 1.6 | "Get the team workload for `<PROJ>`. Show raw JSON." | `total_issues` == `total_matched` when not truncated; per-member counts sum to total | |
| 1.7 | "Get the tester workload for `<PROJ>`." then "Get the reviewer workload for `<PROJ>`." | Both return; `sprint`, `truncated` present | |
| 1.8 | "Get time metrics for `<PROJ>`." then "Get time in status for `<PROJ>`." | Both return without error | |
| 1.9 | **Stress:** "Get all labels for `<BIGPROJ>`. Show raw JSON and tell me the `truncated` value." | Completes (may take longer / multiple pages); if project > 5000 issues, `truncated:true` | |
| 1.10 | "Get unassigned by role for `<PROJ>`." | Percentages ≤ 100%, based on counted population | |

## 2. PR #19 — transition with fields (resolution fix)
| # | Prompt | Expected | Result |
|---|---|---|---|
| 2.1 | "Get the available transitions for `<ISSUE>`. Show raw JSON." | Lists transitions with ids/names | |
| 2.2 | "Transition `<ISSUE>` using the Close transition id, and set fields `{\"resolution\":{\"name\":\"Won't Do\"}}`." (use a resolution name that exists in your Jira) | Success; response shows `fields_set: ["resolution"]` | |
| 2.3 | "Search Jira with jql: `key = <ISSUE> AND resolution = \"Won't Do\"`" | **1 result** (was 0 before the fix) | |
| 2.4 | "Bulk transition `<ISSUE-A>` and `<ISSUE-B>` with the Close transition id and fields `{\"resolution\":{\"name\":\"Won't Do\"}}`." (sandbox issues) | Response: `succeeded: 2, failed: 0, fields_set: ["resolution"]` | |
| 2.5 | **Backward-compat:** "Transition `<SANDBOX-ISSUE>` with a transition id and no fields." | Still works exactly as before | |

## 3. PR #19 — Confluence `last_updated` fix
| # | Prompt | Expected | Result |
|---|---|---|---|
| 3.1 | "Search Confluence pages with cql `space=<SPACE> AND type=page`, limit 5. Show raw JSON." | Each page has a **non-null `last_updated`** and `last_updated_by` | |
| 3.2 | "Find the Confluence page titled '<some title>' in space `<SPACE>`. Show raw JSON." | `last_updated` populated | |
| 3.3 | "Search Confluence pages by label '<label>' in space `<SPACE>`. Show raw JSON." | `last_updated` populated | |
| 3.4 | "Get the version history of Confluence page `<PAGE_ID>`." | Returns versions (tests the DC fallback path) | |

## 4. PR #19 — structured errors & robustness
| # | Prompt | Expected | Result |
|---|---|---|---|
| 4.1 | "Get the full issue for `ZZZ-999999` (a key that doesn't exist)." | Clean structured error (`JIRA_3001`-ish "not found"), **not** a crash/hang | |
| 4.2 | "Update issue with issue_key `not a key` and some fields." | Structured `MISSING_REQUIRED_FIELD` about the key shape | |
| 4.3 | "Add a comment to `<ISSUE>` with a body containing a double-quote and a `\\n`." | Comment posts; no breakage (JQL/format safe) | |
| 4.4 | "Search Jira with jql `key = <ISSUE> AND summary ~ \"a\\\"b\"` (a quote inside)." | Handled gracefully, no query-breakout error | |
| 4.5 | "Get a Confluence page with id `000000` (nonexistent)." | Clean `CONF_3001` not-found, not a hang | |

## 5. Read tools — issue-level
| # | Prompt | Expected | Result |
|---|---|---|---|
| 5.1 | "Get the full issue `<ISSUE>`. Show raw JSON." | Full fields returned | |
| 5.2 | "Get the change history of `<ISSUE>`." | History entries | |
| 5.3 | "Get the issue links for `<ISSUE>`." | Links (or empty) | |
| 5.4 | "Get worklogs for `<ISSUE>`." | Worklogs (or empty) | |
| 5.5 | "List attachments on `<ISSUE>`." | Attachment metadata list | |
| 5.6 | "Get watchers for `<ISSUE>`." | Watchers list | |

## 6. Read tools — project/sprint/board
| # | Prompt | Expected | Result |
|---|---|---|---|
| 6.1 | "List boards." → "Get board `<BOARD_ID>`." | Boards; board detail | |
| 6.2 | "List sprints for `<PROJ>`." | Sprints (note: fallback samples up to 500 issues) | |
| 6.3 | "Search sprint issues for `<PROJ>`, max 5. Show raw JSON." | `total`, `returned`, **`truncated`** present | |
| 6.4 | "Get sprint KPI data for `<PROJ>`, max 5. Show raw JSON." | `truncated` present | |
| 6.5 | "Get blocked tickets for `<PROJ>`." | Returns list | |
| 6.6 | "Get sprint velocity for `<PROJ>`." | Returns without error | |

## 7. Confluence reads (broader)
| # | Prompt | Expected | Result |
|---|---|---|---|
| 7.1 | "Get Confluence space `<SPACE>`." | Space details | |
| 7.2 | "Get Confluence page `<PAGE_ID>`. Show raw JSON." | Body + version + space | |
| 7.3 | "Get child pages of `<PAGE_ID>`." | Children (or empty) | |
| 7.4 | "Get labels on page `<PAGE_ID>`." | Labels | |
| 7.5 | "Get comments on page `<PAGE_ID>`." | Comments | |
| 7.6 | "Who am I in Confluence?" (current user) | Profile | |

## 8. Write flow (SANDBOX ONLY — mutates data)
| # | Prompt | Expected | Result |
|---|---|---|---|
| 8.1 | "Create a Jira issue in `<SANDBOX>` titled 'MCP test — delete me'. Show raw JSON." | Returns `issue_key`; if secondary fields fail, `partial_success:true` | |
| 8.2 | "Add a comment to that new issue." | Comment id returned; `author` not null | |
| 8.3 | "Attach a small text file to that issue." | Attachment metadata returned | |
| 8.4 | "Update that issue's summary." | Success | |
| 8.5 | "Delete that issue." (cleanup) | Success | |

## 9. Flakiness hunt (run these to characterize the "flaky" feeling)
| # | Prompt | Why | Result |
|---|---|---|---|
| 9.1 | Run **1.1 three times in a row.** | Consistency — same numbers each time? Any random errors? | |
| 9.2 | Run **1.9 (big project)** and time it. | Does it ever time out? (now returns `JIRA_5003` instead of hanging) | |
| 9.3 | Do a tool call **right after the app has been idle 10+ min.** | Cold-start flakiness / first-call failures | |
| 9.4 | Call the same read tool for 5 different projects back to back. | Rate-limit behavior (`JIRA_4001` with `retry_after`?) | |
| 9.5 | Any call that fails — **immediately retry it once.** | Does it succeed on retry? (points to transient vs real) | |

---

## How to report back
For every ❌ or ⚠️, paste:
1. The **prompt** you used and the **exact args** Claude called the tool with.
2. The **raw JSON** returned — especially any `error_code`, `error_message`, `truncated`.
3. Whether a **retry** succeeded (from 9.5).

That's enough for the developer session to reproduce/fix. A pattern of `JIRA_5002`/`JIRA_5003`
(network/timeout) points at the server or network; `JIRA_1001/1002` points at the token/permissions;
wrong numbers with `truncated:false` points at a logic bug to fix.
