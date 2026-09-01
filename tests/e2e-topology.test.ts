import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertTransmissionManifestCurrent,
  renderedCompositionPatch,
  transmissionManifest,
} from "../benchmarks/tau-style-workflow/run-e2e.js";
import {
  SERVICE_ALIAS,
  SERVICE_URL,
  candidateDockerArgv,
  graderDockerArgv,
  serviceDockerArgv,
  stageCandidateWorkspace,
  topologyFor,
} from "../benchmarks/tau-style-workflow/e2e-topology.js";
import { initializeService } from "../benchmarks/tau-style-workflow/.dsh/plugins/dal-workflow-tools/src/service.js";
import { canonicalJson, sha256 } from "../src/json.js";

const repoRoot = join(import.meta.dirname, "..");
const benchmarkImage = "dsh-adaptive-loop/dsh:0.1.1-rc.2-benchmark-v2";

async function filesUnder(root: string, relativeRoot = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, relativeRoot), { withFileTypes: true })) {
    const relativePath = join(relativeRoot, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, relativePath));
    else files.push(relativePath);
  }
  return files.sort();
}

describe("tau-style three-container topology", () => {
  it("stages only agent-visible inputs and the exact stable composition patch", async () => {
    const root = await mkdtemp(join(tmpdir(), "dal-e2e-stage-"));
    const stageRoot = join(root, "stage");
    const skillPath = join(root, "SKILL.md");
    const policyPath = join(root, "policy.md");
    const args = new Map([
      ["provider", "deepseek-official"],
      ["model", "deepseek-v4-flash"],
      ["faults", "issue_refund=unknown"],
      ["batch", "g1"],
    ]);
    const patch = renderedCompositionPatch(args);
    await writeFile(skillPath, "# Safe skill\n", "utf8");
    await writeFile(policyPath, "# Safe policy\n", "utf8");
    await stageCandidateWorkspace({
      stageRoot,
      taskId: "task.json",
      agentTask: { task_id: "task-1", instruction: "work", initial_state: {} },
      compositionPatch: patch,
      skillPath,
      policyPath,
    });

    expect(await filesUnder(stageRoot)).toEqual([
      ".agents/skills/refund-workflow/SKILL.md",
      ".dal/benchmark/e2e/agent-task-task.json.json",
      ".dal/benchmark/e2e/model-patch.yml",
      "tasks/policy.md",
    ]);
    const stagedTask = await readFile(join(stageRoot, ".dal", "benchmark", "e2e", "agent-task-task.json.json"), "utf8");
    expect(stagedTask).not.toContain("goal_state");
    expect(await readFile(join(stageRoot, ".dal", "benchmark", "e2e", "model-patch.yml"), "utf8")).toBe(patch);
    expect(patch).toContain(`serviceUrl: ${SERVICE_URL}`);
    expect(renderedCompositionPatch(new Map([
      ["provider", "deepseek-official"],
      ["model", "deepseek-v4-flash"],
      ["batch", "another-root"],
    ]))).toBe(patch);
    const fakeBin = join(root, "bin");
    const fakeDocker = join(fakeBin, "docker");
    await mkdir(fakeBin, { recursive: true });
    await writeFile(fakeDocker, `#!/bin/sh
if [ "$1" = "image" ]; then
  printf '%s\\n' 'sha256:${"a".repeat(64)}'
else
  printf '%s\\n' '${"b".repeat(64)}  -'
fi
`, "utf8");
    await chmod(fakeDocker, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
    try {
      const manifestArgs = new Map([["tasks", "task-001-refund.json"]]);
      const manifest = await transmissionManifest(manifestArgs);
      expect(manifest.rendered_composition_patch).toBe(renderedCompositionPatch(new Map()));
      expect(manifest.evaluator_tasks).toEqual([{ task_id: "task-001-refund.json", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
      expect(manifest.attempts_per_task).toBe(1);
      expect(manifest.benchmark_context_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(manifest.container_image_sha256).toMatch(/^[0-9a-f]{64}$/);
      const driftedArgs = new Map(manifestArgs);
      driftedArgs.set("attempts", "2");
      await expect(assertTransmissionManifestCurrent(
        driftedArgs,
        manifest.container_image_sha256!,
        sha256(canonicalJson(manifest)),
      )).rejects.toThrow("Transmission manifest drifted after approval");
      await expect(transmissionManifest(new Map([["generation", "g2"]]))).rejects.toThrow("source-only");
      await expect(transmissionManifest(new Map([["generation", "other"]]))).rejects.toThrow("must be g0 or g1");
      await expect(transmissionManifest(new Map([["tasks", "missing-task.json"]]))).rejects.toThrow("unknown: missing-task.json");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps candidate, service state, and grader oracle on separate mounts and networks", () => {
    const topology = topologyFor("batch-task-attempt");
    const candidate = candidateDockerArgv({
      image: "image",
      topology,
      stageRoot: "/host/stage",
      dshHomeHost: "/host/home",
      keyEnv: "DEEPSEEK_API_KEY",
      prompt: "work",
    });
    const service = serviceDockerArgv({ image: "image", topology, stateRootHost: "/host/state" });
    const grader = graderDockerArgv({ image: "image", topology, taskPath: "/host/oracle/task.json" });

    expect(topology.candidateNetwork).not.toBe(topology.graderNetwork);
    expect(candidate).toContain(topology.candidateNetwork);
    expect(candidate).toContain("type=bind,src=/host/stage,dst=/workspace,readonly");
    expect(candidate.join(" ")).not.toContain("/host/state");
    expect(candidate.join(" ")).not.toContain("/host/oracle");
    expect(service).toContain(topology.candidateNetwork);
    expect(service).toContain(SERVICE_ALIAS);
    expect(service).toContain("type=bind,src=/host/state,dst=/service-state");
    expect(grader).toContain(topology.graderNetwork);
    expect(grader).toContain("type=bind,src=/host/oracle/task.json,dst=/oracle/task.json,readonly");
    expect(grader.join(" ")).not.toContain("/host/stage");
    expect(grader.join(" ")).not.toContain("/host/state");
  });
});

describe.skipIf(process.env.DAL_E2E_TOPOLOGY_PROBE !== "1")("live tau-style container topology", () => {
  it("runs the typed service and isolated remote grader without mounting the repository into either principal", async () => {
    const probeRoot = join(repoRoot, ".dal", "check");
    await mkdir(probeRoot, { recursive: true });
    const stateRoot = await mkdtemp(join(probeRoot, "topology-probe-"));
    await initializeService({ stateRoot, faults: {} }, {
      orders: { "o-1001": { status: "delivered", total: 120, days_since_delivery: 12, items: ["sku-a", "sku-b"] } },
      refunds: [],
      labels: [],
      bookings: {},
    });
    const topology = topologyFor(`probe-${randomUUID().slice(0, 8)}`);
    const token = "topology-probe-evaluator-token-32-chars";
    const run = (argv: string[], env: NodeJS.ProcessEnv = process.env): string => {
      const result = spawnSync("docker", argv, { encoding: "utf8", timeout: 120_000, env });
      if (result.error !== undefined || result.status !== 0) {
        throw new Error(result.error?.message ?? String(result.stderr));
      }
      return result.stdout.trim();
    };
    try {
      run(["network", "create", topology.candidateNetwork]);
      run(["network", "create", "--internal", topology.graderNetwork]);
      run(serviceDockerArgv({ image: benchmarkImage, topology, stateRootHost: stateRoot }), {
        ...process.env,
        DAL_SERVICE_FAULTS: "{}",
        DAL_SERVICE_RESOLUTIONS: "{}",
        DAL_EVALUATOR_TOKEN: token,
      });
      run(["network", "connect", "--alias", SERVICE_ALIAS, topology.graderNetwork, topology.serviceContainer]);

      const operate = `const p=(path,body)=>fetch('${SERVICE_URL}/v1/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(async r=>{if(!r.ok)throw new Error(await r.text());return r.json()});(async()=>{await p('create_return_label',{order_id:'o-1001',idempotency_key:'label-1'});await p('issue_refund',{order_id:'o-1001',amount:120,reason:'damaged',idempotency_key:'refund-1'})})().catch(e=>{console.error(e);process.exit(1)})`;
      let operated = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const result = spawnSync("docker", ["run", "--rm", "--network", topology.candidateNetwork, benchmarkImage, "node", "-e", operate], {
          encoding: "utf8",
          timeout: 30_000,
        });
        if (result.status === 0) {
          operated = true;
          break;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
      expect(operated).toBe(true);

      const graded = JSON.parse(run(
        graderDockerArgv({
          image: benchmarkImage,
          topology,
          taskPath: join(repoRoot, "benchmarks", "tau-style-workflow", "tasks", "task-001-refund.json"),
        }),
        { ...process.env, DAL_EVALUATOR_TOKEN: token },
      )) as { verdict: { pass: boolean }; journal_sha256: string };
      expect(graded.verdict.pass).toBe(true);
      expect(graded.journal_sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      for (const container of [topology.candidateContainer, topology.graderContainer, topology.serviceContainer]) {
        spawnSync("docker", ["rm", "-f", container], { encoding: "utf8", timeout: 30_000 });
      }
      for (const network of [topology.candidateNetwork, topology.graderNetwork]) {
        spawnSync("docker", ["network", "rm", network], { encoding: "utf8", timeout: 30_000 });
      }
    }
  });
});
