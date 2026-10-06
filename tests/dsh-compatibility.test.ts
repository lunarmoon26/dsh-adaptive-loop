import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSystemMessage, createToolResultMessage, ToolCallId } from "@deepseek-ai/dsh-llm";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { RunSessionRecorder } from "../plugins/dal-run-record/src/index.js";
import { sha256 } from "../src/json.js";
import { validateRunRecord } from "../src/runs.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dal-dsh-compat-"));
  const id = SessionId("session-compat");
  const session = Session.create(id, undefined, { id, version: SESSION_FORMAT_VERSION, cwd: root, createdAt: Date.now(), isSeeded: false });
  const recorder = new RunSessionRecorder({});
  recorder.create(session);
  recorder.onEvent(session, session.append("turn/start", { turn: 1 }));
  recorder.onEvent(session, session.append("step/start", { turn: 1, step: 1 }));
  return { root, session, recorder };
}
async function finish(input: Awaited<ReturnType<typeof fixture>>) {
  const { root, session, recorder } = input;
  recorder.onEvent(session, session.append("turn/end", { turn: 1, reason: { kind: "completed" } }));
  await recorder.dispose(session);
  const path = join(root, ".dal", "runs", (await readdir(join(root, ".dal", "runs")))[0]!);
  const raw = await readFile(path, "utf8");
  const record = await validateRunRecord(JSON.parse(raw), raw);
  return { record, raw };
}

describe("DSH 0.2.0-rc.2 compatibility", () => {
  it("records native session envelopes, prompt hashes and nested tool-result identities without raw content", async () => {
    const input = await fixture();
    const { session, recorder } = input;
    const prompt = "SYNTHETIC_SYSTEM_SENTINEL";
    recorder.onEvent(session, session.append("system/message", { turn: 1, step: 1, message: createSystemMessage(prompt) }, { surfaceOp: "append" }));
    recorder.onEvent(session, session.append("request/header", { reason: "initial", header: { config: { provider: "synthetic", model: "synthetic-model" } } }));
    for (const [name, failed] of [["read", false], ["write", true]] as const) {
      const callId = ToolCallId(`private-${name}-sentinel`);
      recorder.onEvent(session, session.append("tool/call", { turn: 1, step: 1, callId, name, arguments: "PRIVATE_ARGUMENT_SENTINEL" }));
      recorder.onEvent(session, session.append("tool/result", { turn: 1, step: 1,
        message: createToolResultMessage({ callId, isError: failed, content: [{ type: "text", text: "PRIVATE_RESULT_SENTINEL" }] }),
      }, { surfaceOp: "append" }));
    }
    const { record, raw } = await finish(input);
    expect(record.context.prompt_sha256).toBe(sha256(prompt));
    expect(record.context.model).toEqual({ id: "synthetic-model", version: "synthetic" });
    expect(record.trace!.map(item => [item.tool, item.outcome, item.code])).toEqual([["read", "ok", null], ["write", "failed", "UNKNOWN"]]);
    for (const sentinel of [prompt, "PRIVATE_ARGUMENT_SENTINEL", "PRIVATE_RESULT_SENTINEL", "private-read-sentinel", "private-write-sentinel"]) expect(raw).not.toContain(sentinel);
  });

  it.each(["append", "replace"] as const)("does not invent prompt provenance after a %s update", async (operation) => {
    const input = await fixture();
    const { session, recorder } = input;
    const first = session.append("system/message", { turn: 1, step: 1, message: createSystemMessage("SYNTHETIC_BASE") }, { surfaceOp: "append" });
    recorder.onEvent(session, first);
    const changed = session.append("system/message", { turn: 1, step: 1, message: createSystemMessage("SYNTHETIC_CHANGE") }, operation === "append"
      ? { surfaceOp: "append" }
      : { surfaceOp: { op: "replace", startSeq: first.seq, endSeq: first.seq }, sourceEventSeqs: [first.seq] });
    recorder.onEvent(session, changed);
    const { record, raw } = await finish(input);
    expect(record.context.prompt_sha256).toBeNull();
    expect(raw).not.toContain("SYNTHETIC_BASE"); expect(raw).not.toContain("SYNTHETIC_CHANGE");
  });

  it("keeps conflicting legacy and native call identities unknown", async () => {
    const input = await fixture();
    const { session, recorder } = input;
    const callId = ToolCallId("private-native-call");
    recorder.onEvent(session, session.append("tool/call", { turn: 1, step: 1, callId, name: "read", arguments: "{}" }));
    recorder.onEvent(session, { seq: 3, time: Date.now(), type: "tool/result", data: {
      callId: "conflicting-legacy-call", message: createToolResultMessage({ callId, content: [], isError: false }),
    } });
    const { record } = await finish(input);
    expect(record.trace![0]!.outcome).toBe("unknown");
  });

  it("aligns all package manifests and tool peers with the target prerelease", async () => {
    const packages = ["package.json", ...(await readdir("plugins")).map(name => `plugins/${name}/package.json`)];
    for (const path of packages) {
      const pkg = JSON.parse(await readFile(path, "utf8"));
      for (const group of ["dependencies", "devDependencies", "peerDependencies"]) {
        for (const [name, version] of Object.entries(pkg[group] ?? {})) {
          if (name.startsWith("@deepseek-ai/dsh-")) expect(version, `${path}: ${name}`).toBe("0.2.0-rc.2");
          if (name === "@deepseek-ai/cordis") expect(["4.0.4", "~4.0.4"]).toContain(version);
        }
      }
    }
  });
});
