import { canonicalJson, sha256 } from "../json.js";
import type { LiveDiscoveryNode, LiveExplorationPolicy } from "./types.js";

export interface DiscoveryReplay {
  score: number;
  quality: number;
  work: number;
  rounds: number;
}

/** The same prefix-only batch policy drives online expansion and offline replay. */
export function selectDiscoveryBatch(nodes: readonly LiveDiscoveryNode[], policy: LiveExplorationPolicy): string[] {
  const children = new Set(nodes.filter((node) => node.parent_id !== null).map((node) => node.parent_id));
  // The root stays eligible to open sibling branches even after its first child.
  const available = nodes.filter((node) => node.id === "root" || !children.has(node.id));
  const ordered = [...available].sort((left, right) => {
    if (policy.strategy === "breadth_first") {
      if (left.id === "root") return -1;
      if (right.id === "root") return 1;
      return left.round - right.round || left.id.localeCompare(right.id);
    }
    if (left.id === "root") return 1;
    if (right.id === "root") return -1;
    return right.development_score - left.development_score || left.id.localeCompare(right.id);
  });
  return ordered.slice(0, policy.max_parallelism).map((node) => node.id);
}

function childrenFor(full: readonly LiveDiscoveryNode[], observed: ReadonlySet<string>, parentId: string): LiveDiscoveryNode[] {
  const candidates = full.filter((node) => node.parent_id === parentId && !observed.has(node.id));
  if (parentId === "root") return candidates.slice(0, 1);
  return candidates.slice(0, 1);
}

export function replayDiscoveryTree(full: readonly LiveDiscoveryNode[], policy: LiveExplorationPolicy): DiscoveryReplay {
  const root = full.find((node) => node.id === "root");
  if (root === undefined) throw new Error("A discovery tree must have a root");
  const observed = new Set([root.id]);
  let rounds = 0;
  while (rounds < policy.max_rounds) {
    const prefix = full.filter((node) => observed.has(node.id));
    const selected = selectDiscoveryBatch(prefix, policy);
    if (selected.length === 0) break;
    const revealed = selected.flatMap((id) => childrenFor(full, observed, id));
    if (revealed.length === 0) break;
    for (const node of revealed) observed.add(node.id);
    rounds += 1;
  }
  const prefix = full.filter((node) => observed.has(node.id));
  const work = prefix.length - 1;
  const quality = Math.max(...prefix.map((node) => node.qualification_score));
  const parallelism = work === 0 ? 0 : work / Math.max(1, rounds);
  return { score: quality - (0.02 * work) + (0.01 * parallelism), quality, work, rounds };
}

export const explorationPolicyDigest = (policy: LiveExplorationPolicy): string => sha256(canonicalJson(policy));
