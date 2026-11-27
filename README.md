# jira-server-mcp

A tiny MCP server for **self-hosted Jira Server / Data Center**: one file, no npm packages.

- Works with any MCP client: Claude, VS Code (Copilot agent mode), Cline, ...
- Auth: personal access token (Jira 8.14+).
- Needs Node 22.15+. Uses the OS certificate store, so internal CAs just work.

## Tools

| Tool | Does |
|---|---|
| `jira_whoami` | Check token, server version |
| `jira_search` | JQL search (slim results) |
| `jira_get_issue` | Issue with description, comments, links, sub-tasks, attachments |
| `jira_list_projects` | Projects you can see |
| `jira_create_meta` | Issue types, required fields, allowed values |
| `jira_create_issue` | Create, optionally from a preset |
| `jira_update_issue` | Set fields or add/remove values |
| `jira_add_comment` | Comment (wiki markup) |
| `jira_add_attachment` | Attach local files, or inline text / base64 (50 MB each), optional comment |
| `jira_transition` | List or run workflow transitions |
| `jira_resolve` | Walk to Resolved (via In Progress) and set resolution Fixed; per-type overrides |
| `jira_link_issues` | Link issues / list link types |
| `jira_find_user` | Look up usernames |
| `jira_request` | Any other REST call |

## Setup

1. Create a token in Jira: profile → **Personal Access Tokens**.
2. Copy `jira-mcp.example.json` to `jira-mcp.json` (same folder) and fill in `baseUrl` and `token`.
   - Or set `JIRA_BASE_URL` / `JIRA_PAT`, or point `JIRA_MCP_CONFIG` at another file.
3. Register it with your client.

**VS Code** (`mcp.json`):
```json
{ "servers": { "jira": { "type": "stdio", "command": "node", "args": ["/path/to/jira-mcp.mjs"] } } }
```

**Claude Desktop** (`claude_desktop_config.json`):
```json
{ "mcpServers": { "jira": { "command": "node", "args": ["/path/to/jira-mcp.mjs"] } } }
```

**Cline**: see [Using it from Cline](#using-it-from-cline).

## Presets

Team defaults for `jira_create_issue`, so you only give a summary and description:

- `summaryPrefix`: added if missing.
- `epic`: Epic Link key.
- `sprintPrefix`: adds the issue to the active sprint whose name starts with this.
- `fields`: any other fields, REST v2 shape.

Epic Link and Sprint field ids are found by name. Override with `fields.epicLink` / `fields.sprint` in the config if yours differ.

## Resolve

`jira_resolve` walks the workflow to a done status, passing through `via` statuses, and sets the resolution. Defaults: Resolved / Fixed / via In Progress. Override per issue type:

```json
"resolve": { "default": { "status": "Resolved", "resolution": "Fixed", "via": ["In Progress"] },
             "Task": { "status": "Done", "resolution": "Done" } }
```

## Using it from Cline

Where Cline keeps its MCP settings:

- Easiest: in Cline, click **MCP Servers** (stack icon) → **Installed** → **Configure MCP Servers**. This opens `cline_mcp_settings.json`.
- VS Code extension: `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`
- Cline CLI / standalone: `%USERPROFILE%\.cline\data\settings\cline_mcp_settings.json`

Steps:

1. Copy the repo to a folder, e.g. `C:\tools\jira-server-mcp`.
2. Copy `jira-mcp.example.json` to `jira-mcp.json` there and fill it in (see **Setup** above).
3. Check it works: `node C:\tools\jira-server-mcp\jira-mcp.mjs --call jira_whoami`.
4. Add a `jira` entry under `mcpServers` (merge it with any servers already there):

```json
{
  "mcpServers": {
    "jira": {
      "command": "node",
      "args": ["C:\\tools\\jira-server-mcp\\jira-mcp.mjs"],
      "disabled": false,
      "timeout": 60
    }
  }
}
```

5. Save. Cline restarts the server; it should show a green dot in **MCP Servers**.

Notes:

- Backslashes in Windows paths must be doubled in JSON.
- The server reads `jira-mcp.json` from its own folder, so no `env` is needed. To keep the config elsewhere, add `"env": { "JIRA_MCP_CONFIG": "C:\\path\\to\\jira-mcp.json" }`.
- `node` must be on PATH (Node 22.15+). If not, use the full path, e.g. `"C:\\Program Files\\nodejs\\node.exe"`.

## CLI

```sh
node jira-mcp.mjs --list
node jira-mcp.mjs --call jira_search '{"jql":"assignee = currentUser() AND resolution = Unresolved"}'
node jira-mcp.mjs --call jira_create_issue --args-file req.json
node jira-mcp.mjs --call jira_add_attachment '{"key":"PROJ-123","path":"notes.md","comment":"See [^notes.md]"}'
```

## Note

`jira-mcp.json` holds your token. It is git-ignored; keep it that way.

## License

MIT
