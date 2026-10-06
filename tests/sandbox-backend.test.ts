import { beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxUnavailableError } from "@deepseek-ai/dsh-sandbox";
import type { SandboxProvider } from "@deepseek-ai/dsh-sandbox";
import { confineWithProvider } from "../src/sandbox-backend.js";

const providerConfine = vi.fn<SandboxProvider["confine"]>();
const confine = (argv: string[], policy: Parameters<SandboxProvider["confine"]>[1]) => confineWithProvider({ confine: providerConfine }, argv, policy);
beforeEach(() => providerConfine.mockReset());
describe("DSH asynchronous sandbox adapter", () => {
  const policy = { mode: "read-only" as const, workspaceRoot: "/synthetic" };
  it("awaits the provider's confinement and preserves evidence", async () => {
    providerConfine.mockResolvedValue({ argv: ["/synthetic/runner", "cmd"], enforcement: "partial",
      denialSignatures: ["synthetic denial"], runnerFailureRules: [{ fatalSignatures: ["synthetic failure"] }] });
    expect(await confine(["cmd"], policy)).toEqual({ argv: ["/synthetic/runner", "cmd"], backend: "runner", enforcement: "partial",
      denialSignatures: ["synthetic denial"], runnerFailureRules: [{ fatalSignatures: ["synthetic failure"] }] });
    expect(providerConfine).toHaveBeenCalledWith(["cmd"], policy);
  });
  it("maps asynchronous unavailable rejection without falling through unconfined", async () => {
    const provider = { async confine() { throw new SandboxUnavailableError("read-only", "synthetic backend absent"); } };
    await expect(confineWithProvider(provider, ["cmd"], policy)).rejects.toMatchObject({ code: "SANDBOX_UNAVAILABLE" });
  });
  it("rejects empty enforcing argv and preserves unexpected asynchronous failures", async () => {
    providerConfine.mockResolvedValue({ argv: [], enforcement: "full", denialSignatures: [], runnerFailureRules: [] });
    await expect(confine(["cmd"], policy)).rejects.toMatchObject({ code: "SANDBOX_UNAVAILABLE" });
    const error = new Error("synthetic backend error");
    await expect(confineWithProvider({ async confine() { throw error; } }, ["cmd"], policy)).rejects.toBe(error);
  });
});
