/** Generic metadata only; no executable commands or artifact contents. */
export interface CampaignArtifact {
  sha256: string;
  kind: string;
  compatibility_sha256: string;
  locator: string;
  evidence_sha256: string;
}
export interface CampaignInput {
  sha256: string;
  kind: string;
  compatibility_sha256: string;
}
export interface ArtifactCampaignPlan {
  $schema: string;
  schema_version: "1.0.0";
  campaign_id: string;
  goal: string;
  metric: { name: string; direction: "maximize" | "minimize" };
  evaluation_context_sha256: string;
  researcher_sha256: string;
  policy_sha256: string;
  limits: { attempts: number; rounds: number; parallelism: number; resources: Record<string, number> };
  root_artifacts: CampaignArtifact[];
}
interface CampaignOperationBase {
  $schema: string;
  schema_version: "1.0.0";
  operation_id: string;
  campaign_id: string;
  actor: { id: string; role: "supervisor" | "worker" };
}
export interface CampaignReservation extends CampaignOperationBase {
  kind: "reserve";
  node_id: string;
  parent_id: string | null;
  round: number;
  hypothesis: string;
  contract_sha256: string;
  worker_id: string;
  workspace_sha256: string;
  inputs: CampaignInput[];
  reservation: Record<string, number>;
}
export interface CampaignResult extends CampaignOperationBase {
  kind: "result" | "resolve";
  node_id: string;
  outcome: "completed" | "failed" | "timed_out" | "unknown";
  outputs: CampaignArtifact[];
  metrics: Array<{ name: string; value: number | null; context_sha256: string }>;
  usage: Record<string, number | null>;
  evidence_sha256: string;
}
export interface CampaignReview extends CampaignOperationBase {
  kind: "review";
  node_id: string;
  result_sha256: string;
  accept_result: boolean;
  accepted_artifacts: string[];
  evidence_sha256: string;
}
export type CampaignOperation = CampaignReservation | CampaignResult | CampaignReview;
export interface CampaignEvent {
  $schema: string;
  schema_version: "1.0.0";
  sequence: number;
  plan_sha256: string;
  previous_sha256: string | null;
  operation: CampaignOperation;
}
export interface CampaignNode {
  reservation: CampaignReservation;
  result: CampaignResult | null;
  review: CampaignReview | null;
}
export interface CampaignProjection {
  plan: ArtifactCampaignPlan;
  plan_sha256: string;
  sequence: number;
  head_sha256: string | null;
  nodes: CampaignNode[];
  artifacts: Array<CampaignArtifact & { producer_node_id: string | null; accepted: boolean }>;
  reserved: Record<string, number>;
  attempts_remaining: number;
  active: number;
  budget_overrun: boolean;
  best: { node_id: string; value: number; result_sha256: string } | null;
}
