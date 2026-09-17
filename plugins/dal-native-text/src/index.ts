import { Context } from "@deepseek-ai/cordis";
import { pathToFileURL } from "node:url";
import LlmRuntime, { createUserMessage, type TokenUsage, type StreamChunk } from "@deepseek-ai/dsh-llm";
import LocalCredentials from "@deepseek-ai/dsh-credentials-local";
import * as PiAi from "@deepseek-ai/dsh-llm-pi-ai";
import type { CredentialRecordEntry } from "@deepseek-ai/dsh-credentials";

interface TextRequest { model: string; system: string; text: string; credential_store: string; timeout_ms: number; output_tokens: number; output_bytes: number }
interface TextReply { text: string; usage: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number } | null }
export function hasCodexGrant(records: readonly CredentialRecordEntry[]): boolean {
  return records.some((entry) => entry.key === PiAi.recordKeyFor("openai-codex") && entry.kind === "grant");
}
function validNativeRequest(value: unknown): value is TextRequest {
  const r = value as TextRequest;
  return r !== null && typeof r === "object" && typeof r.model === "string" && typeof r.system === "string" && typeof r.text === "string"
    && typeof r.credential_store === "string" && r.credential_store.startsWith("/")
    && Number.isInteger(r.timeout_ms) && r.timeout_ms >= 1000 && r.timeout_ms <= 120000
    && Number.isInteger(r.output_tokens) && r.output_tokens >= 128 && r.output_tokens <= 8192
    && Number.isInteger(r.output_bytes) && r.output_bytes >= 1024 && r.output_bytes <= 65536
    && Buffer.byteLength(r.system) + Buffer.byteLength(r.text) <= 1024 * 1024;
}

/** Exported for protocol tests; no tool schemas, tool dispatcher or model-driven I/O. */
export async function collectNativeText(stream: AsyncIterable<StreamChunk>, maxBytes: number): Promise<TextReply> {
  let finished = false;
  let text = "";
  let streamedBytes = 0;
  let usage: TokenUsage | undefined;
  const completedBlocks = new Set<number>();
  for await (const chunk of stream) {
    if (finished) throw new Error("LIVE_RESPONSE_INVALID");
    if (chunk.type === "tool-call-delta") throw new Error("LIVE_RESPONSE_INVALID");
    if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
      streamedBytes += Buffer.byteLength(chunk.text);
      if (streamedBytes > maxBytes * 8) throw new Error("LIVE_RESPONSE_INVALID");
    }
    if (chunk.type === "block-start" && chunk.blockType !== "text" && chunk.blockType !== "reasoning") throw new Error("LIVE_RESPONSE_INVALID");
    if (chunk.type === "block-end") {
      if (!Number.isSafeInteger(chunk.index) || chunk.index < 0 || completedBlocks.has(chunk.index) || completedBlocks.size >= 1024) throw new Error("LIVE_RESPONSE_INVALID");
      completedBlocks.add(chunk.index);
      if (chunk.block.type === "text") {
        text += chunk.block.text;
        if (Buffer.byteLength(text) > maxBytes) throw new Error("LIVE_RESPONSE_INVALID");
      } else if (chunk.block.type !== "reasoning") throw new Error("LIVE_RESPONSE_INVALID");
    }
    if (chunk.type === "usage") usage = chunk.usage;
    if (chunk.type === "finish") {
      if (chunk.reason.kind !== "stop") throw new Error("LIVE_NATIVE_FAILED");
      finished = true;
    }
    if (!["block-start", "text-delta", "reasoning-delta", "block-end", "usage", "finish"].includes(chunk.type)) throw new Error("LIVE_RESPONSE_INVALID");
  }
  if (!finished || text.trim() === "") throw new Error("LIVE_RESPONSE_INVALID");
  return { text, usage: usage === undefined ? null : {
    input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
    cache_read_tokens: usage.cacheReadTokens ?? 0, cache_write_tokens: usage.cacheWriteTokens ?? 0,
  } };
}

async function execute(request: TextRequest): Promise<TextReply> {
  // Keep the newer native host's seam separate from legacy v0 Cordis module
  // augmentations brought in by the sandbox/tool packages elsewhere in DAL.
  const ctx = new Context() as unknown as {
    plugin(plugin: unknown, config?: unknown): Promise<unknown>;
    llm: LlmRuntime;
    credentials: { listRecords(): Promise<readonly CredentialRecordEntry[]> };
    fiber: { dispose(): Promise<void> };
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeout_ms);
  let stage = "MOUNT";
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(LocalCredentials, { path: request.credential_store, watch: false });
    // Metadata only: native services retain the OAuth grant and its refresh logic.
    stage = "OAUTH";
    const credentials = await ctx.credentials.listRecords();
    if (!hasCodexGrant(credentials)) throw new Error("LIVE_OAUTH_REQUIRED");
    await ctx.plugin(PiAi, { providers: { "openai-codex": {
      models: [{ id: request.model }], reasoning: "low", transport: "sse",
      retryPolicy: { mode: "normal", maxRetries: 0 }, timeoutMs: request.timeout_ms,
      streamIdleTimeoutMs: request.timeout_ms,
    } } });
    stage = "PREPARE";
    const call = await ctx.llm.prepareCall({ provider: "openai-codex", model: request.model, maxTokens: request.output_tokens }, controller.signal);
    stage = "STREAM";
    return await collectNativeText(call.stream({
      ...call.config, system: request.system,
      messages: [createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: request.text }] })],
      signal: controller.signal,
    }), request.output_bytes);
  } catch (error) {
    if (error instanceof Error && ["LIVE_OAUTH_REQUIRED", "LIVE_RESPONSE_INVALID"].includes(error.message)) throw error;
    throw new Error(controller.signal.aborted ? "LIVE_TIMEOUT" : `LIVE_NATIVE_${stage}_FAILED`);
  } finally {
    clearTimeout(timer);
    controller.abort();
    await ctx.fiber.dispose();
  }
}

// Only the trusted parent launches this private IPC host after authorization and
// reservation. It has no public CLI, ambient key environment or profile loader.
if (process.send && process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.once("message", async (value: unknown) => {
  try {
    if (!validNativeRequest(value)) throw new Error("LIVE_RESPONSE_INVALID");
    const reply = await execute(value);
    process.send?.({ ok: true, reply });
  } catch (error) {
    const known = ["LIVE_OAUTH_REQUIRED", "LIVE_TIMEOUT", "LIVE_RESPONSE_INVALID", "LIVE_NATIVE_MOUNT_FAILED", "LIVE_NATIVE_OAUTH_FAILED", "LIVE_NATIVE_PREPARE_FAILED", "LIVE_NATIVE_STREAM_FAILED"];
    const code = error instanceof Error && known.includes(error.message) ? error.message : "LIVE_NATIVE_FAILED";
    process.send?.({ ok: false, code });
  } finally {
    process.disconnect?.();
  }
});
