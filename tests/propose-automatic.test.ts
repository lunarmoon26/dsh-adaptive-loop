import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clusterRunRecords } from "../src/clustering.js";
import { canonicalJson, sha256 } from "../src/json.js";
import { prepareProposeRequest, runPropose } from "../src/propose.js";
import { TIMEOUT_MS, type ProposalBudget } from "../src/propose-transport.js";
import { ingestRunRecord } from "../src/runs.js";
import { assertSchema, SCHEMA_IDS } from "../src/schema.js";

const providers = [
  { provider: "openai", model: "gpt-5.6-terra", key: "OPENAI_API_KEY", endpoint: "https://api.openai.com/v1/responses" },
  { provider: "anthropic", model: "claude-sonnet-5", key: "ANTHROPIC_API_KEY", endpoint: "https://api.anthropic.com/v1/messages" },
] as const;
const reply = JSON.stringify({
  surface: "skills", target_uri: "repo://benchmarks/tau-style-workflow/.agents/skills/refund-workflow/SKILL.md",
  base_sha256: "9".repeat(64), title: "Require return labels before refunds",
  objective: "Create a return label before issuing a full refund.",
  statement: "Applying this change raises task_success_rate by at least 0.2 without regressing golden cases.",
  improvements: [{ metric: "task_success_rate", expected_delta: 0.2 }], regressions: [],
});
let root: string;
let budget: ProposalBudget;
beforeEach(async () => {
  // The ledger rejects symlink ancestors, including macOS /var -> /private/var.
  root = await realpath(await mkdtemp(join(tmpdir(), "dal-propose-automatic-")));
  budget = { budget_id: `test-${randomUUID()}`, provider_limit_microusd: 100, reservation_microusd: 60 };
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY"]) vi.stubEnv(key, "offline-test-key");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network call"); }));
});
afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function wire(provider: string, text = reply, truncated = false) {
  return provider === "openai"
    ? { status: truncated ? "incomplete" : "completed", output: [{ type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text }] }] }
    : { type: "message", role: "assistant", stop_reason: truncated ? "max_tokens" : "end_turn", content: [{ type: "text", text }] };
}

