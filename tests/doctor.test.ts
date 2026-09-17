import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { doctorWorkspace } from "../src/doctor.js";
import { initWorkspace } from "../src/init.js";

describe("onboarding diagnostics", () => {
  it("distinguishes missing scaffolding from an installed but unverified loop", async () => {
    const root = await mkdtemp(join(tmpdir(), "dal-doctor-"));
    expect((await doctorWorkspace(root)).scaffold_ready).toBe(false);
    await initWorkspace({ dir: root });
    const report = await doctorWorkspace(root);
    expect(report.scaffold_ready).toBe(true);
    expect(report.automatic_loop_ready).toBe(false);
    expect(report.subscription_auth).toBe("not_probed");
    expect(report.recording.valid_final_records).toBe(0);
    expect(report.packaged_assets.install_scope_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("setup preserves user instructions and doctor reports malformed evidence without its contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "dal-doctor-"));
    await writeFile(join(root, "AGENTS.md"), "Existing project policy");
    const output: string[] = [];
    expect(await runCli(["setup", "--dir", root], { stdout: (text) => output.push(text), stderr: () => {} })).toBe(0);
    expect(JSON.parse(output.join("")).setup.skipped).toContain("AGENTS.md");
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("Existing project policy");
    await writeFile(join(root, ".dal/runs/invalid.json"), '{"private":"do-not-echo"}');
    const report = await doctorWorkspace(root);
    expect(report.recording.invalid_records).toBe(1);
    expect(JSON.stringify(report)).not.toContain("do-not-echo");
  });
});
