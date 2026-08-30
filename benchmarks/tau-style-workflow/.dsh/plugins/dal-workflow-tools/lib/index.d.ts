import type { Context } from "@deepseek-ai/cordis";
/**
 * Typed domain tools for the tau-style benchmark workspace: the agent
 * operates the mock order/booking service ONLY through these tools, and the
 * deterministic grader reads the service state — never the agent's own
 * files. Tool connectivity is not authority: every effect carries an
 * idempotency key and lands in the append-only effect log, so retries,
 * unknown outcomes, and compensating checks are observable.
 */
export declare const name = "dal-workflow-tools";
export declare const inject: string[];
export interface Config {
    /** Absolute directory for the mock service state and effect log. */
    stateRoot: string;
    /** Simulated outcomes per effect kind; default all success. */
    faults?: Partial<Record<"issue_refund" | "create_return_label" | "change_booking" | "refuse_request", "success" | "definite_failure" | "unknown">>;
}
export declare function apply(ctx: Context, config: Config): void;
