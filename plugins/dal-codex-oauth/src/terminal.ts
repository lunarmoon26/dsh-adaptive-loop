import { createInterface } from "node:readline/promises";
import type { Readable, Writable as WritableType } from "node:stream";
import { Writable } from "node:stream";
import type { BootstrapIo, Interaction, Prompt } from "./types.js";

type Input = Readable & { isTTY?: boolean };
type Output = WritableType & { isTTY?: boolean };

function text(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 256);
}

/** Real-terminal-only human interaction. Text responses are secrets too. */
export function terminalIo(input: Input = process.stdin, output: Output = process.stdout): BootstrapIo {
  return {
    interactive: input.isTTY === true && output.isTTY === true,
    write(message) { output.write(message + "\n"); },
    interaction(signal, cancel): Interaction {
      let pending = false;
      return {
        notify(notice) {
          if (signal.aborted) return;
          if (notice.url !== undefined) {
            let url: URL;
            try { url = new URL(notice.url); } catch { cancel(); return; }
            if (url.protocol !== "https:" || !["auth.openai.com", "chatgpt.com"].includes(url.hostname)
                || url.username !== "" || url.password !== "" || (url.port !== "" && url.port !== "443")) {
              output.write("DAL_CODEX_OAUTH_UNSAFE_NOTICE\n");
              cancel();
              return;
            }
            output.write("Open this authorization URL in your browser:\n" + url.href + "\n");
            if (notice.code !== undefined && /^[A-Z0-9-]{4,32}$/i.test(notice.code)) {
              output.write("Verification code: " + notice.code + "\n");
            }
          } else {
            // Do not echo arbitrary provider progress/error text.
            output.write("Waiting for Codex authorization…\n");
          }
        },
        async prompt(prompt: Prompt): Promise<string> {
          if (pending) throw new Error("CONCURRENT_AUTH_PROMPT");
          const questionSignal = AbortSignal.any([signal, ...(prompt.signal ? [prompt.signal] : [])]);
          questionSignal.throwIfAborted();
          pending = true;
          // A muted readline output suppresses terminal echo, history and typed
          // callback URLs even when the provider labels the prompt as plain text.
          const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
          const reader = createInterface({ input, output: muted, terminal: true, historySize: 0 });
          let finished = false;
          reader.on("SIGINT", cancel);
          reader.on("close", () => { if (!finished && !questionSignal.aborted) cancel(); });
          try {
            if (prompt.kind === "select") {
              prompt.options.forEach((option, index) => output.write(`${index + 1}. ${text(option.label)}\n`));
              output.write("Select an option number (input hidden): ");
            } else {
              output.write("Paste the browser authorization response (input hidden; Ctrl+C cancels): ");
            }
            const answer = await reader.question("", { signal: questionSignal });
            if (prompt.kind !== "select") return answer;
            const number = Number(answer.trim());
            if (!Number.isInteger(number) || number < 1 || number > prompt.options.length) {
              throw new Error("INVALID_AUTH_SELECTION");
            }
            return prompt.options[number - 1]!.id;
          } finally {
            finished = true;
            pending = false;
            reader.close();
            muted.destroy();
            output.write("\n");
          }
        },
      };
    },
  };
}
