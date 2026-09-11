import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareBudgetExtension, extendProposalBudget } from "../../src/proposal-budget.js";
import { publishJsonExclusive } from "../../src/json.js";
import { gatewayLedgerRoot } from "../tau-style-workflow/run-e2e.js";
import { privateDirectory, STATE } from "./run.js";

export async function main(argv = process.argv.slice(2)) {
  const [action, flag, approvalPath, ...extra] = argv;
  if (extra.length || (action === "prepare" ? flag !== undefined : action !== "apply" || flag !== "--approval" || !approvalPath)) throw new Error("Use prepare or apply --approval <exact-decision>");
  const input = { store: await gatewayLedgerRoot(new Map()), budgetId: "paid-adaptive-20260908", provider: "openai", newLimit: 12_123_852 };
  if (action === "apply") console.log(JSON.stringify(await extendProposalBudget({ ...input, approvalPath: resolve(approvalPath!) }), null, 2));
  else {
    const prepared = await prepareBudgetExtension(input);
    await privateDirectory(STATE);
    const path = `${STATE}/extension-${prepared.requestDigest}.json`;
    await publishJsonExclusive(path, prepared);
    console.log(JSON.stringify({ path, ...prepared }, null, 2));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
