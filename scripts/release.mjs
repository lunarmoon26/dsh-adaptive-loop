import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// Dependency order: publish the entry-point bundle last.
const directories = ["plugins/dal-native-text", ".", ...[
  "dal-run-record", "dal-improve-tools", "dal-hmr-candidate",
  "dal-unknown-effect-guard", "dal-codex-oauth", "dal-modes",
].map((name) => `plugins/${name}`)];
const packages = await Promise.all(directories.map(async (directory) => ({
  directory, ...JSON.parse(await readFile(join(root, directory, "package.json"), "utf8")),
})));
const version = packages[0].version;
const artifacts = join(root, ".dal", "release", version);
const command = process.argv[2];
const run = (file, args, cwd = root) => execFileSync(file, args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000,
});
const integrity = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

function check() {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/);
  if (process.argv[3]) assert.equal(process.argv[3], `v${version}`, "tag must match committed version");
  for (const pkg of packages) {
    assert.equal(pkg.version, version, `${pkg.name}: release versions must match`);
    assert.equal(pkg.repository.url, "git+https://github.com/lunarmoon26/dsh-adaptive-loop.git");
    assert.ok(pkg.files?.length, `${pkg.name}: explicit package allowlist required`);
    for (const [name, dependency] of Object.entries(pkg.dependencies ?? {})) {
      if (name.startsWith("@lunarmoon26/dal")) {
        assert.ok(packages.some((item) => item.name === name), `unknown release dependency ${name}`);
        assert.equal(dependency, version, `${pkg.name}: pin internal dependencies`);
      }
    }
  }
}

async function readArtifacts() {
  const manifest = JSON.parse(await readFile(join(artifacts, "manifest.json"), "utf8"));
  assert.equal(manifest.version, version);
  assert.deepEqual(manifest.packages.map((item) => item.name), packages.map((pkg) => pkg.name));
  for (const item of manifest.packages) {
    assert.match(item.filename, /^[a-z0-9.-]+\.tgz$/);
    assert.equal(integrity(await readFile(join(artifacts, item.filename))), item.integrity);
  }
  return manifest;
}

