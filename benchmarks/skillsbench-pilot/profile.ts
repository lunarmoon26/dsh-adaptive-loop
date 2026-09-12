import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../../src/json.js";
import { decodeSessionFrames } from "../tau-style-workflow/run-e2e.js";
import { buildGatewayCompositionPatch, buildToolsRow } from "../tau-style-workflow/e2e-prompt.js";

export type PilotProfile = "standard" | "lean";
export function pilotProfile(value = "standard"): PilotProfile {
  if (value !== "standard" && value !== "lean") throw new Error("Harness profile must be standard or lean");
  return value;
}
export const LEAN_TOOLS = Object.freeze(["bash", "edit", "glob", "grep", "read", "read_image", "skill", "write"]);
const STANDARD_TOOLS = [...LEAN_TOOLS, "create_goal", "exit_plan_mode", "get_goal", "interrupt_agent", "job_kill", "job_list", "job_output",
  "list_agents", "ralph", "send_message", "str_replace_editor", "subagent", "subagent_fork", "todo_write", "update_goal", "web_search", "workflow"].sort();
// Row IDs inspected in the pinned installed dsh-base composition. Disable tool
// providers, not sandbox, permission, persistence, compaction or model services.
const DISABLED_ROWS = ["tool-goal", "tool-todo", "tool-jobs", "plan-mode", "tool-ralph", "tool-workflow", "tool-web",
  "tool-subagent", "tool-subagent-fork", "tool-subagent-control", "tool-subagent-list-agents", "tool-subagent-report", "tool-str-replace-editor"];

export function pilotCompositionPatch(profile: PilotProfile): string {
  pilotProfile(profile);
  const base = buildGatewayCompositionPatch("openai", "gpt-5.6-terra", "unused").replace(buildToolsRow("unused"), "");
  if (profile === "standard") return base;
  return base + DISABLED_ROWS.map(id => `- id: ${id}\n  disabled: true\n`).join("")
    + "- id: tool-bash\n  config:\n    enableRunInBackground: false\n";
}

/** Validate every observed request header, not just a declared tool list. */
export function catalogEvidence(raw: string, profile: PilotProfile) {
  pilotProfile(profile);
  if (Buffer.byteLength(raw) > 32 * 1024 * 1024) throw new Error("Session exceeds catalog inspection bound");
  const headers = raw.split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(event => event.type === "request/header");
  if (!headers.length) throw new Error("Missing native request header");
  const expected = profile === "lean" ? [...LEAN_TOOLS] : STANDARD_TOOLS;
  return headers.map(event => {
    const header = event.data?.header;
    if (!Array.isArray(header?.tools) || typeof header.system !== "string") throw new Error("Invalid native request header");
    const tools = header.tools.map((tool: { name?: unknown }) => tool.name).sort();
    if (JSON.stringify(tools) !== JSON.stringify(expected)) throw new Error("Native tool catalog differs from pilot profile");
    return { tools, tool_schema_bytes: Buffer.byteLength(JSON.stringify(header.tools)), system_bytes: Buffer.byteLength(JSON.stringify(header.system)),
      header_sha256: sha256(JSON.stringify(header)) };
  });
}

export async function inspectPilotCatalog(home: string, profile: PilotProfile) {
  const sessions = join(home, "sessions");
  const files: string[] = [];
  for (const project of await readdir(sessions)) {
    const projectDir = join(sessions, project);
    if (!(await lstat(projectDir)).isDirectory() || await realpath(projectDir) !== projectDir) throw new Error("Unsafe session directory");
    for (const session of await readdir(projectDir)) {
      const dir = join(projectDir, session);
      if (!(await lstat(dir)).isDirectory() || await realpath(dir) !== dir) throw new Error("Unsafe session directory");
      for (const name of await readdir(dir)) if (name === "session.jsonl" || name === "session.jsonl.zstd") files.push(join(dir, name));
    }
  }
  if (files.length !== 1) throw new Error("Expected one fresh pilot session log");
  const path = files[0]!; const stat = await lstat(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024) throw new Error("Unsafe session log");
  const bytes = await readFile(path);
  const raw = path.endsWith(".zstd") ? decodeSessionFrames(bytes) : bytes.toString("utf8");
  return { profile, session_sha256: sha256(raw), headers: catalogEvidence(raw, profile) };
}
