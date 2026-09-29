import type { ApiClient } from "./api.js";
import type { Output } from "./output.js";
import type { StateStore } from "./state.js";

export interface CommandContext {
  repository: string;
  api: ApiClient;
  state: StateStore;
  out: Output;
  signal: AbortSignal;
}
