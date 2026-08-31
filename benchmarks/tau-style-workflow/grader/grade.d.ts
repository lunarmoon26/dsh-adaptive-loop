#!/usr/bin/env node
export declare const GRADER_VERSION = "tau-style-workflow-grader-v1";
export interface WorkflowTask {
    task_id: string;
    domain: string;
    instruction: string;
    initial_state: Record<string, unknown>;
    goal_state: Record<string, unknown>;
    policy_ref: string;
}
export interface GraderCheck {
    id: string;
    pass: boolean;
    detail: string;
}
export interface Verdict {
    task_id: string;
    pass: boolean;
    checks: GraderCheck[];
    state_digest: string;
    grader_version: string;
}
export declare function gradeTask(task: WorkflowTask, state: unknown): Verdict;
export declare function deepEqual(left: unknown, right: unknown): boolean;
export declare function stableJson(value: unknown): string;
export declare function sha256(value: string): string;