async function approval(digest: string, changes: Record<string, unknown> = {}) {
  const path = join(root, `decision-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify({
    $schema: "https://recursive-dev-loop.dev/schemas/approval-decision.v1.schema.json", schema_version: "1.0.0",
    decision_id: `dec-${randomUUID()}`, request_id: `req-${randomUUID()}`, action: "send_data_externally",
    scope: { kind: "data_transfer", value: digest, sha256: sha256(digest) }, decision: "approved",
    reviewer: { kind: "human", id: "offline-operator" },
    decided_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    rationale: "Synthetic exact approval for offline transport verification.", evidence: ["repo://tests/propose-automatic.test.ts"],
    candidate_sha256: null, ...changes,
  }));
  return path;
}

async function setup(model: { provider: string; model: string }) {
  const runsDir = join(root, "runs");
  const clustersDir = join(root, "clusters");
  for (const name of ["run-benchmark-fail.json", "run-benchmark-pass.json"]) {
    await ingestRunRecord(resolve(import.meta.dirname, "../benchmarks/tau-style-workflow/dal/fixtures", name), runsDir);
  }
  await clusterRunRecords({ store: runsDir, output: clustersDir });
  const prepared = await prepareProposeRequest({ clustersDir, runsDir, model, budget });
  const options = { clustersDir, runsDir, model, budget, budgetStore: join(root, "ledger"),
    outputPath: join(root, "draft.json"), approvalPath: await approval(prepared.requestDigest) };
  return { prepared, options };
}

async function ledger(provider: string) {
  const directory = join(root, "ledger", budget.budget_id, provider, "reservations");
  return Promise.all((await readdir(directory)).sort().map(async name => JSON.parse(await readFile(join(directory, name), "utf8"))));
}

function watchCredentials() {
  const env = process.env;
  const read = vi.fn();
  vi.stubGlobal("process", new Proxy(process, { get(target, key) {
    if (key !== "env") return Reflect.get(target, key);
    return new Proxy(env, { get(target, key) {
      if (typeof key === "string" && key.endsWith("_API_KEY")) read(key);
      return Reflect.get(target, key);
    } });
  } }));
  return read;
}

describe.each(providers)("automatic $provider $model proposer", (provider) => {
  it("runs fixture ingestion through native provider transport to a validated persisted draft", async () => {
    const { prepared, options } = await setup(provider);
    await assertSchema(provider.provider === "anthropic" ? SCHEMA_IDS.proposerRequestV3 : SCHEMA_IDS.proposerRequestV2, prepared.request, "Prepared provider request");
    expect(prepared.requestDigest).toBe(sha256(canonicalJson(prepared.request)));
    expect(prepared.payload.clusters[0]?.representative_failure).toContain("return label");
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(await ledger(provider.provider)).toMatchObject([{ request_digest: prepared.requestDigest, reservation_microusd: 60 }]);
      expect(url).toBe(provider.endpoint);
      expect(init).toMatchObject({ method: "POST", redirect: "error" });
      expect(JSON.parse(init.body as string)).toEqual(prepared.request.body);
      const headers = new Headers(init.headers);
      expect(headers.get(provider.provider === "openai" ? "authorization" : "x-api-key"))
        .toBe(provider.provider === "openai" ? "Bearer offline-test-key" : "offline-test-key");
      if (provider.provider === "anthropic") {
        expect(headers.get("anthropic-version")).toBe("2023-06-01");
        expect(JSON.parse(init.body as string).thinking).toEqual({ type: "disabled" });
      }
      expect(JSON.parse(init.body as string).model).toBe(provider.model);
      return new Response(JSON.stringify(wire(provider.provider)));
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runPropose(options);
    const persisted = JSON.parse(await readFile(options.outputPath, "utf8"));
    await assertSchema(SCHEMA_IDS.proposalDraft, persisted, "Persisted automatic draft");
    expect(persisted).toEqual(result.draft);
    expect(persisted).toMatchObject({ model: { provider: provider.provider, model: provider.model }, payload_sha256: prepared.digest,
      provenance: { runner: `${provider.provider}-https`, request_sha256: prepared.requestDigest, clusters: [{ code: "grader-mismatch" }] } });
    expect(result.status).toBe("recorded");
    await expect(runPropose({ ...options, outputPath: join(root, "repeat.json") })).rejects.toMatchObject({ code: "PROPOSE_REQUEST_ALREADY_RESERVED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await ledger(provider.provider)).toHaveLength(1);
  });

  it.each(["missing", "expired", "wrongbudget", "wrongprovider"])("rejects %s approval before credentials, fetch, or ledger creation", async (kind) => {
    const { prepared, options } = await setup(provider);
    if (kind === "missing") options.approvalPath = join(root, "missing.json");
    if (kind === "expired") options.approvalPath = await approval(prepared.requestDigest, { decided_at: "2020-01-01T00:00:00.000Z", expires_at: "2020-01-02T00:00:00.000Z" });
    if (kind === "wrongbudget" || kind === "wrongprovider") {
      const different = await prepareProposeRequest({ ...options,
        ...(kind === "wrongbudget" ? { budget: { ...budget, reservation_microusd: 59 } } : { model: providers.find(p => p.provider !== provider.provider)! }),
      });
      options.approvalPath = await approval(different.requestDigest);
    }
    const read = watchCredentials();
    await expect(runPropose(options)).rejects.toMatchObject({ code: kind === "missing" ? "FILE_READ_FAILED" : "APPROVAL_DENIED" });
    expect(read).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    await expect(readdir(options.budgetStore)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(options.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enforces the durable provider cap across different approved digests", async () => {
    const { options } = await setup(provider);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(wire(provider.provider))));
    vi.stubGlobal("fetch", fetchMock);
    await runPropose(options);
    const next = { ...options, budget: { ...budget, reservation_microusd: 50 }, outputPath: join(root, "next.json") };
    const prepared = await prepareProposeRequest(next);
    next.approvalPath = await approval(prepared.requestDigest);
    const before = await ledger(provider.provider);
    const read = watchCredentials();
    await expect(runPropose(next)).rejects.toMatchObject({ code: "PROPOSE_BUDGET_EXCEEDED" });
    expect(read).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await ledger(provider.provider)).toEqual(before);
  });

  it.each(["failed", "truncated", "malformed", "timeout"])("keeps reservation after %s reply and never retries the same digest", async (failure) => {
    const { prepared, options } = await setup(provider);
    const fetchMock = vi.fn(async () => {
      if (failure === "failed") return new Response("unavailable", { status: 503 });
      if (failure === "timeout") {
        return new Promise<Response>(() => {});
      }
      return new Response(JSON.stringify(wire(provider.provider, failure === "malformed" ? "not json" : reply, failure === "truncated")));
    });
    // Fire only the transport deadline immediately, without delaying filesystem setup.
    const timer = failure === "timeout" ? vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      queueMicrotask(callback);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout) : undefined;
    vi.stubGlobal("fetch", fetchMock);
    await expect(runPropose(options)).rejects.toMatchObject({ code: failure === "failed" ? "PROPOSE_HTTP_ERROR" : failure === "timeout" ? "PROPOSE_TIMEOUT" : "PROPOSE_REPLY_INVALID" });
    if (failure === "timeout") {
      expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), TIMEOUT_MS);
      timer!.mockRestore();
    }
    const before = await ledger(provider.provider);
    expect(before).toMatchObject([{ request_digest: prepared.requestDigest, reservation_microusd: budget.reservation_microusd }]);
    await expect(readFile(options.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(runPropose({ ...options, approvalPath: await approval(prepared.requestDigest) })).rejects.toMatchObject({ code: "PROPOSE_REQUEST_ALREADY_RESERVED" });
    expect(await ledger(provider.provider)).toEqual(before);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an existing draft before reserving or sending", async () => {
    const { options } = await setup(provider);
    await writeFile(options.outputPath, "existing draft");
    const read = watchCredentials();
    await expect(runPropose(options)).rejects.toMatchObject({ code: "PROPOSE_OUTPUT_CONFLICT" });
    expect(read).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(await readFile(options.outputPath, "utf8")).toBe("existing draft");
    await expect(readdir(options.budgetStore)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not fall back to another provider key or load a workspace .env", async () => {
    const { options } = await setup(provider);
    vi.stubEnv(provider.key, undefined);
    await writeFile(join(root, ".env"), `${provider.key}=offline-dotenv-key\n`);
    const read = watchCredentials();
    await expect(runPropose({ ...options, workspaceDir: root })).rejects.toMatchObject({ code: "PROPOSE_CREDENTIAL_MISSING" });
    expect(read.mock.calls).toEqual([[provider.key]]);
    expect(fetch).not.toHaveBeenCalled();
    expect(await ledger(provider.provider)).toHaveLength(1);
    await expect(readFile(options.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
