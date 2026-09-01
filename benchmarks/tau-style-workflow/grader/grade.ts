#!/usr/bin/env node
// CLI wrapper for the tau-style workflow grader. The pure grading core
// lives in src/workflow-grader.ts so the dal runtime can use the same
// deterministic value function as this benchmark workspace.
// Usage: tsx grade.ts <task.json> <result-state.json> [effects.jsonl]

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export {
  GRADER_VERSION,
  deepEqual,
  gradeTask,
  parseWorkflowEffectLog,
  sha256,
  stableJson,
  type GraderCheck,
  type Verdict,
  type WorkflowEffectObservation,
  type WorkflowTask,
} from "../../../src/workflow-grader.js";
import {
  gradeTask,
  parseWorkflowEffectLog,
  type WorkflowTask,
} from "../../../src/workflow-grader.js";

const invokedPath = process.argv[1];
const entryPath = fileURLToPath(import.meta.url);
const invokedDirectly =
  invokedPath !== undefined &&
  (import.meta.url === pathToFileURL(invokedPath).href ||
    (() => {
      try {
        return realpathSync(invokedPath) === entryPath;
      } catch {
        return false;
      }
    })());

if (invokedDirectly) {
  const [taskPath, statePath, effectsPath] = process.argv.slice(2);
  if (taskPath === undefined || statePath === undefined) {
    process.stderr.write("usage: grade.ts <task.json> <result-state.json> [effects.jsonl]\n");
    process.exitCode = 2;
  } else {
    try {
      const task = JSON.parse(await readFile(taskPath, "utf8")) as WorkflowTask;
      const state = JSON.parse(await readFile(statePath, "utf8")) as unknown;
      const effects = effectsPath === undefined ? undefined : parseWorkflowEffectLog(await readFile(effectsPath, "utf8"));
      const verdict = gradeTask(task, state, effects);
      process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
      process.exitCode = verdict.pass ? 0 : 1;
    } catch (error) {
      process.stderr.write(`GRADER_ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    }
  }
}
