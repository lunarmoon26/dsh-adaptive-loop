#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { SCHEMA_IDS, assertSchema } from "./schema.js";
import {
  gradeTask,
  type WorkflowEffectObservation,
  type WorkflowTask,
} from "./workflow-grader.js";

interface EvaluatorSnapshot {
  state: unknown;
  effects: WorkflowEffectObservation[];
  journal_sha256: string;
}

function snapshot(value: unknown): EvaluatorSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Evaluator snapshot is not an object");
  }
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.effects) || typeof candidate.journal_sha256 !== "string") {
    throw new Error("Evaluator snapshot is missing effects or journal digest");
  }
  if (!/^[0-9a-f]{64}$/.test(candidate.journal_sha256)) {
    throw new Error("Evaluator snapshot journal digest is invalid");
  }
  return candidate as unknown as EvaluatorSnapshot;
}

export async function gradeRemoteSnapshot(options: {
  taskPath: string;
  snapshotUrl: string;
  evaluatorToken: string;
}): Promise<{ state: unknown; effects: WorkflowEffectObservation[]; journal_sha256: string; verdict: ReturnType<typeof gradeTask> }> {
  const task = JSON.parse(await readFile(options.taskPath, "utf8")) as unknown;
  await assertSchema(SCHEMA_IDS.workflowTask, task, "Workflow task");
  const response = await fetch(options.snapshotUrl, {
    headers: { authorization: `Bearer ${options.evaluatorToken}` },
  });
  if (!response.ok) throw new Error(`Evaluator snapshot returned HTTP ${response.status}`);
  const observed = snapshot(await response.json());
  const verdict = gradeTask(task as WorkflowTask, observed.state, observed.effects);
  return { ...observed, verdict };
}

async function main(): Promise<void> {
  const [taskPath, snapshotUrl] = process.argv.slice(2);
  const evaluatorToken = process.env.DAL_EVALUATOR_TOKEN;
  if (taskPath === undefined || snapshotUrl === undefined || evaluatorToken === undefined) {
    throw new Error("usage: workflow-grader-remote <task.json> <snapshot-url> with DAL_EVALUATOR_TOKEN set");
  }
  process.stdout.write(`${JSON.stringify(await gradeRemoteSnapshot({ taskPath, snapshotUrl, evaluatorToken }))}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
