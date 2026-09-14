/** Structural mirrors of the public DSH authorization seam; never a grant type. */
export interface Notice {
  message: string;
  url?: string;
  code?: string;
}

export type Prompt = { signal?: AbortSignal } & (
  | { kind: "text" | "secret"; message: string; placeholder?: string }
  | { kind: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] }
);

export interface Interaction {
  notify(notice: Notice): void;
  prompt(prompt: Prompt): Promise<string>;
}

export interface Authorization {
  describe(key: string): { methods: readonly { id: string }[]; inFlight: boolean } | undefined;
  begin(request: { key: string; method: "oauth"; signal: AbortSignal; interaction: Interaction }): Promise<{ status: "authorized" | "cancelled" }>;
}

export interface BootstrapIo {
  interactive: boolean;
  write(message: string): void;
  interaction(signal: AbortSignal, cancel: () => void): Interaction;
}
