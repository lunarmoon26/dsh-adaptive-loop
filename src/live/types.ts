export interface LiveCase {
  id: string;
  role: "development" | "qualification" | "canary";
  input: string;
  expected: Record<string, unknown>;
}
export interface LivePlan {
  $schema: string;
  schema_version: "1.0.0";
  campaign_id: string;
  workspace: string;
  runtime_sha256: string;
  credential_store: string;
  model: string;
  goal: string;
  response_contract: string;
  base_prompt: string;
  cases: LiveCase[];
  limits: { candidates: number; requests: number; timeout_ms: number; output_tokens: number; output_bytes: number; prompt_bytes: number };
  minimum_gain: number;
}
export interface CampaignGrant {
  $schema: string;
  schema_version: "1.0.0";
  decision_id: string;
  decision: "approved" | "rejected";
  reviewer: { kind: "human"; id: string };
  plan_sha256: string;
  actions: Array<"send_text" | "activate_prompt" | "rollback_prompt">;
  decided_at: string;
  expires_at: string;
}
export interface TextRequest {
  model: string;
  system: string;
  text: string;
  credential_store: string;
  timeout_ms: number;
  output_tokens: number;
  output_bytes: number;
}
export interface TextReply {
  text: string;
  usage: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number } | null;
}
export type TextDriver = (request: TextRequest) => Promise<TextReply>;
export interface Generation {
  id: string;
  prompt: string;
  hypothesis: { gap: string; proxy: string; mechanism: string } | null;
}
export interface Evaluation {
  generation: string;
  development: number;
  qualification: number;
  cases: Array<{ id: string; pass: boolean; response_sha256: string }>;
}
export interface LiveState {
  $schema: string;
  schema_version: "1.0.0";
  sequence: number;
  previous_sha256: string | null;
  plan_sha256: string;
  phase: "prepared" | "baseline" | "search" | "probe" | "complete" | "rolled_back" | "failed";
  active: string;
  retained: string[];
  evaluations: Evaluation[];
  candidate_index: number;
  last_error: string | null;
}
export interface LiveOperation {
  $schema: string;
  schema_version: "1.0.0";
  operation: string;
  plan_sha256: string;
  request_sha256: string;
  generation: string;
  phase: "task" | "proposal";
  status: "reserved" | "succeeded" | "failed";
  response: Record<string, unknown> | null;
  response_sha256: string | null;
  usage: TextReply["usage"];
  error: string | null;
}
