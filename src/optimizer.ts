import { DalError } from "./errors.js";
import { assertNoPii, assertNoSecrets, scanPii, scanSecrets } from "./privacy.js";
import { assertSchema, SCHEMA_IDS } from "./schema.js";
import type { OptimizerExchange } from "./types.js";

export async function validateOptimizerExchange(value: unknown): Promise<OptimizerExchange> {
  await assertSchema(SCHEMA_IDS.optimizer, value, "Optimizer exchange");
  const exchange = value as OptimizerExchange;
  assertNoSecrets(scanSecrets(exchange));
  assertNoPii(scanPii(exchange));
  return exchange;
}

export class DisabledOptimizerAdapter {
  async prepare(value: unknown): Promise<Readonly<OptimizerExchange>> {
    const exchange = structuredClone(await validateOptimizerExchange(value));
    return deepFreeze(exchange);
  }

  optimize(): never {
    throw new DalError("OPTIMIZER_DISABLED", "v0 does not run GEPA, SkillOpt, another optimizer, or an LLM");
  }

  apply(): never {
    throw new DalError("CANDIDATE_APPLICATION_DISABLED", "v0 does not apply optimization candidates");
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
