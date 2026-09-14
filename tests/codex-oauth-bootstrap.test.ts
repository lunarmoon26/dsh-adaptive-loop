import { PassThrough, Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apply, CODEX_KEY, resolveTimeout, runBootstrap } from "../plugins/dal-codex-oauth/src/index.js";
import { terminalIo } from "../plugins/dal-codex-oauth/src/terminal.js";
import { verifyLoginApproval } from "../plugins/dal-codex-oauth/src/approval.js";
import type { Authorization, BootstrapIo } from "../plugins/dal-codex-oauth/src/types.js";

vi.mock("../plugins/dal-codex-oauth/src/approval.js", () => ({
  verifyLoginApproval: vi.fn(async () => {}),
}));

vi.mock("../plugins/dal-codex-oauth/src/terminal.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../plugins/dal-codex-oauth/src/terminal.js")>();
  return { ...actual, terminalIo: vi.fn(actual.terminalIo) };
});

// chg-codex-oauth-bootstrap-tests-20260913: fixed-route, private, cancellable,
// launcher-owned source behavior; all authorization material below is synthetic.
const placeholder = "TEST_ONLY_PROVIDER_SECRET";
function fixture(interactive = true) {
  const auth = {
    describe: vi.fn<Authorization["describe"]>(() => ({ methods: [{ id: "api-key" }, { id: "oauth" }], inFlight: false })),
    begin: vi.fn<Authorization["begin"]>(async () => ({ status: "authorized" })),
  };
  const io = {
    interactive,
    write: vi.fn<BootstrapIo["write"]>(),
    interaction: vi.fn<BootstrapIo["interaction"]>(() => ({ notify: vi.fn(), prompt: vi.fn() })),
  };
  const controller = new AbortController();
  const verifyLogin = vi.fn(async () => {});
  const run = (args = ["--oauth-login"]) => runBootstrap(auth, args, io, controller, 1000, verifyLogin);
  return { auth, io, controller, verifyLogin, run };
}

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("runBootstrap", () => {
  it("uses only the fixed Codex key and explicit OAuth method", async () => {
    const f = fixture();
    expect(CODEX_KEY).toBe("llm-pi-ai/openai-codex");
    expect(await f.run()).toBe(0);
    expect(f.verifyLogin).toHaveBeenCalledExactlyOnceWith();
    expect(f.verifyLogin.mock.invocationCallOrder[0]).toBeLessThan(f.auth.begin.mock.invocationCallOrder[0]!);
    expect(f.auth.describe).toHaveBeenCalledExactlyOnceWith(CODEX_KEY);
    expect(f.auth.begin).toHaveBeenCalledExactlyOnceWith({ key: CODEX_KEY, method: "oauth", signal: f.controller.signal,
      interaction: f.io.interaction.mock.results[0]!.value });
    expect(f.io.write).toHaveBeenCalledWith(expect.stringContaining("DAL_CODEX_OAUTH_AUTHORIZED"));
  });

  it.each([true, false])("check never begins login (interactive=%s)", async interactive => {
    const f = fixture(interactive);
    expect(await f.run(["--oauth-check"])).toBe(0);
    expect(f.auth.describe).toHaveBeenCalledExactlyOnceWith(CODEX_KEY);
    expect(f.auth.begin).not.toHaveBeenCalled();
    expect(f.io.interaction).not.toHaveBeenCalled();
    expect(f.verifyLogin).not.toHaveBeenCalled();
    expect(f.io.write).toHaveBeenCalledWith(expect.stringContaining("authentication has NOT been checked"));
  });

  it("help succeeds without consulting authorization", async () => {
    const f = fixture(false);
    expect(await f.run(["--help"])).toBe(0);
    expect(f.auth.describe).not.toHaveBeenCalled();
    expect(f.auth.begin).not.toHaveBeenCalled();
    expect(f.verifyLogin).not.toHaveBeenCalled();
    expect(f.io.write).toHaveBeenCalledWith(expect.stringContaining("--oauth-check"));
  });

  it.each([[], ["--check"], ["--login"], ["--oauth-login", "--provider=other"], ["--oauth-login", "--method=api-key"], ["--help", "extra"]].map(args => ({ args })))("rejects usage $args before authorization", async ({ args }) => {
    const f = fixture();
    expect(await f.run(args)).toBe(2);
    expect(f.io.write).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    expect(f.auth.describe).not.toHaveBeenCalled();
    expect(f.auth.begin).not.toHaveBeenCalled();
  });

  it.each(["--oauth-check", "--oauth-login"])("%s rejects missing and API-only flows", async flag => {
    for (const flow of [undefined, { methods: [], inFlight: false }, { methods: [{ id: "api-key" }], inFlight: false }]) {
      const f = fixture();
      f.auth.describe.mockReturnValue(flow);
      expect(await f.run([flag])).toBe(1);
      expect(f.io.write).toHaveBeenCalledExactlyOnceWith("DAL_CODEX_OAUTH_NO_NATIVE_FLOW");
      expect(f.auth.begin).not.toHaveBeenCalled();
    }
  });

  it("requires a TTY for login", async () => {
    const f = fixture(false);
    expect(await f.run()).toBe(2);
    expect(f.io.write).toHaveBeenCalledWith(expect.stringContaining("TTY_REQUIRED"));
    expect(f.auth.begin).not.toHaveBeenCalled();
    expect(f.verifyLogin).not.toHaveBeenCalled();
  });

  // chg-codex-oauth-approval-tests-20260913: verification is an operation-time gate.
  it.each(["missing", "denied", "throwing"])("refuses %s approval without echoing error details", async kind => {
    const f = fixture();
    if (kind === "denied") f.verifyLogin.mockRejectedValue(Object.assign(new Error(placeholder), {
      stdout: placeholder, stderr: placeholder,
    }));
    if (kind === "throwing") f.verifyLogin.mockImplementation(() => { throw new Error(placeholder); });
    expect(await runBootstrap(f.auth, ["--oauth-login"], f.io, f.controller, 1000,
      kind === "missing" ? undefined : f.verifyLogin)).toBe(1);
    expect(f.auth.begin).not.toHaveBeenCalled();
    expect(f.io.interaction).not.toHaveBeenCalled();
    expect(f.io.write).toHaveBeenCalledExactlyOnceWith(
      "DAL_CODEX_OAUTH_APPROVAL_REQUIRED: missing, invalid, expired or drifted approval; login was not started.");
    expect(JSON.stringify(f.io.write.mock.calls)).not.toContain(placeholder);
  });

  it.each([false, true])("waits for verification before login (abort=%s)", async abort => {
    const f = fixture();
    let verified!: () => void;
    f.verifyLogin.mockImplementation(() => new Promise<void>(resolve => { verified = resolve; }));
    const result = f.run();
    expect(f.verifyLogin).toHaveBeenCalledOnce();
    expect(f.auth.begin).not.toHaveBeenCalled();
    expect(f.io.interaction).not.toHaveBeenCalled();
    if (abort) f.controller.abort();
    verified();
    expect(await result).toBe(abort ? 130 : 0);
    expect(f.auth.begin).toHaveBeenCalledTimes(abort ? 0 : 1);
    if (abort) expect(f.io.interaction).not.toHaveBeenCalled();
  });

  it.each(["--oauth-check", "--help", "--oauth-login"])("%s needs no approval outside interactive login", async flag => {
    const f = fixture(false);
    expect(await runBootstrap(f.auth, [flag], f.io, f.controller, 1000)).toBe(flag === "--oauth-login" ? 2 : 0);
    expect(f.auth.begin).not.toHaveBeenCalled();
  });

  it("refuses an in-flight login but permits readiness checks", async () => {
    const f = fixture();
    f.auth.describe.mockReturnValue({ methods: [{ id: "oauth" }], inFlight: true });
    expect(await f.run()).toBe(1);
    expect(f.io.write).toHaveBeenCalledWith("DAL_CODEX_OAUTH_BUSY");
    expect(await f.run(["--oauth-check"])).toBe(0);
    expect(f.auth.begin).not.toHaveBeenCalled();
  });

  it("does not infer success from a cancelled outcome", async () => {
    const f = fixture();
    f.auth.begin.mockResolvedValue({ status: "cancelled" });
    expect(await f.run()).toBe(130);
    expect(f.io.write).toHaveBeenCalledExactlyOnceWith("DAL_CODEX_OAUTH_CANCELLED");
  });

  it("redacts thrown provider errors", async () => {
    const f = fixture();
    f.auth.begin.mockRejectedValue(new Error(placeholder));
    expect(await f.run()).toBe(1);
    expect(f.io.write).toHaveBeenCalledExactlyOnceWith("DAL_CODEX_OAUTH_FAILED: native login failed; no provider error details were logged.");
    expect(JSON.stringify(f.io.write.mock.calls)).not.toContain(placeholder);
  });

  it("does not begin when already aborted", async () => {
    const f = fixture();
    f.controller.abort();
    expect(await f.run()).toBe(130);
    expect(f.auth.begin).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"])("cancels an active attempt (%s) and clears its timer", async settlement => {
    vi.useFakeTimers();
    const f = fixture();
    f.auth.begin.mockImplementation(({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => settlement === "resolve" ? resolve({ status: "authorized" }) : reject(new Error(placeholder)), { once: true });
    }));
    const result = f.run();
    await Promise.resolve();
    f.io.interaction.mock.calls[0]![1]();
    expect(await result).toBe(130);
    expect(f.controller.signal.aborted).toBe(true);
    expect(f.io.write).toHaveBeenCalledExactlyOnceWith("DAL_CODEX_OAUTH_CANCELLED");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["resolve", "reject"])("times out an active attempt (%s) without leaking details", async settlement => {
    vi.useFakeTimers();
    const f = fixture();
    f.auth.begin.mockImplementation(({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => settlement === "resolve" ? resolve({ status: "authorized" }) : reject(new Error(placeholder)), { once: true });
    }));
    const result = f.run();
    await vi.advanceTimersByTimeAsync(999);
    expect(f.controller.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(124);
    expect(f.controller.signal.aborted).toBe(true);
    expect(f.io.write).toHaveBeenCalledExactlyOnceWith("DAL_CODEX_OAUTH_TIMEOUT");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["authorized", "cancelled", "failed"])("clears the deadline after %s", async status => {
    vi.useFakeTimers();
    const f = fixture();
    if (status === "failed") f.auth.begin.mockRejectedValue(new Error(placeholder));
    else f.auth.begin.mockResolvedValue({ status: status as "authorized" | "cancelled" });
    await f.run();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.controller.signal.aborted).toBe(false);
  });
});

