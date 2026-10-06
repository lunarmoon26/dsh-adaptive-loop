import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { DalError } from "../errors.js";
import { canonicalJson, sha256 } from "../json.js";
import { assertNoPii, assertNoSecrets, scanPii, scanSecrets } from "../privacy.js";
import { readRepositoryJsonFile, repositoryPathUri } from "../repository.js";
import { assertSchema, SCHEMA_IDS } from "../schema.js";
import type { CampaignGrant, LivePlan } from "./types.js";

export function liveAssert(value: unknown, code: string): asserts value {
  if (!value) throw new DalError(code, code);
}
export function scanLive(value: unknown): void {
  assertNoSecrets(scanSecrets(value));
  assertNoPii(scanPii(value));
  const walk = (item: unknown): void => {
    if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        liveAssert(!["__proto__", "prototype", "constructor"].includes(key), "LIVE_INVALID_JSON");
        walk(child);
      }
    }
  };
  walk(value);
}
export const planDigest = (plan: LivePlan): string => sha256(canonicalJson(plan));
export const liveRoot = (id: string): string => {
  liveAssert(/^[a-z][a-z0-9-]{2,63}$/.test(id), "LIVE_INVALID_ID");
  return resolve(".dal/live", id);
};
export async function readLive<T>(path: string): Promise<T> {
  const { value } = await readRepositoryJsonFile<T>(repositoryPathUri(path, "Live campaign artifact"), "Live campaign artifact", 2 * 1024 * 1024);
  scanLive(value);
  return value;
}
export async function validateLivePlan(value: unknown): Promise<LivePlan> {
  await assertSchema(SCHEMA_IDS.livePlan, value, "Live plan");
  scanLive(value);
  const plan = value as LivePlan;
  liveAssert(plan.workspace === await realpath(process.cwd()), "LIVE_WRONG_WORKSPACE");
  liveAssert(isAbsolute(plan.credential_store) && resolve(plan.credential_store) === plan.credential_store, "LIVE_INVALID_CREDENTIAL_REFERENCE");
  liveAssert(Buffer.byteLength(plan.base_prompt) <= plan.limits.prompt_bytes, "LIVE_PROMPT_LIMIT");
  liveAssert(new Set(plan.cases.map((item) => item.id)).size === plan.cases.length, "LIVE_DUPLICATE_CASE");
  liveAssert(new Set(plan.cases.map((item) => item.input)).size === plan.cases.length, "LIVE_DUPLICATE_INPUT");
  for (const role of ["development", "qualification", "canary"]) liveAssert(plan.cases.some((item) => item.role === role), "LIVE_MISSING_CASE_ROLE");
  if (plan.exploration_policy !== undefined) {
    liveAssert(plan.exploration_policy.max_parallelism <= plan.limits.candidates
      && plan.exploration_policy.max_rounds <= plan.limits.candidates, "LIVE_INVALID_EXPLORATION_POLICY");
  }
  const evaluated = plan.cases.filter((item) => item.role !== "canary").length;
  const canaries = plan.cases.length - evaluated;
  liveAssert(evaluated * (1 + plan.limits.candidates) + plan.limits.candidates + canaries <= plan.limits.requests, "LIVE_INSUFFICIENT_ALLOCATION");
  return plan;
}
export async function verifyLiveGrant(plan: LivePlan, grantPath: string, action: CampaignGrant["actions"][number], at = new Date()): Promise<CampaignGrant> {
  const grant = await readLive<CampaignGrant>(grantPath);
  await assertSchema(SCHEMA_IDS.campaignGrant, grant, "Campaign grant");
  liveAssert(grant.decision === "approved" && grant.plan_sha256 === planDigest(plan) && grant.actions.includes(action), "LIVE_GRANT_DENIED");
  liveAssert(Number.isFinite(at.getTime()) && Date.parse(grant.decided_at) <= at.getTime() && Date.parse(grant.expires_at) > at.getTime(), "LIVE_GRANT_EXPIRED");
  liveAssert(Date.parse(grant.decided_at) < Date.parse(grant.expires_at), "LIVE_GRANT_DENIED");
  try {
    await lstat(resolve(liveRoot(plan.campaign_id), "revoked.json"));
    throw new DalError("LIVE_GRANT_REVOKED", "Campaign authority was revoked");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return grant;
}
export const nativeMountScope = (plan: LivePlan): string => `live-native-mount-v1:${planDigest(plan)}:${plan.runtime_sha256}`;