check();
if (command === "check") {
  console.log(`Release ${version}: ${packages.length} manifests valid`);
} else if (command === "pack") {
  await mkdir(artifacts, { recursive: true });
  const packed = [];
  for (const pkg of packages) {
    const [result] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", artifacts], join(root, pkg.directory)));
    const files = result.files.map((entry) => entry.path);
    assert.ok(!files.some((path) => /(^|\/)(\.env|node_modules|tests|\.dal)(\/|$)/.test(path)));
    for (const required of pkg.directory === "."
      ? ["dist/cli.js", "schemas/feedback-log.v1.schema.json", "docs/deployment/end-task-feedback-global-SKILL.md", "docs/deployment/user-global-AGENTS.md"]
      : pkg.name.endsWith("dal-modes") ? ["cordis.patch.yml"] : ["lib/index.js"]) {
      assert.ok(files.includes(required), `${pkg.name}: missing ${required}`);
    }
    packed.push({ name: pkg.name, filename: result.filename, integrity: integrity(await readFile(join(artifacts, result.filename))) });
  }
  await writeFile(join(artifacts, "manifest.json"), `${JSON.stringify({ version, packages: packed }, null, 2)}\n`);
  console.log(`Packed ${packed.length} artifacts at ${artifacts}`);
} else if (command === "smoke") {
  const manifest = await readArtifacts();
  const temporary = await mkdtemp(join(tmpdir(), "dal-package-smoke-"));
  try {
    await writeFile(join(temporary, "package.json"), JSON.stringify({ private: true, type: "module" }));
    // A disposable consumer install, never a DSH profile or plugin mount.
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false",
      ...manifest.packages.map((item) => join(artifacts, item.filename)),
      "@deepseek-ai/dsh-tools@0.1.1-rc.2"], temporary);
    const cli = join(temporary, "node_modules", ".bin", "dal");
    assert.match(run(cli, ["--help"], temporary), /DSH Adaptive Loop/);
    const workspace = join(temporary, "consumer");
    await mkdir(workspace);
    const initialized = JSON.parse(run(cli, ["init", "--dir", workspace], temporary));
    assert.equal(initialized.status, "initialized");
    assert.ok((await readdir(join(workspace, ".dal"))).includes("runs"));
    const doctor = JSON.parse(run(cli, ["doctor", "--dir", workspace], temporary));
    assert.equal(doctor.scaffold_ready, true);
    assert.equal(doctor.automatic_loop_ready, false);
    // Exercise the packaged comparison core through its public CLI in a workspace
    // with no checkout, using conspicuously synthetic state fixtures.
    const fixtures = join(workspace, ".dal", "check", "release-fixtures");
    await mkdir(fixtures, { recursive: true });
    const fixture = async (name, value) => {
      const bytes = `${JSON.stringify(value)}\n`;
      await writeFile(join(fixtures, `${name}.json`), bytes);
      return { uri: `repo://.dal/check/release-fixtures/${name}.json`, sha256: createHash("sha256").update(bytes).digest("hex") };
    };
    const cases = [];
    for (const role of ["development", "qualification"]) {
      cases.push({ id: `case-${role}`, role, task: await fixture(role, {
        $schema: "https://recursive-dev-loop.dev/schemas/workflow-task.v1.schema.json",
        schema_version: "1.0.0", task_id: `task-${role}`, domain: "synthetic",
        instruction: "Complete the synthetic example", initial_state: { done: false }, goal_state: { done: true },
        policy_ref: "repo://synthetic-policy", effect_requirements: { required: [], forbidden: [] },
      }) });
    }
    const baselineState = await fixture("baseline-state", { done: false });
    const candidateState = await fixture("candidate-state", { done: true });
    const generation = async (id, state, hypothesis) => ({
      id, hypothesis_id: hypothesis, artifact: await fixture(`${id}-artifact`, { fixture: id }),
      results: cases.map((item) => ({ case_id: item.id, state, effects: null })),
    });
    const planPath = join(fixtures, "plan.json");
    await writeFile(planPath, JSON.stringify({
      $schema: "https://recursive-dev-loop.dev/schemas/campaign-replay.v1.schema.json", schema_version: "1.0.0",
      campaign_id: "release-smoke", mode: "replay", goal: "Verify packaged deterministic comparison",
      runtime: { provider: "dsh-codex", model: "synthetic", generation_sha256: "a".repeat(64) },
      grader_version: "2.0.0", budget: { max_candidates: 1, max_evaluations: 4 }, minimum_gain: 0.5,
      hypotheses: [{ id: "hypothesis-completion", gap: "Incomplete output", proxy: "Completion", mechanism: "Completion check", surface: "skills", evidence: [baselineState] }],
      cases, baseline: await generation("baseline", baselineState, null),
      candidates: [await generation("candidate", candidateState, "hypothesis-completion")],
    }));
    run(cli, ["campaign", "prepare", "--plan", planPath], workspace);
    const replay = JSON.parse(run(cli, ["campaign", "replay", "--campaign", "release-smoke"], workspace));
    assert.equal(replay.status, "complete");
    assert.equal(replay.simulated_retained, "candidate");
    assert.equal(replay.retained_generation, "baseline");
    assert.equal(replay.activation_authorized, false);
    assert.deepEqual(JSON.parse(run(cli, ["campaign", "status", "--campaign", "release-smoke"], workspace)), replay);
    const probe = `
      import assert from 'node:assert/strict';
      import { userGlobalInstallScopeDigest } from '@lunarmoon26/dal/install';
      import { defaultCli } from '@lunarmoon26/dal-improve-tools';
      import { existsSync } from 'node:fs';
      assert.match(await userGlobalInstallScopeDigest(), /^[a-f0-9]{64}$/);
      assert.ok(existsSync(defaultCli()[1]));
      for (const name of ${JSON.stringify(packages.filter((pkg) => pkg.directory !== "." && !pkg.name.endsWith("dal-modes")).map((pkg) => pkg.name))}) {
        await import(name);
      }
    `;
    run(process.execPath, ["--input-type=module", "-e", probe], temporary);
    console.log("Clean consumer smoke passed: executable CLI, schemas, templates, plugin imports, packaged CLI resolution and complete campaign replay; no DSH mount or model call");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
} else if (command === "publish") {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "publish runs in the trusted workflow");
  assert.ok(process.env.ACTIONS_ID_TOKEN_REQUEST_URL, "OIDC permission required");
  assert.ok(!process.env.NPM_TOKEN && !process.env.NODE_AUTH_TOKEN, "release must not use an npm token");
  const manifest = await readArtifacts();
  for (const item of manifest.packages) {
    // An existing version is never silently skipped: npm rejects immutable-version
    // conflicts. A partial release needs operator reconciliation, not an overwrite.
    process.stdout.write(run("npm", ["publish", join(artifacts, item.filename), "--access", "public",
      "--tag", version.includes("-") ? "next" : "latest"]));
  }
} else {
  throw new Error("Usage: node scripts/release.mjs check [tag] | pack | smoke | publish");
}
