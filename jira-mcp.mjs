#!/usr/bin/env node
/**
 * jira-mcp.mjs - MCP server (stdio) for self-hosted Jira Server / Data Center (REST API v2).
 * Generic: everything instance-specific lives in jira-mcp.json next to this file
 * (or the path in JIRA_MCP_CONFIG). See jira-mcp.example.json. No npm packages: Node 22.15+.
 *
 *   {
 *     "baseUrl": "https://jira.example.com",
 *     "token": "<personal access token>",          // or env JIRA_PAT
 *     "fields": { "epicLink": "customfield_10100", "sprint": "customfield_10101" },  // optional, else looked up by name
 *     "presets": {
 *       "team-x": { "summaryPrefix": "[X] ", "epic": "PROJ-1", "sprintPrefix": "X Sprint",
 *                   "fields": { "fixVersions": [{ "name": "1.0" }] } }
 *     }
 *   }
 *
 * Register with any MCP client: { "command": "node", "args": ["<path>/jira-mcp.mjs"] }
 *
 * CLI (scripts, or machines without an MCP client):
 *   node jira-mcp.mjs --list                          tool names
 *   node jira-mcp.mjs --call jira_search '{"jql":"key = PROJ-123"}'
 *   node jira-mcp.mjs --call jira_create_issue --args-file C:\temp\req.json
 *   Exit code 0 ok, 1 tool error.
 */
import https from "node:https";
import http from "node:http";
import tls from "node:tls";
import readline from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_PATH = process.env.JIRA_MCP_CONFIG ?? join(dirname(fileURLToPath(import.meta.url)), "jira-mcp.json");
const CONFIG = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, "")) : {};
const BASE_URL = (process.env.JIRA_BASE_URL ?? CONFIG.baseUrl ?? "").replace(/\/+$/, "");
const TOKEN = process.env.JIRA_PAT || CONFIG.token;
const PRESETS = CONFIG.presets ?? {};
if (!BASE_URL || !TOKEN) console.error(`[jira] baseUrl and token must be set in ${CONFIG_PATH} (or JIRA_BASE_URL / JIRA_PAT)`);
const TIMEOUT_MS = 60_000;

const log = (...a) => console.error("[jira]", ...a);

/* ---------- HTTP ---------- */

let ca;
try { ca = [...tls.rootCertificates, ...tls.getCACertificates("system")]; } catch { ca = undefined; }

