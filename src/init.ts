import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface InitResult {
  status: "initialized";
  workspace: string;
  created: string[];
  skipped: string[];
  next_steps: string[];
}

export const EVIDENCE_DIRECTORIES = [".dal/outbox", ".dal/store", ".dal/runs", ".dal/clusters"] as const;

export const EVIDENCE_GITIGNORE = `.dal/*
!.dal/outbox/
!.dal/store/
!.dal/runs/
!.dal/clusters/
!.dal/resets/
`;

const AGENTS_TEMPLATE = `# dal agent instructions (workspace)

These workspace instructions come from the dal scaffolding. More specific project instructions take precedence.

## End of every feature-change task

When you complete, block, or abort a feature-change task (implementation, bug fix, refactor, migration, or other repository change), use the \`end-task-feedback\` skill: write a \`feedback-log.v1\` JSON record under \`.dal/outbox/\`, then run \`dal feedback validate <file>\` and \`dal feedback ingest <file>\`, and report the stored record path. Never omit the record because a task did not complete.

## Failure traces

When a task fails on deterministic evidence (tests, build, type errors, policy denial, privacy rejection, schema invalidity, capsule drift, evaluation hard stop, runtime error, timeout, or budget breach), write a run record for that attempt and ingest it with \`dal run ingest <file>\` before closing the task. Include the structured failure facts and the pinned context required by the run-record schema.

## Safety boundaries

- Never change shared harness configuration, install or mount plugins, send project data externally, or apply an optimization candidate without a separate exact human approval.
- Improvement proposals may target only the editable surfaces (\`prompt\`, \`tool_descriptions\`, \`skills\`, \`memory_policy\`, \`routing\`, \`stop_retry_logic\`, \`harness_code\`). Never propose a change to the evaluator, sealed holdout, permissions, maximum budget, promotion policy, audit log, or rollback mechanism.
- Deterministic checks may block but never authorize. Keep raw transcripts, tool arguments and output, source contents, environment values, and secrets out of every record.
`;

const SKILL_TEMPLATE = `---
name: end-task-feedback
description: Complete the required DSH Adaptive Loop feedback record for any feature implementation, bug fix, refactor, migration, or other repository change. Use before declaring work complete, blocked, or aborted; this skill validates privacy-safe evidence, records the explicit exception path when needed, ingests the local record, and returns its provenance receipt.
user-invocable: true
---

# End-task feedback

Use this workflow at the end of every feature-change task. A task that is blocked or aborted still emits a record; only its outcome path changes.

## 1. Select the outcome

- \`completed\`: every acceptance criterion is \`passed\` or \`not_applicable\`; \`outcome.exception\` is \`null\`.
- \`blocked\`: progress depends on a missing input, capability, permission, or external result; set a matching \`blocked\` exception with reason, owner, and next action.
- \`aborted\`: the task was deliberately stopped; set a matching \`aborted\` exception with reason, owner, and next action.

Do not convert a failed criterion into \`not_applicable\` to claim completion.

## 2. Write the record

Write a \`feedback-log.v1\` JSON document under \`.dal/outbox/<feedback-id>.json\`. Required fields include: feedback id, change id, created timestamp, producer metadata, goal, acceptance criteria with per-criterion results, outcome with optional exception, what worked, what failed, calls, failures and inefficiencies, evidence, uncertainty, human review state, and privacy metadata. The \`dal\` CLI validates the exact schema.

Keep the record compact:

- summarize calls by name, purpose, result, and evidence ID;
- link tests, commands, commits, files, or harness session events instead of copying payloads;
- state uncertainty and the smallest resolution step;
- report actual human-review state without treating it as sensitive-action approval;
- use \`[REDACTED:<reason>]\` markers and declare every redaction;
- never include raw tool arguments/output, transcripts, prompts, source content, environment values, credentials, customer payloads, or hidden reasoning.

## 3. Validate before persistence

\`\`\`sh
dal feedback validate .dal/outbox/<feedback-id>.json
\`\`\`

If validation or secret scanning fails, correct the source record. Do not disable a rule or paste the rejected value elsewhere.

## 4. Ingest and query the receipt

\`\`\`sh
dal feedback ingest .dal/outbox/<feedback-id>.json
dal feedback query --feedback <feedback-id> --format json
\`\`\`

Identical retries are safe. A reused feedback ID with different content is a conflict and requires a new ID plus \`supersedes\` when it corrects an earlier record.

## 5. Close the task

Report:

- \`completed\`, \`blocked\`, or \`aborted\` exactly;
- stored record path and feedback digest;
- focused tests and their observed result;
- unresolved decisions or next action;
- whether human review or any separate sensitive-action approval remains pending.

Do not claim that project instructions guarantee a record after a hard process loss. If a prior task has no record, create a new observation describing that gap without inventing the missing facts.
`;

export async function initWorkspace(options: { dir?: string; skillName?: string } = {}): Promise<InitResult> {
  const root = resolve(process.cwd(), options.dir ?? ".");
  const skillName = options.skillName ?? "end-task-feedback";
  const created: string[] = [];
  const skipped: string[] = [];

  for (const directory of EVIDENCE_DIRECTORIES) {
    const path = resolve(root, directory);
    await mkdir(path, { recursive: true, mode: 0o700 });
    created.push(directory);
  }

  const skillPath = resolve(root, ".agents", "skills", skillName, "SKILL.md");
  if (await exists(skillPath)) {
    skipped.push(`.agents/skills/${skillName}/SKILL.md`);
  } else {
    await mkdir(resolve(root, ".agents", "skills", skillName), { recursive: true, mode: 0o700 });
    await writeFile(skillPath, SKILL_TEMPLATE, "utf8");
    created.push(`.agents/skills/${skillName}/SKILL.md`);
  }

  const agentsPath = resolve(root, "AGENTS.md");
  if (await exists(agentsPath)) {
    skipped.push("AGENTS.md");
  } else {
    await writeFile(agentsPath, AGENTS_TEMPLATE, "utf8");
    created.push("AGENTS.md");
  }

  const gitignorePath = resolve(root, ".gitignore");
  if (await exists(gitignorePath)) {
    skipped.push(".gitignore");
  } else {
    await writeFile(gitignorePath, EVIDENCE_GITIGNORE, "utf8");
    created.push(".gitignore");
  }

  return {
    status: "initialized",
    workspace: root,
    created,
    skipped,
    next_steps: [
      "Track the evidence stores in VCS (commit .dal/outbox, .dal/store, .dal/runs, .dal/clusters, .dal/resets).",
      "If .gitignore already existed, append the .dal/ evidence-store rules from the dal template.",
      "Agents now log end-of-task feedback and failure run records automatically; reconcile with `dal feedback summary` and `dal cluster run`.",
      "Optional user-global step (human-performed, approval-gated): copy this skill to ~/.agents/skills/ and the workspace instructions to the fixed user-global ~/.dsh/AGENTS.md so every workspace gets the workflow; install the dal CLI on PATH with `npm install -g dal`.",
    ],
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
