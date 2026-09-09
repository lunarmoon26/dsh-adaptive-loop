import { Ajv2020 } from "ajv/dist/2020.js";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../src/json.js";
import { PROPOSAL_BUDGET_SCHEMA, reserveProposalBudget } from "../src/proposal-budget.js";

let root: string;
let store: string;
const budget = { budget_id: "budget-test", provider_limit_microusd: 10, reservation_microusd: 4 };
const request = (overrides: Partial<Parameters<typeof reserveProposalBudget>[0]> = {}) => ({
  store, budget: { ...budget }, provider: "openai", requestDigest: sha256("request"), approvalId: "dec-approved", ...overrides,
});
const directory = () => join(store, budget.budget_id, "openai");
const reserveNext = () => reserveProposalBudget(request({ requestDigest: sha256("next") }));
const validate = new Ajv2020({ strict: true }).compile(JSON.parse(await readFile(
  new URL("../schemas/proposal-budget.v1.schema.json", import.meta.url), "utf8")));

beforeEach(async () => {
  // macOS /var is a symlink; use a real absolute test root to exercise strict ancestry.
  root = await mkdtemp(join(await realpath(tmpdir()), "dal-proposal-budget-"));
  store = join(root, "budgets");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("chg-dal-multiprovider-proposals-20260907 local reservation ledger", () => {
  it("persists canonical schema-valid records with no payload or credentials", async () => {
    const result = await reserveProposalBudget(request());
    expect(result).toMatchObject({ reserved_microusd: 4, remaining_microusd: 6 });
    expect(result.reservation.$schema).toBe(PROPOSAL_BUDGET_SCHEMA);
    expect(validate(result.reservation)).toBe(true);
    expect(await readFile(result.path, "utf8")).toBe(`${canonicalJson(result.reservation)}\n`);
    expect(validate(JSON.parse(await readFile(join(directory(), "cap.json"), "utf8")))).toBe(true);
    for (const field of ["payload", "api_key", "body", "credential_env"]) {
      expect(validate({ ...result.reservation, [field]: "not-stored" })).toBe(false);
    }
    expect((await reserveNext()).reserved_microusd).toBe(8);
    await expect(reserveProposalBudget(request({ requestDigest: sha256("third") })))
      .rejects.toMatchObject({ code: "PROPOSE_BUDGET_EXCEEDED" });
  });

  it("serializes concurrent requests without overspending or waiting", async () => {
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => reserveProposalBudget(request({
      requestDigest: sha256(String(i)), budget: { ...budget, reservation_microusd: 6 },
    }))));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    for (const result of results) if (result.status === "rejected") {
      expect(["PROPOSE_BUDGET_BUSY", "PROPOSE_BUDGET_EXCEEDED"]).toContain(result.reason.code);
    }
    expect(await readdir(join(directory(), "reservations"))).toHaveLength(1);
  });

  it("isolates all three providers and independent budget IDs", async () => {
    for (const provider of ["openai", "anthropic", "deepseek-official"]) {
      expect((await reserveProposalBudget(request({ provider }))).reserved_microusd).toBe(4);
    }
    expect((await reserveProposalBudget(request({ budget: { ...budget, budget_id: "another" } }))).reserved_microusd).toBe(4);
  });

  it.each(["dec-approved", "dec-different"])("never reauthorizes the same digest with approval %s", async approvalId => {
    await reserveProposalBudget(request());
    await expect(reserveProposalBudget(request({ approvalId }))).rejects.toMatchObject({ code: "PROPOSE_REQUEST_ALREADY_RESERVED" });
  });

  it("rejects cap drift without altering the ledger", async () => {
    const first = await reserveProposalBudget(request());
    await expect(reserveProposalBudget(request({ budget: { ...budget, provider_limit_microusd: 20 } })))
      .rejects.toMatchObject({ code: "PROPOSE_BUDGET_CAP_DRIFT" });
    expect(await readFile(first.path, "utf8")).toBe(`${canonicalJson(first.reservation)}\n`);
  });

  it.each(["failure", "timeout", "cancellation", "lost-result"])("retains reservations after downstream %s", async outcome => {
    await expect((async () => {
      await reserveProposalBudget(request());
      throw new Error(outcome);
    })()).rejects.toThrow(outcome);
    await expect(reserveProposalBudget(request())).rejects.toMatchObject({ code: "PROPOSE_REQUEST_ALREADY_RESERVED" });
    expect((await reserveNext()).reserved_microusd).toBe(8);
  });

  it("does not reclaim an abandoned lock or initialize its ledger", async () => {
    await mkdir(join(store, budget.budget_id, "openai.lock"), { recursive: true });
    await expect(reserveProposalBudget(request())).rejects.toMatchObject({ code: "PROPOSE_BUDGET_BUSY" });
    expect(await readdir(join(store, budget.budget_id))).toEqual(["openai.lock"]);
  });

  it.each(["store", "ancestor", "provider", "reservations", "record"])("rejects a symlink at %s", async location => {
    const target = join(root, "target");
    await mkdir(target);
    if (location === "store") await symlink(target, store);
    if (location === "ancestor") {
      await symlink(target, join(root, "alias"));
      store = join(root, "alias", "nested", "budgets");
    }
    if (location === "provider") {
      await mkdir(join(store, budget.budget_id), { recursive: true });
      await symlink(target, directory());
    }
    if (location === "reservations" || location === "record") {
      const first = await reserveProposalBudget(request());
      const path = location === "record" ? first.path : join(directory(), "reservations");
      await rm(path, { recursive: true });
      await symlink(target, path);
    }
    await expect(reserveNext()).rejects.toMatchObject({ code: "PROPOSE_BUDGET_CORRUPT" });
    expect(await readdir(target)).toEqual([]);
  });

  it.each(["cap", "ledger", "truncated", "digest", "tampered", "unknown", "gap", "empty-provider"])("fails closed on %s corruption", async kind => {
    const first = await reserveProposalBudget(request());
    if (kind === "cap") await rm(join(directory(), "cap.json"));
    if (kind === "ledger") await rm(join(directory(), "reservations"), { recursive: true });
    if (kind === "truncated") await writeFile(first.path, '{"kind":');
    if (kind === "digest") await writeFile(first.path, `${canonicalJson({ ...first.reservation, request_digest: "bad" })}\n`);
    if (kind === "tampered") await writeFile(first.path, `${canonicalJson({ ...first.reservation, reservation_microusd: 1 })}\n`);
    if (kind === "unknown") await writeFile(join(directory(), "reservations", "unknown.json"), "{}");
    if (kind === "gap") { await reserveNext(); await rm(first.path); }
    if (kind === "empty-provider") {
      await rm(directory(), { recursive: true });
      await mkdir(directory());
    }
    await expect(reserveProposalBudget(request({ requestDigest: sha256("new") })))
      .rejects.toMatchObject({ code: "PROPOSE_BUDGET_CORRUPT" });
  });

  it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "4", null, true])("rejects unsafe numeric input %s", async value => {
    for (const field of ["reservation_microusd", "provider_limit_microusd"]) {
      await expect(reserveProposalBudget(request({ budget: { ...budget, [field]: value } as typeof budget })))
        .rejects.toMatchObject({ code: "PROPOSE_BUDGET_INVALID" });
    }
    expect(await readdir(root)).toEqual([]);
  });

  it("handles the safe integer boundary without overflow", async () => {
    const huge = { ...budget, provider_limit_microusd: Number.MAX_SAFE_INTEGER, reservation_microusd: Number.MAX_SAFE_INTEGER - 1 };
    await reserveProposalBudget(request({ budget: huge }));
    await expect(reserveProposalBudget(request({ budget: { ...huge, reservation_microusd: 2 }, requestDigest: sha256("two") })))
      .rejects.toMatchObject({ code: "PROPOSE_BUDGET_EXCEEDED" });
    expect((await reserveProposalBudget(request({ budget: { ...huge, reservation_microusd: 1 }, requestDigest: sha256("one") })))
      .remaining_microusd).toBe(0);
  });

  it.each([
    { provider: "unknown" }, { requestDigest: "A".repeat(64) }, { requestDigest: "../request" },
    { requestDigest: `${sha256("request")}\n` }, { approvalId: "dec-approved\n" },
    { approvalId: "../approval" }, { store: "relative" },
    { budget: { ...budget, budget_id: "../escape" } },
    { budget: { ...budget, budget_id: "budget-test\n" } },
    { budget: { ...budget, reservation_microusd: 11 } },
  ])("rejects invalid identity or scope %j", async overrides => {
    await expect(reserveProposalBudget(request(overrides))).rejects.toMatchObject({ code: "PROPOSE_BUDGET_INVALID" });
    expect(await readdir(root)).toEqual([]);
  });
});