describe("timeout configuration", () => {
  it("defaults to five minutes and accepts inclusive bounds", () => {
    expect(resolveTimeout({})).toBe(300_000);
    expect(resolveTimeout({ timeoutMs: 1000 })).toBe(1000);
    expect(resolveTimeout({ timeoutMs: 600_000 })).toBe(600_000);
  });
  it.each([0, -1, 999, 600_001, 1000.5, NaN, Infinity, -Infinity])("rejects %s", timeoutMs => {
    expect(() => resolveTimeout({ timeoutMs })).toThrow("must be an integer between 1000 and 600000");
  });
});

async function tty(raw = true) {
  const actual = await vi.importActual<typeof import("../plugins/dal-codex-oauth/src/terminal.js")>("../plugins/dal-codex-oauth/src/terminal.js");
  const input = Object.assign(new PassThrough(), { isTTY: true, ...(raw ? { setRawMode: vi.fn() } : {}) });
  let printed = "";
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) { printed += chunk.toString(); done(); } }), { isTTY: true });
  const controller = new AbortController();
  const cancel = vi.fn(() => controller.abort());
  const io = actual.terminalIo(input, output);
  const interaction = io.interaction(controller.signal, cancel);
  // Node retains one stream-level keypress decoder after readline.close().
  // Prime it before measuring prompt-owned listener cleanup.
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const primer = createInterface({ input, output: muted, terminal: true });
  primer.close();
  muted.destroy();
  const baseline = { data: input.listenerCount("data"), end: input.listenerCount("end"), keypress: input.listenerCount("keypress") };
  return { input, output, controller, cancel, io, interaction, printed: () => printed,
    clean: () => {
      expect(input.listenerCount("data")).toBe(baseline.data);
      expect(input.listenerCount("end")).toBe(baseline.end);
      expect(input.listenerCount("keypress")).toBe(baseline.keypress);
      if (input.setRawMode) expect(input.setRawMode).toHaveBeenLastCalledWith(false);
    },
    dispose: () => { controller.abort(); input.destroy(); output.destroy(); } };
}

