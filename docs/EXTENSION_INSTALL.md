# Installing the Jira & Confluence extension (Claude Desktop)

This MCP server ships as a **Claude Desktop extension** (`.mcpb`). Everyone installs the
**same** bundle, but **each person signs in with their own Jira/Confluence Personal Access
Token (PAT)** — tokens are entered at install time and stored locally in your OS keychain.
Nothing sensitive is baked into the shared file.

---

## For colleagues — install (2 minutes)

1. **Get the bundle**: download `jira-confluence-quinta.mcpb` from the latest
   [GitHub Release](https://github.com/JasserAmri/jira-mcp-quicktext/releases) (or wherever
   your admin shared it).
2. **Open** Claude Desktop → **Settings → Extensions**.
3. **Drag** the `.mcpb` file onto the **"Drag .MCPB or .DXT files here to install"** area
   (or use **Install Extension** and pick the file).
4. When prompted, fill in the config:
   - **Jira Base URL** — pre-filled (`https://jira.gotogo.im`); leave as-is unless yours differs.
   - **Jira Personal Access Token** — **your own** PAT (see below). Required.
   - **Confluence Base URL / PAT** — optional; fill in to enable Confluence tools, or leave
     the token blank to skip Confluence.
   - Leave **Auth Type** as `bearer` and **User Email** blank (those are only for `basic` auth).
5. Enable the extension if it isn't already, and **restart Claude Desktop** if prompted.

Test it in a chat: *"List the Jira boards"* or *"Who am I in Jira?"*.

### How to create your Jira / Confluence PAT
On the self-hosted server (Data Center): **Profile avatar → Personal Access Tokens →
Create token**. Copy it once and paste it into the extension's token field. Do the same on
Confluence if you need Confluence tools. Never share or commit these tokens.

---

## For the admin — producing the bundle

The bundle is fully self-contained (the build inlines all dependencies — no `node_modules`
ships), so packaging is one command.

**Option A — let CI build it (recommended):**
Push a version tag and the `Release MCPB extension` workflow builds and attaches the
`.mcpb` to a GitHub Release:
```bash
git tag v5.0.0 && git push origin v5.0.0
```
(or run the workflow manually from the **Actions** tab). Share the Release link.

**Option B — build locally:**
```bash
npm ci
npm run bundle      # runs the build + packs jira-confluence-quinta.mcpb
```
Then distribute the resulting `jira-confluence-quinta.mcpb` (shared drive, Slack, MDM, etc.).

### Optional: sign the bundle
Unsigned bundles install fine but show as an unverified publisher. To sign in CI, add repo
secrets `MCPB_SIGN_CERT` and `MCPB_SIGN_KEY` (PEM contents) — the release workflow signs
automatically when they're present. To sign locally:
```bash
npx @anthropic-ai/mcpb sign jira-confluence-quinta.mcpb --cert cert.pem --key key.pem
```

---

## Notes
- **Per-user tokens**: the `jira_api_token` / `confluence_api_token` fields are marked
  `sensitive` in `manifest.json`, so Claude Desktop masks them and stores them in the OS
  keychain per install. The shared `.mcpb` contains no credentials.
- **Runtime**: Claude Desktop's built-in Node runs the server; no system Node install needed.
- **Updates**: publish a new tag/Release; colleagues re-install the new `.mcpb` (or rely on
  extension auto-updates if enabled).
- **Target**: self-hosted Jira/Confluence **Data Center** (Jira REST v2, Confluence REST v1).
