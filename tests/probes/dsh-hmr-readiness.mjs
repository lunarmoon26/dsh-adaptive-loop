import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dshRoot = resolve(process.argv[2] ?? "");
if (dshRoot === resolve("")) throw new Error("expected a built DSH checkout path");

const { Context } = await import(pathToFileURL(join(dshRoot, "vendor", "cordis", "lib", "index.js")).href);
const { default: Loader } = await import(pathToFileURL(join(dshRoot, "vendor", "loader", "lib", "index.js")).href);
const { default: Timer } = await import(pathToFileURL(join(dshRoot, "vendor", "timer", "lib", "index.js")).href);
const { default: Hmr } = await import(pathToFileURL(join(dshRoot, "vendor", "hmr", "lib", "index.js")).href);
const FIBER_LOADING = 1;
const FIBER_FAILED = 3;

async function writeAtomic(destination, bytes) {
  const temporary = join(dirname(destination), `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
}

function withTimeout(promise, label, timeoutMs = 8_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`timeout: ${label}`)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

async function eventually(check, label) {
  await withTimeout((async () => {
    while (!check()) await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  })(), label);
}

async function startRuntime(root, debounce) {
  const ctx = new Context();
  ctx.baseUrl = `${pathToFileURL(root).href}/`;
  await ctx.plugin(Loader);
  await ctx.plugin(Timer);
  await ctx.plugin(Hmr, {
    root: ["."],
    ignored: ["**/node_modules", "**/.*"],
    debounce,
    usePolling: true,
    interval: 10,
  });
  await ctx.loader.create({ name: "./plugin/index.mjs", config: {} });
  await ctx.loader.await();
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  return ctx;
}

async function failedActivationProbe() {
  const root = await mkdtemp(join(tmpdir(), "dal-hmr-failed-activation-"));
  const entryPath = join(root, "plugin", "index.mjs");
  await mkdir(dirname(entryPath), { recursive: true });
  const baseline = `
export const name = "dal-hmr-failed-activation-target";
export function apply(ctx) {
  globalThis.__dalHmrFailureProbe = "baseline-active";
  ctx.effect(() => () => { globalThis.__dalHmrFailureProbe = "baseline-disposed"; });
}
`;
  const candidate = `
export const name = "dal-hmr-failed-activation-target";
export function apply() {
  globalThis.__dalHmrFailureProbe = "candidate-started";
  throw new Error("intentional candidate startup failure");
}
`;
  await writeFile(entryPath, baseline);
  const ctx = await startRuntime(root, 50);
  const observed = Promise.withResolvers();
  let phaseAtEvent = null;
  let reloadCount = 0;
  try {
    ctx.on("hmr/reload", () => {
      reloadCount += 1;
      phaseAtEvent = [...ctx.loader.entries()][0]?.fiber?.state ?? null;
      observed.resolve();
    });
    await writeAtomic(entryPath, candidate);
    await withTimeout(observed.promise, "failed activation hmr/reload");
    await eventually(
      () => [...ctx.loader.entries()][0]?.fiber?.state === FIBER_FAILED,
      "candidate Fiber failure",
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    return {
      hmr_reload_emitted: reloadCount === 1,
      phase_at_event: phaseAtEvent === FIBER_LOADING ? "loading" : String(phaseAtEvent),
      final_phase: [...ctx.loader.entries()][0]?.fiber?.state === FIBER_FAILED ? "failed" : "other",
      baseline_restored: globalThis.__dalHmrFailureProbe === "baseline-active",
      source_is_candidate: await readFile(entryPath, "utf8") === candidate,
    };
  } finally {
    await ctx.fiber.dispose();
    delete globalThis.__dalHmrFailureProbe;
  }
}

async function multifileRaceProbe() {
  const root = await mkdtemp(join(tmpdir(), "dal-hmr-multifile-race-"));
  const pluginRoot = join(root, "plugin");
  const aPath = join(pluginRoot, "a.mjs");
  const bPath = join(pluginRoot, "b.mjs");
  const entryPath = join(pluginRoot, "index.mjs");
  await mkdir(pluginRoot, { recursive: true });
  const baselineA = "export const a = 0;\n";
  const baselineB = "export const b = 0;\n";
  const candidateA = "export const a = 1;\n";
  const candidateB = "export const b = 1;\n";
  const baselineEntry = `
import { a } from "./a.mjs";
import { b } from "./b.mjs";
const marker = 0;
globalThis.__dalHmrRaceImportCount = (globalThis.__dalHmrRaceImportCount ?? 0) + 1;
if (globalThis.__dalHmrRaceImportCount > 1) {
  globalThis.__dalHmrRaceImportStarted?.({ a, b, marker });
  await new Promise((resolveImport) => { globalThis.__dalHmrRaceReleaseImport = resolveImport; });
}
export const name = "dal-hmr-multifile-race-target";
export function apply(ctx) {
  globalThis.__dalHmrRaceRuntime = { a, b, marker };
  ctx.effect(() => () => undefined);
}
`;
  const candidateEntry = `
import { a } from "./a.mjs";
import { b } from "./b.mjs";
const marker = 1;
globalThis.__dalHmrRaceImportCount = (globalThis.__dalHmrRaceImportCount ?? 0) + 1;
export const name = "dal-hmr-multifile-race-target";
export function apply(ctx) {
  globalThis.__dalHmrRaceRuntime = { a, b, marker };
  ctx.effect(() => () => undefined);
}
`;
  await Promise.all([
    writeFile(aPath, baselineA),
    writeFile(bPath, baselineB),
    writeFile(entryPath, baselineEntry),
  ]);
  const importStarted = Promise.withResolvers();
  globalThis.__dalHmrRaceImportStarted = importStarted.resolve;
  const ctx = await startRuntime(root, 500);
  const reloadObserved = Promise.withResolvers();
  let sourceAtEvent = "unknown";
  try {
    ctx.on("hmr/reload", async () => {
      const [a, b, entry] = await Promise.all([
        readFile(aPath, "utf8"),
        readFile(bPath, "utf8"),
        readFile(entryPath, "utf8"),
      ]);
      sourceAtEvent = a === candidateA && b === candidateB && entry === candidateEntry
        ? "complete-candidate"
        : "partial";
      reloadObserved.resolve();
    });

    await writeAtomic(aPath, candidateA);
    const imported = await withTimeout(importStarted.promise, "hybrid import start");
    await writeAtomic(bPath, candidateB);
    await writeAtomic(entryPath, candidateEntry);
    globalThis.__dalHmrRaceReleaseImport();
    await withTimeout(reloadObserved.promise, "hybrid hmr/reload");
    await eventually(
      () => globalThis.__dalHmrRaceRuntime?.a === 1
        && globalThis.__dalHmrRaceRuntime?.b === 0
        && globalThis.__dalHmrRaceRuntime?.marker === 0,
      "hybrid Fiber activation",
    );
    return {
      import_started_with: imported,
      source_at_event: sourceAtEvent,
      runtime_after_event: "hybrid",
    };
  } finally {
    globalThis.__dalHmrRaceReleaseImport?.();
    await ctx.fiber.dispose();
    delete globalThis.__dalHmrRaceImportCount;
    delete globalThis.__dalHmrRaceImportStarted;
    delete globalThis.__dalHmrRaceReleaseImport;
    delete globalThis.__dalHmrRaceRuntime;
  }
}

const result = {
  failed_activation: await failedActivationProbe(),
  multifile_race: await multifileRaceProbe(),
};
process.stdout.write(`${JSON.stringify(result)}\n`);
