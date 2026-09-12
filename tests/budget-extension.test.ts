import { Ajv2020 } from "ajv/dist/2020.js";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as approval from "../src/approval.js";
import { canonicalJson, sha256 } from "../src/json.js";
import { extendProposalBudget, prepareBudgetExtension, readProposalBudgetSnapshot, reserveProposalBudget } from "../src/proposal-budget.js";
import { startGateway, type E2eSpendPolicy } from "../src/e2e-model-gateway.js";

let root: string;
let store: string;
const budgetId = "budget-extension-test";
const provider = "openai";
const identity = () => ({ store, budgetId, provider });
const input = (newLimit = 20) => ({ ...identity(), newLimit });
const directory = () => join(store, budgetId, provider);
const reserve = (id = "initial", cap = 10, amount = 4) => reserveProposalBudget({ store, provider,
  budget: { budget_id: budgetId, provider_limit_microusd: cap, reservation_microusd: amount },
  requestDigest: sha256(id), approvalId: "dec-test-reservation" });
const schema = JSON.parse(await readFile(new URL("../schemas/proposal-budget.v1.schema.json", import.meta.url), "utf8"));
const validate = new Ajv2020({ strict: true }).compile(schema);
const legacyValidate = new Ajv2020({ strict: true }).compile({ ...schema.anyOf[0], $defs: schema.$defs });

async function approve(scope: string, overrides: Record<string, unknown> = {}) {
  const path = join(root, "approval.json");
  await writeFile(path, JSON.stringify({
    $schema: "https://recursive-dev-loop.dev/schemas/approval-decision.v1.schema.json", schema_version: "1.0.0",
    decision_id: "dec-test-extension", request_id: "req-test-extension", action: "send_data_externally",
    scope: { kind: "data_transfer", value: scope, sha256: sha256(scope) }, decision: "approved",
    reviewer: { kind: "human", id: "test-reviewer" }, decided_at: "2020-01-01T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z", rationale: "Offline test only", evidence: ["repo://tests/budget-extension.test.ts"],
    candidate_sha256: null, ...overrides,
  }));
  return path;
}

async function bytes(): Promise<Record<string, string>> {
  const names = (await readdir(join(directory(), "reservations"))).sort();
  return Object.fromEntries(await Promise.all(["cap.json", ...names.map(n => `reservations/${n}`)]
    .map(async name => [name, await readFile(join(directory(), name), "utf8")])));
}

beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "dal-budget-extension-"));
  store = join(root, "budgets");
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("chg-budget-cap-extension-20260911", () => {
  it("prepares an immutable exact scope without writing or initializing", async () => {
    await expect(prepareBudgetExtension(input())).rejects.toMatchObject({ code: "PROPOSE_BUDGET_CORRUPT" });
    expect(await readdir(root)).toEqual([]);
    await reserve();
    const before = await bytes();
    const prepared = await prepareBudgetExtension(input());
    expect(prepared.request).toEqual({ kind: "budget_cap_extension_request", schema_version: "1.0.0",
      budget_id: budgetId, provider, old_limit_microusd: 10, new_limit_microusd: 20,
      head_sha256: prepared.head_sha256, sequence: 1, reserved_microusd: 4 });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.request)).toBe(true);
    expect(prepared.requestDigest).toBe(sha256(canonicalJson(prepared.request)));
    expect(prepared.scope).toBe(`proposal-budget-extension:v1:${prepared.requestDigest}`);
    expect((await prepareBudgetExtension(input(21))).requestDigest).not.toBe(prepared.requestDigest);
    expect(await bytes()).toEqual(before);
  });

  it.each(["missing", "wrong-scope", "send-digest", "wrong-action", "rejected", "expired", "future", "stale-head", "wrong-limit"])("denies %s approval without ledger writes", async kind => {
    await reserve();
    const prepared = await prepareBudgetExtension(input());
    const overrides = kind === "expired" ? { expires_at: "2021-01-01T00:00:00Z" } :
      kind === "future" ? { decided_at: "2098-01-01T00:00:00Z" } :
      kind === "rejected" ? { decision: "rejected" } : kind === "wrong-action" ? { action: "install_or_mount_plugin",
        scope: { kind: "plugin", value: prepared.scope, sha256: sha256(prepared.scope) } } : {};
    const scope = kind === "wrong-scope" ? "another-extension" : kind === "send-digest" ? prepared.requestDigest : prepared.scope;
    const approvalPath = kind === "missing" ? join(root, "missing.json") : await approve(scope, overrides);
    if (kind === "stale-head") await reserve("later");
    const before = await bytes();
    const attempt = extendProposalBudget({ ...input(kind === "wrong-limit" ? 21 : 20), approvalPath });
    if (kind === "missing") await expect(attempt).rejects.toThrow();
    else await expect(attempt).rejects.toMatchObject({ code: "APPROVAL_DENIED" });
    expect(await bytes()).toEqual(before);
    expect(await readdir(join(store, budgetId))).toEqual([provider]);
  });

  it("preserves historical bytes, appends zero spend, enforces the new cap and fails closed for old readers", async () => {
    await reserve();
    const before = await bytes();
    const prepared = await prepareBudgetExtension(input());
    const receipt = await extendProposalBudget({ ...input(), approvalPath: await approve(prepared.scope) });
    expect(receipt).toMatchObject({ reserved_microusd: 4, remaining_microusd: 16, provider_limit_microusd: 20, sequence: 2 });
    expect(receipt.extension).toMatchObject({ kind: "cap_extension", reservation_microusd: 0, previous_sha256: prepared.head_sha256 });
    expect(validate(receipt.extension)).toBe(true);
    expect(legacyValidate(receipt.extension)).toBe(false);
    for (const raw of Object.values(before)) expect(legacyValidate(JSON.parse(raw))).toBe(true);
    expect(await bytes()).toMatchObject(before);
    await expect(reserve("old-cap")).rejects.toMatchObject({ code: "PROPOSE_BUDGET_CAP_DRIFT" });
    await expect(reserve("unapproved-cap", 21)).rejects.toMatchObject({ code: "PROPOSE_BUDGET_CAP_DRIFT" });
    await expect(reserve("initial", 20)).rejects.toMatchObject({ code: "PROPOSE_REQUEST_ALREADY_RESERVED" });
    await expect(reserveProposalBudget({ store, provider, budget: { budget_id: budgetId, provider_limit_microusd: 20, reservation_microusd: 1 },
      requestDigest: receipt.requestDigest, approvalId: "dec-test-reservation" })).rejects.toMatchObject({ code: "PROPOSE_REQUEST_ALREADY_RESERVED" });
    expect((await reserve("fill", 20, 16)).remaining_microusd).toBe(0);
    await expect(reserve("over", 20, 1)).rejects.toMatchObject({ code: "PROPOSE_BUDGET_EXCEEDED" });
    const next = await prepareBudgetExtension(input(30));
    await extendProposalBudget({ ...input(30), approvalPath: await approve(next.scope) });
    expect(await readProposalBudgetSnapshot(identity())).toMatchObject({ reservations: 2, sequence: 4, reserved_microusd: 20, remaining_microusd: 10 });
    expect(await bytes()).toMatchObject(before);
  });

  it.each([0, -1, 10, 9, 20.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])("rejects unsafe or nonincreasing limit %s", async newLimit => {
    await reserve();
    const before = await bytes();
    await expect(prepareBudgetExtension(input(newLimit))).rejects.toMatchObject({ code: "PROPOSE_BUDGET_INVALID" });
    expect(await bytes()).toEqual(before);
  });

  it("supports the maximum safe cumulative limit without overflow", async () => {
    await reserve();
    const args = input(Number.MAX_SAFE_INTEGER);
    const prepared = await prepareBudgetExtension(args);
    await extendProposalBudget({ ...args, approvalPath: await approve(prepared.scope) });
    expect((await reserve("fill", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 4)).remaining_microusd).toBe(0);
    await expect(reserve("over", Number.MAX_SAFE_INTEGER, 1)).rejects.toMatchObject({ code: "PROPOSE_BUDGET_EXCEEDED" });
  });

  it("rechecks the exact head under lock when a reservation wins after approval", async () => {
    await reserve();
    const prepared = await prepareBudgetExtension(input());
    const approvalPath = await approve(prepared.scope);
    const verify = approval.verifyApprovalFile;
    vi.spyOn(approval, "verifyApprovalFile").mockImplementationOnce(async (...args) => {
      const decision = await verify(...args);
      await reserve("racing-reservation");
      return decision;
    });
    await expect(extendProposalBudget({ ...input(), approvalPath })).rejects.toMatchObject({ code: "PROPOSE_BUDGET_STALE_HEAD" });
    expect(await readProposalBudgetSnapshot(identity())).toMatchObject({ sequence: 2, reservations: 2, provider_limit_microusd: 10, reserved_microusd: 8 });
  });

  it("denies concurrent lock ownership without reclaiming it", async () => {
    await reserve();
    const prepared = await prepareBudgetExtension(input());
    const approvalPath = await approve(prepared.scope);
    const before = await bytes();
    const verify = approval.verifyApprovalFile;
    vi.spyOn(approval, "verifyApprovalFile").mockImplementationOnce(async (...args) => {
      const decision = await verify(...args);
      await mkdir(`${directory()}.lock`);
      return decision;
    });
    await expect(extendProposalBudget({ ...input(), approvalPath })).rejects.toMatchObject({ code: "PROPOSE_BUDGET_BUSY" });
    await expect(reserve("concurrent")).rejects.toMatchObject({ code: "PROPOSE_BUDGET_BUSY" });
    await expect(prepareBudgetExtension(input())).rejects.toMatchObject({ code: "PROPOSE_BUDGET_BUSY" });
    expect(await bytes()).toEqual(before);
    expect(await readdir(join(store, budgetId))).toContain(`${provider}.lock`);
  });

  it("rechecks approval expiry immediately before publication", async () => {
    await reserve();
    const prepared = await prepareBudgetExtension(input());
    const approvalPath = await approve(prepared.scope);
    const before = await bytes();
    const verify = approval.verifyApprovalFile;
    vi.spyOn(approval, "verifyApprovalFile").mockImplementationOnce(async (...args) => {
      const decision = await verify(...args);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
      return decision;
    });
    await expect(extendProposalBudget({ ...input(), approvalPath })).rejects.toMatchObject({ code: "APPROVAL_DENIED" });
    expect(await bytes()).toEqual(before);
    expect(await readdir(join(store, budgetId))).toEqual([provider]);
  });

  it("does not let caller mutation change the approved extension while awaiting verification", async () => {
    await reserve();
    const prepared = await prepareBudgetExtension(input());
    const args = { ...input(), approvalPath: await approve(prepared.scope) };
    const verify = approval.verifyApprovalFile;
    vi.spyOn(approval, "verifyApprovalFile").mockImplementationOnce(async (...params) => {
      const decision = await verify(...params);
      args.newLimit = 30;
      return decision;
    });
    expect((await extendProposalBudget(args)).provider_limit_microusd).toBe(20);
  });

  it.each(["old-limit", "nonincrease", "total", "spend", "request", "head", "sequence", "unknown-kind", "zero-reservation", "duplicate", "retroactive-cap"])("rejects rehashed %s corruption", async kind => {
    const first = await reserve();
    const prepared = await prepareBudgetExtension(input());
    const receipt = await extendProposalBudget({ ...input(), approvalPath: await approve(prepared.scope) });
    const record: Record<string, unknown> = { ...receipt.extension };
    if (kind === "old-limit") record.old_limit_microusd = 9;
    if (kind === "nonincrease") record.provider_limit_microusd = 10;
    if (kind === "total") record.reserved_microusd = 3;
    if (kind === "spend") record.reservation_microusd = 1;
    if (kind === "request") record.request_digest = sha256("wrong");
    if (kind === "head") record.previous_sha256 = sha256("wrong");
    if (kind === "sequence") record.sequence = 3;
    if (kind === "unknown-kind") record.kind = "refund";
    if (kind === "duplicate") record.request_digest = first.reservation.request_digest;
    if (kind === "zero-reservation" || kind === "retroactive-cap") {
      const historical = { ...first.reservation, reservation_microusd: kind === "zero-reservation" ? 0 : 11 };
      const digest = sha256(canonicalJson(historical));
      await rm(first.path);
      await writeFile(join(directory(), "reservations", `0000000000000001-${digest}.json`), `${canonicalJson(historical)}\n`);
      record.previous_sha256 = digest;
    }
    if (kind === "nonincrease") record.request_digest = sha256(canonicalJson({ ...prepared.request, new_limit_microusd: 10 }));
    await rm(receipt.path);
    await writeFile(join(directory(), "reservations", `${String(record.sequence).padStart(16, "0")}-${sha256(canonicalJson(record))}.json`), `${canonicalJson(record)}\n`);
    const before = await bytes();
    await expect(readProposalBudgetSnapshot(identity())).rejects.toMatchObject({ code: "PROPOSE_BUDGET_CORRUPT" });
    await expect(reserve("new", 20)).rejects.toMatchObject({ code: "PROPOSE_BUDGET_CORRUPT" });
    expect(await bytes()).toEqual(before);
  });

  it.each(["old-cap", "duplicate-extension-digest"])("rejects a rehashed reservation with %s after extension", async kind => {
    await reserve();
    const prepared = await prepareBudgetExtension(input());
    await extendProposalBudget({ ...input(), approvalPath: await approve(prepared.scope) });
    const last = await reserve("later", 20);
    const record = { ...last.reservation, ...(kind === "old-cap" ? { provider_limit_microusd: 10 } : { request_digest: prepared.requestDigest }) };
    await rm(last.path);
    await writeFile(join(directory(), "reservations", `0000000000000003-${sha256(canonicalJson(record))}.json`), `${canonicalJson(record)}\n`);
    await expect(readProposalBudgetSnapshot(identity())).rejects.toMatchObject({ code: "PROPOSE_BUDGET_CORRUPT" });
  });

  it("gateway receipts share chain totals without charging or counting extensions", async () => {
    await reserve();
    const prepared = await prepareBudgetExtension(input());
    await extendProposalBudget({ ...input(), approvalPath: await approve(prepared.scope) });
    const token = "offline-test-token-at-least-32-characters";
    const policy: E2eSpendPolicy = { schema_version: "1.0.0", campaign_id: "campaign-test", budget_id: budgetId,
      approval_id: "dec-test-approved", run_id: "run-test", provider, model: "gpt-5.6-terra", provider_limit_microusd: 20,
      max_request_bytes: 65536, max_response_bytes: 2097152, timeout_ms: 120000, max_output_tokens: 1024,
      pricing_profile: "reviewed-text-upper-rates-20260907-v1", token_bound_profile: "json-bytes-times-two-plus-8192-v1",
      input_microusd_per_token: 5, output_microusd_per_token: 18 };
    const gateway = await startGateway({ policy, ledgerRoot: store, token, mode: "rehearsal" });
    try {
      const response = await fetch(gateway.address + "/receipt", { headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      const snapshot = await readProposalBudgetSnapshot(identity());
      expect(await response.json()).toMatchObject({ reservations: snapshot.reservations, reserved_microusd: snapshot.reserved_microusd });
      expect(snapshot).toMatchObject({ reservations: 1, sequence: 2, reserved_microusd: 4 });
    } finally { await gateway.close(); }
  });
});
