import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { createRequire } from "node:module";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { DalError } from "./errors.js";
import { readJsonFile } from "./json.js";
import {
  EDITABLE_SURFACES,
  GUARDRAIL_CAPABILITIES,
  IMMUTABLE_ANCHORS,
  SENSITIVE_ACTIONS,
  type Policy,
} from "./types.js";

export const SCHEMA_IDS = {
  admissionChallenge: "https://recursive-dev-loop.dev/schemas/admission-challenge.v1.schema.json",
  admissionProbeResult: "https://recursive-dev-loop.dev/schemas/admission-probe-result.v1.schema.json",
  admissionReceipt: "https://recursive-dev-loop.dev/schemas/admission-receipt.v1.schema.json",
  approval: "https://recursive-dev-loop.dev/schemas/approval-decision.v1.schema.json",
  branchEvaluation: "https://recursive-dev-loop.dev/schemas/branch-evaluation.v1.schema.json",
  branchRecord: "https://recursive-dev-loop.dev/schemas/branch-record.v1.schema.json",
  capsule: "https://recursive-dev-loop.dev/schemas/knowledge-capsule.v1.schema.json",
  clusterRecord: "https://recursive-dev-loop.dev/schemas/cluster-record.v1.schema.json",
  controllerPolicy: "https://recursive-dev-loop.dev/schemas/controller-policy.v1.schema.json",
  controllerState: "https://recursive-dev-loop.dev/schemas/controller-state.v1.schema.json",
  effectIntent: "https://recursive-dev-loop.dev/schemas/effect-intent.v1.schema.json",
  executionReceipt: "https://recursive-dev-loop.dev/schemas/execution-receipt.v1.schema.json",
  effectReceipt: "https://recursive-dev-loop.dev/schemas/effect-receipt.v1.schema.json",
  evaluationScorecard: "https://recursive-dev-loop.dev/schemas/evaluation-scorecard.v1.schema.json",
  evaluationSuite: "https://recursive-dev-loop.dev/schemas/evaluation-suite.v1.schema.json",
  feedback: "https://recursive-dev-loop.dev/schemas/feedback-log.v1.schema.json",
  guardrailAction: "https://recursive-dev-loop.dev/schemas/guardrail-action.v1.schema.json",
  guardrailDecision: "https://recursive-dev-loop.dev/schemas/guardrail-decision.v1.schema.json",
  optimizer: "https://recursive-dev-loop.dev/schemas/optimizer-exchange.v1.schema.json",
  optimizerCandidate: "https://recursive-dev-loop.dev/schemas/optimizer-candidate.v1.schema.json",
  optimizerTrainingSet: "https://recursive-dev-loop.dev/schemas/optimizer-training-set.v1.schema.json",
  optimizerVerdict: "https://recursive-dev-loop.dev/schemas/optimizer-verdict.v1.schema.json",
  policy: "https://recursive-dev-loop.dev/schemas/policy.v1.schema.json",
  proposal: "https://recursive-dev-loop.dev/schemas/improvement-proposal.v1.schema.json",
  proposalDraft: "https://recursive-dev-loop.dev/schemas/proposal-draft.v1.schema.json",
  resetReceipt: "https://recursive-dev-loop.dev/schemas/reset-receipt.v1.schema.json",
  runRecord: "https://recursive-dev-loop.dev/schemas/run-record.v1.schema.json",
  runtimeGenerationEvidence: "https://recursive-dev-loop.dev/schemas/runtime-generation-evidence.v1.schema.json",
  runtimeGenerationManifest: "https://recursive-dev-loop.dev/schemas/runtime-generation-manifest.v1.schema.json",
  sealCommitment: "https://recursive-dev-loop.dev/schemas/seal-commitment.v1.schema.json",
  sealReveal: "https://recursive-dev-loop.dev/schemas/seal-reveal.v1.schema.json",
  storedFeedback: "https://recursive-dev-loop.dev/schemas/stored-feedback-record.v1.schema.json",
  workflowTask: "https://recursive-dev-loop.dev/schemas/workflow-task.v1.schema.json",
} as const;

const schemaDirectory = fileURLToPath(new URL("../schemas/", import.meta.url));
const policyPath = fileURLToPath(new URL("../config/policy.v1.json", import.meta.url));
const addFormats = createRequire(import.meta.url)("ajv-formats") as FormatsPlugin;