describe("terminalIo with synthetic streams", () => {
  it.each([true, false])("requires both TTY flags (input=%s)", async inputTTY => {
    const t = await tty();
    try {
      t.input.isTTY = inputTTY;
      const actual = await vi.importActual<typeof import("../plugins/dal-codex-oauth/src/terminal.js")>("../plugins/dal-codex-oauth/src/terminal.js");
      for (const outputTTY of [true, false]) {
        t.output.isTTY = outputTTY;
        expect(actual.terminalIo(t.input, t.output).interactive).toBe(inputTTY && outputTTY);
      }
    } finally { t.dispose(); }
  });

  it.each(["text", "secret"] as const)("never echoes %s input or provider prompt details", async kind => {
    const t = await tty();
    try {
      const answer = t.interaction.prompt({ kind, message: placeholder, placeholder });
      const typed = "http://localhost/callback?code=TEST_ONLY_CALLBACK";
      t.input.write(typed + "\r");
      expect(await answer).toBe(typed);
      expect(t.printed()).toBe("Paste the browser authorization response (input hidden; Ctrl+C cancels): \n");
      expect(t.cancel).not.toHaveBeenCalled();
      t.clean();
    } finally { t.dispose(); }
  });

  it("supports synthetic TTY input without setRawMode", async () => {
    const t = await tty(false);
    try {
      const answer = t.interaction.prompt({ kind: "text", message: placeholder });
      t.input.write("TEST_ONLY_RESPONSE\n");
      expect(await answer).toBe("TEST_ONLY_RESPONSE");
      expect(t.printed()).not.toContain("TEST_ONLY_RESPONSE");
      t.clean();
    } finally { t.dispose(); }
  });

  it("displays sanitized labels and maps a selected number to its opaque ID", async () => {
    const t = await tty();
    try {
      const answer = t.interaction.prompt({ kind: "select", message: placeholder, options: [
        { id: "TEST_ONLY_FIRST", label: "Browser\n\u0007", description: placeholder },
        { id: "TEST_ONLY_SECOND", label: "Device", description: placeholder },
      ] });
      t.input.write("2\r");
      expect(await answer).toBe("TEST_ONLY_SECOND");
      expect(t.printed()).toBe("1. Browser\n2. Device\nSelect an option number (input hidden): \n");
      t.clean();
    } finally { t.dispose(); }
  });

  it.each(["0", "3", "1.5", "no", ""])("rejects invalid selection %j and releases the prompt", async value => {
    const t = await tty();
    try {
      const answer = t.interaction.prompt({ kind: "select", message: placeholder, options: [{ id: "one", label: "One" }] });
      const rejected = expect(answer).rejects.toThrow("INVALID_AUTH_SELECTION");
      t.input.write(value + "\r");
      await rejected;
      t.clean();
      expect(t.cancel).not.toHaveBeenCalled();
    } finally { t.dispose(); }
  });

  it.each(["not a URL", "http://auth.openai.com/TEST_ONLY", "https://evil.example/TEST_ONLY", "https://auth.openai.com.evil.example/TEST_ONLY", "https://user:TEST_ONLY@auth.openai.com/", "https://chatgpt.com:444/TEST_ONLY", "javascript:TEST_ONLY"])("rejects unsafe notice URL %s without provider details", async url => {
    const t = await tty();
    try {
      t.interaction.notify({ message: placeholder, url, code: placeholder });
      expect(t.cancel).toHaveBeenCalledOnce();
      expect(t.controller.signal.aborted).toBe(true);
      expect(t.printed()).not.toContain(placeholder);
      expect(t.printed()).not.toContain(url);
      expect(["", "DAL_CODEX_OAUTH_UNSAFE_NOTICE\n"]).toContain(t.printed());
    } finally { t.dispose(); }
  });

  it.each(["https://auth.openai.com/authorize?state=TEST_ONLY", "https://chatgpt.com/device"])("displays an allowed browser URL %s and safe device code only", async url => {
    const t = await tty();
    try {
      t.interaction.notify({ message: placeholder, url, code: "TEST-1234" });
      expect(t.printed()).toBe(`Open this authorization URL in your browser:\n${url}\nVerification code: TEST-1234\n`);
      expect(t.cancel).not.toHaveBeenCalled();
    } finally { t.dispose(); }
  });

  it("suppresses arbitrary messages and unsafe device codes, and ignores notices after abort", async () => {
    const t = await tty();
    try {
      t.interaction.notify({ message: placeholder + "\u001b[31m", code: placeholder });
      expect(t.printed()).toBe("Waiting for Codex authorization…\n");
      t.interaction.notify({ message: placeholder, url: "https://chatgpt.com/device", code: placeholder + "\n" });
      expect(t.printed()).not.toContain(placeholder);
      const before = t.printed();
      t.controller.abort();
      t.interaction.notify({ message: placeholder, url: "https://chatgpt.com/device" });
      expect(t.printed()).toBe(before);
    } finally { t.dispose(); }
  });

  it.each(["parent abort", "EOF", "Ctrl+C"])("cleans up after %s", async action => {
    const t = await tty();
    try {
      const answer = t.interaction.prompt({ kind: "secret", message: placeholder });
      const rejected = expect(answer).rejects.toMatchObject({ name: "AbortError" });
      if (action === "parent abort") t.controller.abort();
      else if (action === "EOF") t.input.end();
      else t.input.write("\u0003");
      await rejected;
      expect(t.controller.signal.aborted).toBe(true);
      if (action !== "parent abort") expect(t.cancel).toHaveBeenCalledOnce();
      expect(t.printed()).not.toContain(placeholder);
      t.clean();
    } finally { t.dispose(); }
  });

  it("withdraws a losing browser prompt without cancelling the whole attempt", async () => {
    const t = await tty();
    try {
      const browserPrompt = new AbortController();
      const answer = t.interaction.prompt({ kind: "text", message: placeholder, signal: browserPrompt.signal });
      const rejected = expect(answer).rejects.toMatchObject({ name: "AbortError" });
      browserPrompt.abort();
      await rejected;
      expect(t.cancel).not.toHaveBeenCalled();
      expect(t.controller.signal.aborted).toBe(false);
      t.clean();
      const next = t.interaction.prompt({ kind: "secret", message: placeholder });
      t.input.write("TEST_ONLY_NEXT\r");
      expect(await next).toBe("TEST_ONLY_NEXT");
      expect(t.printed()).not.toContain("TEST_ONLY_NEXT");
      t.clean();
    } finally { t.dispose(); }
  });

  it("rejects concurrent prompts without disturbing the active prompt", async () => {
    const t = await tty();
    try {
      const first = t.interaction.prompt({ kind: "text", message: placeholder });
      await expect(t.interaction.prompt({ kind: "secret", message: placeholder })).rejects.toThrow("CONCURRENT_AUTH_PROMPT");
      t.input.write("TEST_ONLY_FIRST\r");
      expect(await first).toBe("TEST_ONLY_FIRST");
      t.clean();
    } finally { t.dispose(); }
  });

  it("allows native authorization success after the browser callback withdraws its prompt", async () => {
    const t = await tty();
    const f = fixture();
    try {
      f.auth.begin.mockImplementation(async ({ interaction, signal }) => {
        const callback = new AbortController();
        const prompt = interaction.prompt({ kind: "text", message: placeholder, signal: callback.signal });
        const withdrawn = expect(prompt).rejects.toMatchObject({ name: "AbortError" });
        callback.abort();
        await withdrawn;
        expect(signal.aborted).toBe(false);
        return { status: "authorized" };
      });
      expect(await runBootstrap(f.auth, ["--oauth-login"], t.io, t.controller, 1000, f.verifyLogin)).toBe(0);
      expect(t.printed()).toContain("DAL_CODEX_OAUTH_AUTHORIZED");
      expect(t.printed()).not.toContain(placeholder);
      expect(t.controller.signal.aborted).toBe(false);
      t.clean();
    } finally { t.dispose(); }
  });
});

