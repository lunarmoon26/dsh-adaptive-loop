import { installOpenAiTextReplay } from "./e2e-openai-text-replay.js";

// This module is a declared, image-bound Node preload, never loaded by the controller.
globalThis.fetch = installOpenAiTextReplay();