function jira(method, path, body) {
  const url = new URL(path.startsWith("http") ? path : BASE_URL + path);
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
  const lib = url.protocol === "http:" ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method,
      ca,
      timeout: TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/json",
        ...(payload && { "Content-Type": "application/json; charset=utf-8", "Content-Length": payload.length }),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data = text;
        try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`Timed out after ${TIMEOUT_MS / 1000}s`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function call(method, path, body) {
  const r = await jira(method, path, body);
  if (r.status >= 200 && r.status < 300) return r.data;
  const d = r.data;
  const msgs = d && typeof d === "object"
    ? [...(d.errorMessages ?? []), ...Object.entries(d.errors ?? {}).map(([k, v]) => `${k}: ${v}`)]
    : [];
  const detail = msgs.length ? msgs.join("; ") : String(typeof d === "string" ? d.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") : JSON.stringify(d)).slice(0, 1500);
  throw new Error(`Jira returned ${r.status}: ${detail}`);
}

const q = (params) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(Array.isArray(v) ? v.join(",") : v)}`)
    .join("&");
const enc = encodeURIComponent;
const browse = (key) => `${BASE_URL}/browse/${key}`;

/** Custom field ids: from config, else found by name ("Epic Link", "Sprint"). */
let fieldIds;
async function customField(key, name) {
  if (CONFIG.fields?.[key]) return CONFIG.fields[key];
  fieldIds ??= await call("GET", "/rest/api/2/field");
  return fieldIds.find((f) => f.name === name)?.id;
}

/** Id of the active sprint whose name starts with prefix, on any board of the project. */
async function activeSprintId(project, prefix) {
  const boards = await call("GET", `/rest/agile/1.0/board?${q({ projectKeyOrId: project, maxResults: 50 })}`);
  for (const b of boards.values ?? []) {
    const r = await jira("GET", `/rest/agile/1.0/board/${b.id}/sprint?state=active`);
    const s = (r.data?.values ?? []).find((x) => x.name?.startsWith(prefix));
    if (s) return s.id;
  }
  return undefined;
}

const DEFAULT_FIELDS = ["summary", "status", "issuetype", "priority", "assignee", "reporter", "updated", "fixVersions", "components", "labels", "parent"];

function slimIssue(i) {
  const out = { key: i.key };
  for (const [k, v] of Object.entries(i.fields ?? {})) {
    if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) continue;
    if (k === "comment") {
      out.comments = (v.comments ?? []).map((c) => ({ id: c.id, author: c.author?.displayName, created: c.created, body: c.body }));
    } else if (k === "issuelinks") {
      out.issuelinks = v.map((l) => {
        const other = l.outwardIssue ?? l.inwardIssue;
        return { type: l.outwardIssue ? l.type?.outward : l.type?.inward, key: other?.key, summary: other?.fields?.summary };
      });
    } else if (k === "subtasks") {
      out.subtasks = v.map((t) => ({ key: t.key, summary: t.fields?.summary, status: t.fields?.status?.name }));
    } else if (Array.isArray(v)) {
      out[k] = v.map((x) => x?.name ?? x?.value ?? x?.key ?? x);
    } else if (typeof v === "object") {
      out[k] = v.displayName ?? v.name ?? v.value ?? v.key ?? v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/* ---------- tools ---------- */

const str = (description) => ({ type: "string", ...(description && { description }) });
const obj = (description) => ({ type: "object", additionalProperties: true, ...(description && { description }) });
const strs = (description) => ({ type: "array", items: { type: "string" }, ...(description && { description }) });
const schema = (properties, required = []) => ({ type: "object", properties, required });

const tools = [
  {
    name: "jira_whoami",
    description: "Check the connection and token: the signed-in Jira user and server version.",
    inputSchema: schema({}),
    run: async () => {
      const me = await call("GET", "/rest/api/2/myself");
      const info = await call("GET", "/rest/api/2/serverInfo");
      return { user: me.name, displayName: me.displayName, email: me.emailAddress, server: info.version, deployment: info.deploymentType };
    },
  },
  {
    name: "jira_search",
    description: "Search issues with JQL, e.g. project = PROJ AND assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC",
    inputSchema: schema({
      jql: str(),
      fields: strs("Fields to return (default: summary, status, type, priority, assignee, ...)"),
      maxResults: { type: "integer", minimum: 1, maximum: 200, description: "Default 25" },
      startAt: { type: "integer", minimum: 0 },
    }, ["jql"]),
    run: async ({ jql, fields, maxResults, startAt }) => {
      const r = await call("POST", "/rest/api/2/search", { jql, startAt: startAt ?? 0, maxResults: maxResults ?? 25, fields: fields ?? DEFAULT_FIELDS });
      return { total: r.total, startAt: r.startAt, issues: r.issues.map(slimIssue) };
    },
  },
  {
    name: "jira_get_issue",
    description: "Get one issue with description, comments, links and sub-tasks. Pass fields to narrow, or raw=true for the full Jira JSON.",
    inputSchema: schema({ key: str("e.g. PROJ-123"), fields: strs(), raw: { type: "boolean" } }, ["key"]),
    run: async ({ key, fields, raw }) => {
      const f = fields ?? [...DEFAULT_FIELDS, "description", "comment", "issuelinks", "subtasks", "created", "resolution"];
      const r = await call("GET", `/rest/api/2/issue/${enc(key)}?${q({ fields: f })}`);
      return raw ? r : { ...slimIssue(r), url: browse(r.key) };
    },
  },
  {
    name: "jira_list_projects",
    description: "List the projects you can see (key, name).",
    inputSchema: schema({}),
    run: async () => (await call("GET", "/rest/api/2/project")).map((p) => ({ key: p.key, name: p.name })),
  },
  {
    name: "jira_create_meta",
    description: "What creating an issue needs. Without issueType: the project's issue types. With issueType (name or id): every field, which are required, and allowed values. Use before jira_create_issue.",
    inputSchema: schema({ project: str("Project key, e.g. PROJ"), issueType: str("e.g. Bug") }, ["project"]),
    run: async ({ project, issueType }) => {
      const types = await call("GET", `/rest/api/2/issue/createmeta/${enc(project)}/issuetypes?maxResults=100`);
      const list = types.values ?? types;
      if (!issueType) return list.map((t) => ({ id: t.id, name: t.name, subtask: t.subtask }));
      const t = list.find((x) => x.id === issueType || x.name.toLowerCase() === issueType.toLowerCase());
      if (!t) throw new Error(`No issue type "${issueType}" in ${project}. Types: ${list.map((x) => x.name).join(", ")}`);
      const fields = await call("GET", `/rest/api/2/issue/createmeta/${enc(project)}/issuetypes/${t.id}?maxResults=200`);
      return {
        issueType: { id: t.id, name: t.name },
        fields: (fields.values ?? fields).map((f) => ({
          id: f.fieldId,
          name: f.name,
          required: f.required,
          hasDefault: f.hasDefaultValue,
          type: (f.schema?.type ?? "") + (f.schema?.items ? `<${f.schema.items}>` : "") + (f.schema?.custom ? ` (${f.schema.custom.split(":").pop()})` : ""),
          allowed: f.allowedValues?.slice(0, 50).map((v) => v.name ?? v.value ?? v.key ?? v.id),
        })),
      };
    },
  },
  {
    name: "jira_create_issue",
    description: "Create an issue. A preset (from jira-mcp.json: " + (Object.entries(PRESETS).map(([k, v]) => k + (v.description ? " = " + v.description : "")).join("; ") || "none") + ") fills defaults such as summary prefix, epic, sprint and fields; anything in `fields` overrides it. Description is Jira wiki markup (not Markdown). Other fields go in `fields` in REST v2 shape, e.g. {\"components\":[{\"name\":\"Backend\"}],\"priority\":{\"name\":\"Major\"},\"customfield_10001\":\"x\"}. Run jira_create_meta first for required fields.",
    inputSchema: schema({
      project: str(),
      issueType: str("e.g. Bug, Task, Story, Sub-task"),
      summary: str(),
      description: str(),
      assignee: str("Jira username"),
      parent: str("Parent key, for sub-tasks"),
      labels: strs(),
      fields: obj("Extra fields, merged last"),
      preset: { type: "string", ...(Object.keys(PRESETS).length && { enum: Object.keys(PRESETS) }) },
      noSprint: { type: "boolean", description: "With a preset: don't add the issue to the active sprint" },
    }, ["project", "issueType", "summary"]),
    run: async ({ project, issueType, summary, description, assignee, parent, labels, fields, preset, noSprint }) => {
      const p = preset ? PRESETS[preset] : undefined;
      if (preset && !p) throw new Error(`Unknown preset ${preset}`);
      if (p?.summaryPrefix && !summary.startsWith(p.summaryPrefix)) summary = p.summaryPrefix + summary;
      const f = { project: { key: project }, issuetype: { name: issueType }, summary, ...structuredClone(p?.fields ?? {}) };
      if (p?.epic && !parent) {
        const id = await customField("epicLink", "Epic Link");
        if (id) f[id] = p.epic;
      }
      if (p?.sprintPrefix && !noSprint && !parent) {
        const [fid, sid] = await Promise.all([customField("sprint", "Sprint"), activeSprintId(project, p.sprintPrefix).catch(() => undefined)]);
        if (fid && sid) f[fid] = sid;
      }
      if (description) f.description = description;
      if (assignee) f.assignee = { name: assignee };
      if (parent) f.parent = { key: parent };
      if (labels) f.labels = labels;
      Object.assign(f, fields ?? {});
      const r = await call("POST", "/rest/api/2/issue", { fields: f });
      return { key: r.key, url: browse(r.key) };
    },
  },
  {
    name: "jira_update_issue",
    description: "Update an issue. `fields` sets values (e.g. {\"summary\":\"...\",\"assignee\":{\"name\":\"jdoe\"}}); `update` uses add/remove/set operations (e.g. {\"labels\":[{\"add\":\"e2e\"}]}).",
    inputSchema: schema({ key: str(), fields: obj(), update: obj(), notifyUsers: { type: "boolean", description: "Default true" } }, ["key"]),
    run: async ({ key, fields, update, notifyUsers }) => {
      if (!fields && !update) throw new Error("Pass fields and/or update.");
      await call("PUT", `/rest/api/2/issue/${enc(key)}${notifyUsers === false ? "?notifyUsers=false" : ""}`, { ...(fields && { fields }), ...(update && { update }) });
      return `Updated ${key}: ${browse(key)}`;
    },
  },
  {
    name: "jira_add_comment",
    description: "Add a comment (Jira wiki markup).",
    inputSchema: schema({ key: str(), body: str() }, ["key", "body"]),
    run: async ({ key, body }) => {
      const r = await call("POST", `/rest/api/2/issue/${enc(key)}/comment`, { body });
      return { id: r.id, url: `${browse(key)}?focusedCommentId=${r.id}` };
    },
  },
  {
    name: "jira_transition",
    description: "Move an issue through its workflow. Without `to`: lists available transitions. With `to` (transition name, target status, or id): performs it, optionally setting fields (e.g. {\"resolution\":{\"name\":\"Done\"}}) and adding a comment.",
    inputSchema: schema({ key: str(), to: str(), fields: obj(), comment: str() }, ["key"]),
    run: async ({ key, to, fields, comment }) => {
      const path = `/rest/api/2/issue/${enc(key)}/transitions`;
      const list = (await call("GET", path)).transitions.map((t) => ({ id: t.id, name: t.name, to: t.to?.name }));
      if (!to) return list;
      const w = to.toLowerCase();
      const t = list.find((x) => x.id === to) ?? list.find((x) => x.name.toLowerCase() === w) ?? list.find((x) => x.to?.toLowerCase() === w);
      if (!t) throw new Error(`No transition "${to}". Available: ${list.map((x) => `${x.name} -> ${x.to}`).join(", ")}`);
      const body = { transition: { id: t.id } };
      if (fields) body.fields = fields;
      if (comment) body.update = { comment: [{ add: { body: comment } }] };
      await call("POST", path, body);
      return `${key}: ${t.name} -> ${t.to}`;
    },
  },
  {
    name: "jira_link_issues",
    description: "Link two issues. Without type: lists link types. Example: type 'Blocks', outward 'PROJ-1' (blocks) inward 'PROJ-2'.",
    inputSchema: schema({ type: str(), outward: str(), inward: str() }),
    run: async ({ type, outward, inward }) => {
      if (!type) return (await call("GET", "/rest/api/2/issueLinkType")).issueLinkTypes.map((t) => ({ name: t.name, outward: t.outward, inward: t.inward }));
      if (!outward || !inward) throw new Error("Pass both outward and inward keys.");
      await call("POST", "/rest/api/2/issueLink", { type: { name: type }, outwardIssue: { key: outward }, inwardIssue: { key: inward } });
      return `Linked ${outward} -[${type}]-> ${inward}`;
    },
  },
  {
    name: "jira_find_user",
    description: "Find users by name or email (gives usernames for assignee).",
    inputSchema: schema({ query: str() }, ["query"]),
    run: async ({ query }) =>
      (await call("GET", `/rest/api/2/user/search?${q({ username: query, maxResults: 20 })}`)).map((u) => ({ name: u.name, displayName: u.displayName, email: u.emailAddress, active: u.active })),
  },
  {
    name: "jira_request",
    description: "Escape hatch: any Jira REST call (path starting /rest/). Use only when no other tool fits.",
    inputSchema: schema({ method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"] }, path: str(), body: {} }, ["method", "path"]),
    run: async ({ method, path, body }) => {
      if (!path.startsWith("/rest/")) throw new Error("path must start with /rest/");
      return jira(method, path, body);
    },
  },
];

/* ---------- MCP over stdio (newline-delimited JSON-RPC) ---------- */

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];

async function handle(m) {
  const { id, method, params } = m;
  if (id === undefined) return; // notification
  switch (method) {
    case "initialize":
      return send({ id, result: {
        protocolVersion: SUPPORTED.includes(params?.protocolVersion) ? params.protocolVersion : SUPPORTED[0],
        capabilities: { tools: {} },
        serverInfo: { name: "jira", version: "1.0.0" },
      } });
    case "ping":
      return send({ id, result: {} });
    case "tools/list":
      return send({ id, result: { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
    case "tools/call": {
      const t = tools.find((x) => x.name === params?.name);
      if (!t) return send({ id, error: { code: -32602, message: `Unknown tool ${params?.name}` } });
      try {
        const v = await t.run(params.arguments ?? {});
        return send({ id, result: { content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] } });
      } catch (e) {
        log(e);
        return send({ id, result: { isError: true, content: [{ type: "text", text: e?.message ?? String(e) }] } });
      }
    }
    default:
      return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

/* ---------- CLI ---------- */

const argv = process.argv.slice(2);
if (argv[0] === "--list") {
  console.log(tools.map((t) => t.name).join("\n"));
  process.exit(0);
}
if (argv[0] === "--call") {
  const t = tools.find((x) => x.name === argv[1]);
  if (!t) { console.log(`Unknown tool ${argv[1]}. Use --list.`); process.exit(1); }
  const { readFileSync } = await import("node:fs");
  const raw = argv[2] === "--args-file" ? readFileSync(argv[3], "utf8").replace(/^\uFEFF/, "") : (argv[2] ?? "{}");
  try {
    const v = await t.run(JSON.parse(raw));
    console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
    process.exit(0);
  } catch (e) {
    console.log(`ERROR: ${e?.message ?? e}`);
    process.exit(1);
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let m;
  try { m = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: "Parse error" } }); }
  for (const x of Array.isArray(m) ? m : [m]) handle(x).catch((e) => log(e));
});
log(`ready: ${BASE_URL}`);