let validatorsPromise: Promise<Map<string, ValidateFunction>> | undefined;
let policyPromise: Promise<Policy> | undefined;

async function loadValidators(): Promise<Map<string, ValidateFunction>> {
  if (validatorsPromise !== undefined) {
    return validatorsPromise;
  }

  validatorsPromise = (async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const names = (await readdir(schemaDirectory)).filter((name) => name.endsWith(".json")).sort();
    for (const name of names) {
      const { value } = await readJsonFile<Record<string, unknown>>(`${schemaDirectory}${name}`);
      ajv.addSchema(value);
    }

    const validators = new Map<string, ValidateFunction>();
    for (const id of Object.values(SCHEMA_IDS)) {
      const validator = ajv.getSchema(id);
      if (validator === undefined) {
        throw new DalError("SCHEMA_REGISTRY_INVALID", `Schema was not registered: ${id}`);
      }
      validators.set(id, validator);
    }
    return validators;
  })();

  return validatorsPromise;
}

export async function assertSchema(schemaId: string, value: unknown, label: string): Promise<void> {
  const validators = await loadValidators();
  const validator = validators.get(schemaId);
  if (validator === undefined) {
    throw new DalError("UNKNOWN_SCHEMA", `Unknown schema: ${schemaId}`);
  }
  if (!validator(value)) {
    throw new DalError(
      "SCHEMA_VALIDATION_FAILED",
      `${label} does not conform to ${schemaId}`,
      (validator.errors ?? []).map(formatSchemaError),
    );
  }
}

function formatSchemaError(error: ErrorObject): string {
  const path = error.instancePath === "" ? "/" : error.instancePath;
  return `${path} ${error.message ?? "is invalid"}`;
}

export async function loadPolicy(): Promise<Policy> {
  if (policyPromise !== undefined) {
    return policyPromise;
  }

  policyPromise = (async () => {
    const { value } = await readJsonFile<Policy>(policyPath);
    return validatePolicy(value);
  })();

  return policyPromise;
}

export async function validatePolicy(value: unknown): Promise<Policy> {
  await assertSchema(SCHEMA_IDS.policy, value, "Policy configuration");
  const policy = value as Policy;
  const normalized: Policy = {
    ...policy,
    default_run_store: policy.default_run_store ?? ".dal/runs",
    default_cluster_store: policy.default_cluster_store ?? ".dal/clusters",
    editable_surfaces: policy.editable_surfaces ?? [...EDITABLE_SURFACES],
    immutable_anchors: policy.immutable_anchors ?? [...IMMUTABLE_ANCHORS],
    docker_image: policy.docker_image ?? "dsh-adaptive-loop/dsh:0.1.1-rc.2",
    docker_run_flags: policy.docker_run_flags ?? ["--security-opt", "seccomp=unconfined"],
    docker_env_names: policy.docker_env_names ?? ["DEEPSEEK_API_KEY"],
  };
  const configured = [...normalized.sensitive_actions].sort();
  const required = [...SENSITIVE_ACTIONS].sort();
  if (configured.join("\n") !== required.join("\n")) {
    throw new DalError("POLICY_INVALID", "Policy must list every supported sensitive action exactly once");
  }
  const capabilities = [...normalized.allowed_capabilities, ...normalized.denied_capabilities].sort();
  const expectedCapabilities = [...GUARDRAIL_CAPABILITIES].sort();
  if (capabilities.join("\n") !== expectedCapabilities.join("\n")) {
    throw new DalError("POLICY_INVALID", "Policy must classify every guardrail capability exactly once");
  }
  if (!normalized.allowed_write_roots.every((root) => root.startsWith("repo://.dal/"))) {
    throw new DalError("POLICY_INVALID", "Every allowed write root must be scoped below repo://.dal/");
  }
  const surfaces = [...normalized.editable_surfaces, ...normalized.immutable_anchors].sort();
  const expectedSurfaces = [...EDITABLE_SURFACES, ...IMMUTABLE_ANCHORS].sort();
  if (surfaces.join("\n") !== expectedSurfaces.join("\n")) {
    throw new DalError("POLICY_INVALID", "Policy must classify every proposal surface exactly once");
  }
  return normalized;
}
