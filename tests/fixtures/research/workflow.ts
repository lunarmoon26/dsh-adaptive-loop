import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendCampaignOperation, prepareArtifactCampaign } from "../../../src/artifact-campaign.js";
import type { ArtifactCampaignPlan, CampaignReservation, CampaignResult } from "../../../src/campaign-types.js";
import { jcsCanonicalJson, sha256 } from "../../../src/json.js";
import { stageResearchMechanism, type ResearchBinding, type ResearchMechanism } from "../../../src/research.js";

const fixtures = fileURLToPath(new URL("./", import.meta.url));
const campaignFixtures = fileURLToPath(new URL("../artifact-campaign/", import.meta.url));
export const digest = (value: unknown) => sha256(jcsCanonicalJson(value));
export const writeJson = (file: string, value: unknown) => writeFile(file, JSON.stringify(value, null, 2) + "\n");

/** Materialize regular synthetic files and derive every content identity from bytes. */
export async function researchWorkflow(directory: string) {
  await mkdir(join(directory, "inputs"), { recursive: true });
  const mechanism: ResearchMechanism = JSON.parse(await readFile(join(fixtures, "mechanism.json"), "utf8"));
  await writeJson(join(directory, "mechanism.json"), mechanism);
  const sources = ["workspace.txt", "harness.txt", "cache.bin"];
  const raw = await Promise.all(sources.map(file => file === "cache.bin"
    ? Buffer.from([0, 255, 128, 1, 2, 3]) : readFile(join(fixtures, file))));
  await Promise.all(sources.map((file, index) => writeFile(join(directory, "inputs", file), raw[index]!)));
  const task = await readFile(join(fixtures, "task.json"));
  await writeFile(join(directory, "inputs/task.json"), task);
  const plan: ArtifactCampaignPlan = JSON.parse(await readFile(join(campaignFixtures, "plan.json"), "utf8"));
  plan.campaign_id = "synthetic-research";
  plan.researcher_sha256 = digest(mechanism);
  plan.policy_sha256 = digest({ search_policy: mechanism.search_policy, experience_policy: mechanism.experience_policy });
  plan.root_artifacts = sources.map((file, index) => ({
    ...plan.root_artifacts[0]!, sha256: sha256(raw[index]!),
    kind: ["workspace", "task-harness", "feature-cache"][index]!, locator: `artifact://${sha256(raw[index]!)}`,
  }));
  const reservation: CampaignReservation = JSON.parse(await readFile(join(campaignFixtures, "01-feature-reserve.json"), "utf8"));
  Object.assign(reservation, { campaign_id: plan.campaign_id, contract_sha256: sha256(task), workspace_sha256: plan.root_artifacts[0]!.sha256,
    inputs: plan.root_artifacts.map(({ sha256, kind, compatibility_sha256 }) => ({ sha256, kind, compatibility_sha256 })) });
  const result: CampaignResult = JSON.parse(await readFile(join(campaignFixtures, "02-feature-result.json"), "utf8"));
  Object.assign(result, { campaign_id: plan.campaign_id, outputs: [] });
  const binding: ResearchBinding = {
    $schema: "https://recursive-dev-loop.dev/schemas/research-binding.v1.schema.json", schema_version: "1.0.0",
    campaign_id: plan.campaign_id, node_id: reservation.node_id, mechanism_sha256: plan.researcher_sha256,
    task_contract_uri: "repo://inputs/task.json", task_harness_sha256: plan.root_artifacts[1]!.sha256,
    artifacts: sources.map((file, index) => ({ sha256: sha256(raw[index]!), uri: `repo://inputs/${file}` })),
  };
  await writeJson(join(directory, "binding.json"), binding);
  const seed = async () => {
    await stageResearchMechanism("mechanism.json");
    await prepareArtifactCampaign(plan);
    await appendCampaignOperation(reservation);
  };
  return { mechanism, plan, reservation, result, binding, seed };
}
