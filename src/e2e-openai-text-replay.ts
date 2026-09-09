/** Explicit text-only projection for the pinned Responses replay experiment. */
export const OPENAI_TEXT_REPLAY_PROFILE = "openai-empty-reasoning-text-replay-v1";
const limit = 65536;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function requireValue(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }

export function projectOpenAiTextReplay(wire: string): string {
  requireValue(Buffer.byteLength(wire) <= limit, "E2E_TEXT_REPLAY_TOO_LARGE");
  let value: unknown;
  try { value = JSON.parse(wire); } catch { throw new Error("E2E_TEXT_REPLAY_INVALID_JSON"); }
  requireValue(object(value) && value.model === "gpt-5.6-terra" && value.store === false, "E2E_TEXT_REPLAY_POLICY");
  requireValue(value.reasoning === undefined || (object(value.reasoning) && Object.keys(value.reasoning).length === 1 && value.reasoning.effort === "none"), "E2E_TEXT_REPLAY_POLICY");
  const input = value.input;
  requireValue(typeof input === "string" || Array.isArray(input), "E2E_TEXT_REPLAY_INPUT");
  let removed = false;
  const visible = typeof input === "string" ? input : input.filter(item => {
    if (!object(item) || item.type !== "reasoning") return true;
    requireValue(Object.keys(item).every(key => ["id", "type", "content", "summary", "encrypted_content"].includes(key)), "E2E_TEXT_REPLAY_REASONING_SHAPE");
    requireValue((item.content === undefined || (Array.isArray(item.content) && item.content.length === 0)) &&
      (item.summary === undefined || (Array.isArray(item.summary) && item.summary.length === 0)), "E2E_TEXT_REPLAY_VISIBLE_REASONING");
    requireValue((item.id === undefined || typeof item.id === "string") &&
      (item.encrypted_content === undefined || typeof item.encrypted_content === "string"), "E2E_TEXT_REPLAY_REASONING_SHAPE");
    removed = true;
    return false;
  });
  const projected = !removed || typeof visible === "string" ? visible : visible.map(item => {
    if (!object(item) || item.type !== "function_call") return item;
    const { id: _nativePairingId, ...completeCall } = item;
    return completeCall;
  });
  const result = JSON.stringify({ ...value, reasoning: { effort: "none" }, input: projected });
  requireValue(Buffer.byteLength(result) <= limit, "E2E_TEXT_REPLAY_TOO_LARGE");
  return result;
}

/** Only the fixed internal Responses destination is adapted; never an external provider URL. */
export function installOpenAiTextReplay(fetcher: typeof fetch = globalThis.fetch): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== "http://dal-model-gateway:8787/v1/responses") return fetcher(input, init);
    const request = new Request(input, init);
    requireValue(request.method === "POST", "E2E_TEXT_REPLAY_METHOD");
    const reader = request.body?.getReader();
    requireValue(reader, "E2E_TEXT_REPLAY_INPUT");
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        requireValue(size <= limit, "E2E_TEXT_REPLAY_TOO_LARGE");
        parts.push(next.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    let wire: string;
    try { wire = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)); }
    catch { throw new Error("E2E_TEXT_REPLAY_INVALID_UTF8"); }
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    return fetcher(request.url, { ...init, method: request.method, headers, body: projectOpenAiTextReplay(wire), signal: request.signal, redirect: request.redirect });
  };
}
