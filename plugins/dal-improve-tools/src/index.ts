import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";

/**
 * DSH Adaptive Loop improvement mode: the workbench tool set.
 *
 * Every tool runs the SAME deterministic dal CLI the operator runs, as a
 * subprocess, with a fixed timeout and abort forwarding. The set deliberately
 * excludes every approval-gated or model-calling operation — `propose run`,
 * `reset execute`, seal reveal, and any sensitive action stay CLI-only with
 * verified human approval. Promotion remains a human step.
 */

export const name = "dal-improve-tools";
export const inject = ["tools"];

export interface Config {
  /** Override for the dal CLI invocation; default resolves the repo's compiled dist/cli.js. */
  cliCommand?: string[];
  /** Per-call budget in milliseconds; default 120000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_STORE = ".dal/runs";
const DEFAULT_CLUSTERS = ".dal/clusters";

function defaultCli(): string[] {
  return ["node", fileURLToPath(new URL("../../../dist/cli.js", import.meta.url))];
}

async function runCli(
  cliCommand: string[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      cliCommand[0]!,
      [...cliCommand.slice(1), ...args],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolvePromise({ code: 0, stdout, stderr });
          return;
        }
        const code =
          typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
            ? (error as NodeJS.ErrnoException & { code: number }).code
            : 1;
        resolvePromise({ code, stdout, stderr });
      },
    );
    const abort = () => child.kill("SIGTERM");
    if (signal !== undefined) {
      if (signal.aborted) {
        abort();
      } else {
        signal.addEventListener("abort", abort, { once: true });
      }
    }
    child.on("close", () => {
      signal?.removeEventListener("abort", abort);
    });
    child.on("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

function toolError(code: number, stderr: string): string {
  const tail = stderr.trim().split("\n").slice(-4).join("; ");
  return `dal CLI exited ${code}${tail === "" ? "" : `: ${tail}`}`;
}

export function apply(ctx: Context, config: Config): void {
  const cliCommand = config.cliCommand ?? defaultCli();
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  ctx.tools.register(
    defineTool({
      name: "dal_cluster_run",
      description:
        "Run the deterministic dal failure clustering over the workspace run store (.dal/runs): groups failed runs by canonical failure fingerprint into immutable cluster records under .dal/clusters. Local, no model, no network. Use before preparing an improvement payload.",
      parameters: {
        store: {
          type: "string",
              description: "Optional run store directory; defaults to .dal/runs.",
        },
        output: {
          type: "string",
              description: "Optional cluster store directory; defaults to .dal/clusters.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            cluster_count: { type: "integer", required: true },
            clustered_runs: { type: "integer", required: true },
            skipped_successful_runs: { type: "integer", required: true },
            skipped_unfailed_runs: { type: "integer", required: true },
            clusters: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  cluster_id: { type: "string", required: true },
                  member_count: { type: "integer", required: true },
                  status: { type: "string", required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `Clustered ${value.clustered_runs} failed runs into ${value.cluster_count} cluster(s); ${value.skipped_successful_runs} successful runs skipped.`,
          },
        ],
      },
      async execute(args) {
        const { store, output } = args as { store?: string; output?: string };
        const result = await runCli(cliCommand, timeoutMs, undefined, [
          "cluster",
          "run",
          "--store",
          store ?? DEFAULT_STORE,
          "--format",
          "json",
          ...(output === undefined ? [] : ["--output", output]),
        ]);
        if (result.code !== 0) throw new Error(toolError(result.code, result.stderr));
        const parsed = JSON.parse(result.stdout) as {
          cluster_count: number;
          clustered_runs: number;
          skipped_successful_runs: number;
          skipped_unfailed_runs: number;
          clusters: Array<{ cluster_id: string; member_count: number; status: string }>;
        };
        return {
          cluster_count: parsed.cluster_count,
          clustered_runs: parsed.clustered_runs,
          skipped_successful_runs: parsed.skipped_successful_runs,
          skipped_unfailed_runs: parsed.skipped_unfailed_runs,
          clusters: parsed.clusters.map(({ cluster_id, member_count, status }) => ({
            cluster_id,
            member_count,
            status,
          })),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "dal_proposal_prepare",
      description:
        "Prepare the sanitized improvement payload from the cluster store: cluster fingerprints, member counts, and capped failure summaries — never raw traces or secrets. Prints the payload digest; a human later approves a send_data_externally decision bound to that exact digest before any model run. Local, no model, no network.",
      parameters: {
        clusters: {
          type: "string",
              description: "Optional cluster store directory; defaults to .dal/clusters.",
        },
        runs: {
          type: "string",
              description: "Optional run store directory; defaults to .dal/runs.",
        },
        output: {
          type: "string",
              description: "Optional payload file path; defaults to .dal/check/prepared-<id>.json.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            payload_digest: { type: "string", required: true },
            payload_path: { type: "string", required: true },
          },
        },
        render: (_args, value) => [
          { type: "text", text: `Prepared payload with digest ${value.payload_digest} at ${value.payload_path}.` },
        ],
      },
      async execute(args) {
        const { clusters, runs, output: requested } = args as { clusters?: string; runs?: string; output?: string };
        const output = requested ?? `.dal/check/prepared-${randomUUID()}.json`;
        const result = await runCli(cliCommand, timeoutMs, undefined, [
          "propose",
          "prepare",
          "--clusters",
          clusters ?? DEFAULT_CLUSTERS,
          "--runs",
          runs ?? DEFAULT_STORE,
          "--output",
          output,
        ]);
        if (result.code !== 0) throw new Error(toolError(result.code, result.stderr));
        return JSON.parse(result.stdout) as { payload_digest: string; payload_path: string };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "dal_run_summary",
      description:
        "Summarize the stored end-task feedback records (.dal/store): outcome counts and inefficiency category counts. Local, no model, no network.",
      parameters: {
        store: {
          type: "string",
              description: "Optional feedback store directory; defaults to .dal/store.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            report: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.report }],
      },
      async execute(args) {
        const { store } = args as { store?: string };
        const result = await runCli(cliCommand, timeoutMs, undefined, [
          "feedback",
          "summary",
          "--store",
          store ?? ".dal/store",
          "--format",
          "text",
        ]);
        if (result.code !== 0) throw new Error(toolError(result.code, result.stderr));
        return { report: result.stdout.trim() };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "dal_branch_evaluate",
      description:
        "Evaluate candidate state and optional evaluator-owned effect evidence against a deterministic workflow task grader and record the verdict (score 1 pass / 0 fail). Local, no model, no network.",
      parameters: {
        branch: {
          type: "string",
          required: true,
          description: "Branch id, e.g. brn-skill-refund-label-001.",
        },
        task: {
          type: "string",
          required: true,
          description: "Repo-relative path to the task file.",
        },
        state: {
          type: "string",
          required: true,
          description: "Repo-relative path to the candidate final-state file.",
        },
        effects: {
          type: "string",
          description: "Optional repo-relative evaluator effect-log JSONL path; required for effect-aware refusal tasks.",
        },
        receipt: {
          type: "string",
          description: "Optional execution receipt that binds the state, task, effects, and verdict.",
        },
        store: {
          type: "string",
              description: "Optional branch store directory; defaults to .dal/branches.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            evaluation_id: { type: "string", required: true },
            passed: { type: "boolean", required: true },
            score: { type: "integer", required: true },
          },
        },
        render: (_args, value) => [
          { type: "text", text: `Branch evaluation ${value.evaluation_id}: ${value.passed ? "passed" : "failed"} (score ${value.score}).` },
        ],
      },
      async execute(args) {
        const { branch, task, state, effects, receipt, store } = args as {
          branch: string;
          task: string;
          state: string;
          effects?: string;
          receipt?: string;
          store?: string;
        };
        const result = await runCli(cliCommand, timeoutMs, undefined, [
          "branch",
          "evaluate",
          "--branch",
          branch,
          "--task",
          task,
          "--state",
          state,
          ...(effects === undefined ? [] : ["--effects", effects]),
          ...(receipt === undefined ? [] : ["--receipt", receipt]),
          ...(store === undefined ? [] : ["--store", store]),
        ]);
        if (result.code !== 0) throw new Error(toolError(result.code, result.stderr));
        const parsed = JSON.parse(result.stdout) as {
          evaluation_id: string;
          passed: boolean;
          score: number;
        };
        return { evaluation_id: parsed.evaluation_id, passed: parsed.passed, score: parsed.score };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "dal_reset_status",
      description:
        "Dry-run the evidence reset: report store counts, the digest manifest, git revision, and blocking conditions WITHOUT removing anything. Local, read-only.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ready: { type: "boolean", required: true },
            evidence_exists: { type: "boolean", required: true },
            total_files: { type: "integer", required: true },
            blocks: {
              type: "array",
              required: true,
              items: { type: "string" },
            },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `Reset status: ${value.ready ? "ready" : "blocked"} (${value.total_files} evidence files; ${
              value.evidence_exists ? "store present" : "no store"
            }).${value.blocks.length > 0 ? ` Blocks: ${value.blocks.join("; ")}` : ""}`,
          },
        ],
      },
      async execute() {
        const result = await runCli(cliCommand, timeoutMs, undefined, ["reset", "status"]);
        if (result.code !== 0) throw new Error(toolError(result.code, result.stderr));
        const parsed = JSON.parse(result.stdout) as {
          ready: boolean;
          evidence_exists: boolean;
          removed: { total_files: number };
          blocks: string[];
        };
        return {
          ready: parsed.ready,
          evidence_exists: parsed.evidence_exists,
          total_files: parsed.removed.total_files,
          blocks: parsed.blocks,
        };
      },
    }),
  );
}