function hostFixture(args = ["--oauth-check"]) {
  const f = fixture(false);
  let readyCallback: (() => void) | undefined;
  let dispose: (() => void) | undefined;
  const off = vi.fn();
  const exit = vi.fn();
  const services: Record<string, unknown> = {
    authorization: f.auth,
    appReady: { onReady: vi.fn((callback: () => void) => { readyCallback = callback; return off; }) },
    appExit: exit,
    cmdlineArgs: { get: vi.fn(() => args) },
  };
  const host = {
    get: vi.fn((key: string) => {
      if (!(key in services)) throw new Error(`Unexpected service: ${key}`);
      return services[key];
    }),
    effect: vi.fn((callback: () => () => void) => { dispose = callback(); }),
  };
  return { ...f, services, host, exit, off, ready: () => readyCallback!(), dispose: () => dispose?.(),
    apply: () => apply(host as unknown as Parameters<typeof apply>[0], { timeoutMs: 1000 }) };
}

describe("plugin apply launcher lifecycle", () => {
  afterEach(() => { vi.mocked(terminalIo).mockReset(); });

  it.each(["authorization", "appReady", "appExit", "cmdlineArgs"])("rejects missing %s before installing an effect", service => {
    const h = hostFixture();
    h.services[service] = undefined;
    expect(h.apply).toThrow("requires native authorization and the supported DSH launcher readiness/exit services");
    expect(h.host.effect).not.toHaveBeenCalled();
    expect(h.auth.begin).not.toHaveBeenCalled();
  });

  it.each([["--oauth-check", 0], ["--oauth-login", 2], ["--invalid", 2]] as const)("waits for readiness and exits through launcher for %s", async (arg, code) => {
    const h = hostFixture([arg]);
    vi.mocked(terminalIo).mockReturnValue(h.io);
    try {
      h.apply();
      expect(h.auth.describe).not.toHaveBeenCalled();
      expect(h.exit).not.toHaveBeenCalled();
      h.ready();
      await vi.waitFor(() => expect(h.exit).toHaveBeenCalledExactlyOnceWith(code));
      expect(h.host.get.mock.calls.map(([key]) => key)).toEqual(["authorization", "appReady", "appExit", "cmdlineArgs"]);
      expect(h.auth.begin).not.toHaveBeenCalled();
      expect(verifyLoginApproval).not.toHaveBeenCalled();
    } finally { h.dispose(); }
    expect(h.off).toHaveBeenCalledOnce();
  });

  it("redacts unexpected startup rejection and exits with failure", async () => {
    const h = hostFixture();
    vi.mocked(terminalIo).mockReturnValue(h.io);
    h.auth.describe.mockImplementation(() => { throw new Error(placeholder); });
    try {
      h.apply();
      h.ready();
      await vi.waitFor(() => expect(h.exit).toHaveBeenCalledExactlyOnceWith(1));
      expect(h.io.write).toHaveBeenCalledExactlyOnceWith("DAL_CODEX_OAUTH_STARTUP_FAILED");
    } finally { h.dispose(); }
  });

  it.each(["authorized", "cancelled", "failed"] as const)("forwards native login %s to the launcher exit", async status => {
    const h = hostFixture(["--oauth-login"]);
    h.io.interactive = true;
    vi.mocked(terminalIo).mockReturnValue(h.io);
    if (status === "failed") h.auth.begin.mockRejectedValue(new Error(placeholder));
    else h.auth.begin.mockResolvedValue({ status });
    try {
      h.apply();
      h.ready();
      await vi.waitFor(() => expect(h.exit).toHaveBeenCalledExactlyOnceWith(status === "authorized" ? 0 : status === "cancelled" ? 130 : 1));
      expect(h.auth.begin).toHaveBeenCalledOnce();
      expect(verifyLoginApproval).toHaveBeenCalledExactlyOnceWith({ timeoutMs: 1000 });
      expect(vi.mocked(verifyLoginApproval).mock.invocationCallOrder[0]).toBeLessThan(h.auth.begin.mock.invocationCallOrder[0]!);
      expect(JSON.stringify(h.io.write.mock.calls)).not.toContain(placeholder);
    } finally { h.dispose(); }
  });

  it("disposal aborts pending authorization, unsubscribes and suppresses late exit", async () => {
    vi.useFakeTimers();
    const h = hostFixture(["--oauth-login"]);
    h.io.interactive = true;
    vi.mocked(terminalIo).mockReturnValue(h.io);
    let signal: AbortSignal | undefined;
    h.auth.begin.mockImplementation(request => {
      signal = request.signal;
      return new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new Error(placeholder)), { once: true }));
    });
    h.apply();
    h.ready();
    await Promise.resolve();
    expect(signal?.aborted).toBe(false);
    h.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(signal?.aborted).toBe(true);
    expect(h.off).toHaveBeenCalledOnce();
    expect(h.exit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(JSON.stringify(h.io.write.mock.calls)).not.toContain(placeholder);
  });

  it("suppresses an already queued successful exit after disposal", async () => {
    const h = hostFixture();
    vi.mocked(terminalIo).mockReturnValue(h.io);
    h.apply();
    h.ready();
    h.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.off).toHaveBeenCalledOnce();
  });
});
