# Project memory — jira-mcp-quicktext

## Local environment (the user's machine)
- The user's **local clone** lives at: `C:\Users\JasserAMRI\jira-mcp-quicktext` (Windows / PowerShell).
- When giving the user commands to run locally, **always prefix with the `cd` to that path**, e.g.:
  ```powershell
  cd C:\Users\JasserAMRI\jira-mcp-quicktext
  ```
- Their MCP client is **Claude Desktop**; the `jira-confluence-quicktext` connector runs `build\index.js`
  from that folder (path confirmed in `claude_desktop_config.json`). After pulling new code they must
  run `npm run build` and then **fully quit + reopen Claude Desktop** for changes to take effect.

## How this repo is worked on
- Claude Code sessions run in a **remote Linux cloud VM** (`/home/user/jira-mcp-quicktext`), which is a
  separate clone from the user's Windows machine. The two only sync via GitHub — Claude pushes, the user pulls.
- The `quicktext-jira_*` / `quicktext-confluence_*` MCP tools are **not** reachable from the cloud session;
  live tool testing must be done by the user in their Desktop app. Claude verifies code by building and
  booting the server over stdio (`tools/list`), not by calling the live connector.
- Active development branch: `claude/jira-mcp-confluence-tools-tndasc` (PR #19).

## Build / test quick reference
- Install: `npm ci`  ·  Build: `npm run build` (vite → `build/index.js`)
- Unit tests: `npm test` (runs `bun test`; the suite currently covers the v3 client only)
- Live suite (real creds, user's machine): `npm run test:live` — see `tests/live/.env.live.example`
- The server targets **self-hosted Jira/Confluence Data Center** (Jira REST v2, Confluence REST v1).
