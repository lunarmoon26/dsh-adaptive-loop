import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DalError } from "../errors.js";
import { canonicalJson, sha256 } from "../json.js";
import type { TextDriver, TextReply } from "./types.js";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const workerEntry = () => createRequire(import.meta.url).resolve("@lunarmoon26/dal-native-text");

/** Build/installed entry pins, not a general DSH runtime-closure attestation. */
export async function nativeRuntimeIdentity(): Promise<string> {
  const entries: Array<[string, string]> = [];
  async function collect(directory: string, prefix: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      if ((await stat(path)).isDirectory()) await collect(path, `${prefix}/${name}`);
      else if (/\.(js|json)$/.test(name)) entries.push([`${prefix}/${name}`, sha256(await readFile(path))]);
    }
  }
  try {
    await collect(join(packageRoot, "dist"), "dist");
    await collect(join(packageRoot, "schemas"), "schemas");
    const require = createRequire(workerEntry());
    entries.push(["native-host", sha256(await readFile(workerEntry()))]);
    for (const name of ["@deepseek-ai/cordis", "@deepseek-ai/dsh-llm", "@deepseek-ai/dsh-llm-pi-ai", "@deepseek-ai/dsh-credentials-local"]) {
      const entry = require.resolve(name);
      entries.push([name, sha256(await readFile(entry))]);
    }
  } catch {
    throw new DalError("LIVE_BUILD_REQUIRED", "Build DAL and install its pinned native dependencies before preparing a live campaign");
  }
  return sha256(canonicalJson(entries));
}

/** Fresh trusted host per request. Candidate content never becomes code or a path. */
export const nativeTextDriver: TextDriver = async (request) => new Promise<TextReply>((resolve, reject) => {
  const workerPath = workerEntry();
  const child = fork(workerPath, [], {
    cwd: dirname(workerPath),
    execArgv: [],
    env: { PATH: dirname(process.execPath), LANG: "C.UTF-8" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let settled = false;
  const finish = (error?: DalError, reply?: TextReply) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    child.kill("SIGKILL");
    if (error) reject(error); else resolve(reply!);
  };
  const timer = setTimeout(() => finish(new DalError("LIVE_TIMEOUT", "Native call exceeded its wall-time allocation")), request.timeout_ms + 5000);
  child.on("error", () => finish(new DalError("LIVE_NATIVE_FAILED", "Native host could not start")));
  child.on("exit", () => finish(new DalError("LIVE_NATIVE_FAILED", "Native host exited without a complete response")));
  child.on("message", (value: unknown) => {
    const message = value as { ok?: unknown; reply?: TextReply; code?: unknown };
    if (message?.ok !== true || typeof message.reply?.text !== "string" || Buffer.byteLength(message.reply.text) > request.output_bytes) {
      const code = ["LIVE_OAUTH_REQUIRED", "LIVE_TIMEOUT", "LIVE_RESPONSE_INVALID", "LIVE_NATIVE_FAILED", "LIVE_NATIVE_MOUNT_FAILED", "LIVE_NATIVE_OAUTH_FAILED", "LIVE_NATIVE_PREPARE_FAILED", "LIVE_NATIVE_STREAM_FAILED"].includes(String(message?.code)) ? String(message.code) : "LIVE_NATIVE_FAILED";
      finish(new DalError(code, "Native text request did not complete"));
    } else finish(undefined, message.reply);
  });
  child.send(request, (error) => { if (error) finish(new DalError("LIVE_NATIVE_FAILED", "Native request handoff failed")); });
});
