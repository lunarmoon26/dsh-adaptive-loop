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
    /** Local-only development mode: absolute directory for the service journal. */
    stateRoot?: string;
    /** Isolated mode: typed endpoint owned by the separate service container. */
    serviceUrl?: string;
    /** Simulated outcomes per effect kind; default all success. */
    faults?: Partial<Record<"issue_refund" | "create_return_label" | "change_booking" | "refuse_request", "success" | "definite_failure" | "unknown">>;
    /** Resolution of unknown outcomes on status query, per effect kind. */
    resolutions?: Partial<Record<"issue_refund" | "create_return_label" | "change_booking" | "refuse_request", "success" | "definite_failure">>;
}
export declare function apply(ctx: Context, config: Config): void;
