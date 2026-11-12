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
| `jira_get_issue` | Issue with description, comments, links, sub-tasks |
| `jira_list_projects` | Projects you can see |
| `jira_create_meta` | Issue types, required fields, allowed values |
| `jira_create_issue` | Create, optionally from a preset |
| `jira_update_issue` | Set fields or add/remove values |
| `jira_add_comment` | Comment (wiki markup) |
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

**Cline / Claude Desktop** (`cline_mcp_settings.json` / `claude_desktop_config.json`):
```json
{ "mcpServers": { "jira": { "command": "node", "args": ["/path/to/jira-mcp.mjs"] } } }
```

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

## CLI

```sh
node jira-mcp.mjs --list
node jira-mcp.mjs --call jira_search '{"jql":"assignee = currentUser() AND resolution = Unresolved"}'
node jira-mcp.mjs --call jira_create_issue --args-file req.json
```

## Note

`jira-mcp.json` holds your token. It is git-ignored; keep it that way.

## License

MIT
