#!/usr/bin/env node
// Deterministic end-state grader for the tau-style workflow task class.
// Usage: tsx grade.ts <task.json> <result-state.json>
// Exits 0 when the state matches the annotated goal and every policy
// invariant holds; exits 1 otherwise. No model, judge, or network.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
export const GRADER_VERSION = "tau-style-workflow-grader-v1";
export function gradeTask(task, state) {
    const checks = [];
    const goal = task.goal_state;
    const actual = (state ?? {});
    for (const [key, expected] of Object.entries(goal)) {
        const same = deepEqual(actual[key], expected);
        checks.push({
            id: `goal:${key}`,
            pass: same,
            detail: same ? "state matches the annotated goal" : "state does not match the annotated goal",
        });
    }
    const orders = (actual.orders ?? {});
    const initialOrders = (task.initial_state.orders ?? {});
    const refunds = (actual.refunds ?? []);
    const labels = (actual.labels ?? []);
    for (const refund of refunds) {
        const order = refund.order === undefined ? undefined : orders[refund.order];
        if (refund.order === undefined || order === undefined) {
            checks.push({ id: "policy:refund-unknown-order", pass: false, detail: "refund references an unknown order" });
            continue;
        }
        const total = order.total ?? initialOrders[refund.order]?.total ?? 0;
        const amount = refund.amount ?? 0;
        if (amount > total) {
            checks.push({ id: "policy:refund-exceeds-total", pass: false, detail: "refund amount exceeds the order total" });
        }
        if (amount === total && total > 0 && !labels.some((label) => label.order === refund.order)) {
            checks.push({ id: "policy:full-refund-requires-label", pass: false, detail: "full refunds require a return label" });
        }
        if (amount < total && amount > 0 && (refund.reason ?? "") === "") {
            checks.push({ id: "policy:partial-refund-requires-reason", pass: false, detail: "partial refunds require a reason code" });
        }
    }
    if (checks.length === 0) {
        checks.push({ id: "goal:empty", pass: false, detail: "task declares no goal state" });
    }
    return {
        task_id: task.task_id,
        pass: checks.every((check) => check.pass),
        checks,
        state_digest: sha256(stableJson(state)),
        grader_version: GRADER_VERSION,
    };
}
export function deepEqual(left, right) {
    if (left === right) {
        return true;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((entry, index) => deepEqual(entry, right[index]));
    }
    if (left !== null &&
        right !== null &&
        typeof left === "object" &&
        typeof right === "object" &&
        !Array.isArray(left) &&
        !Array.isArray(right)) {
        const leftRecord = left;
        const rightRecord = right;
        const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
        return keys.every((key) => deepEqual(leftRecord[key], rightRecord[key]));
    }
    return false;
}
export function stableJson(value) {
    const serialize = (entry) => {
        if (entry === null || typeof entry !== "object") {
            return entry;
        }
        if (Array.isArray(entry)) {
            return entry.map(serialize);
        }
        const record = entry;
        const ordered = {};
        for (const key of Object.keys(record).sort()) {
            ordered[key] = serialize(record[key]);
        }
        return ordered;
    };
    return JSON.stringify(serialize(value));
}
export function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
const invokedPath = process.argv[1];
const entryPath = fileURLToPath(import.meta.url);
const invokedDirectly = invokedPath !== undefined &&
    (import.meta.url === pathToFileURL(invokedPath).href ||
        (() => {
            try {
                return realpathSync(invokedPath) === entryPath;
            }
            catch {
                return false;
            }
        })());
if (invokedDirectly) {
    const [taskPath, statePath] = process.argv.slice(2);
    if (taskPath === undefined || statePath === undefined) {
        process.stderr.write("usage: grade.ts <task.json> <result-state.json>\n");
        process.exitCode = 2;
    }
    else {
        try {
            const task = JSON.parse(await readFile(taskPath, "utf8"));
            const state = JSON.parse(await readFile(statePath, "utf8"));
            const verdict = gradeTask(task, state);
            process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
            process.exitCode = verdict.pass ? 0 : 1;
        }
        catch (error) {
            process.stderr.write(`GRADER_ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 2;
        }
    }
}
//# sourceMappingURL=grade.js.map