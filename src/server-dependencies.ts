import type { ProviderAdapter } from "./adapters/base";
import type { NativeCodexTurnIdentity } from "./http-turn-counter";
import type { NativeFetch } from "./native-passthrough";
import type { AdapterEvent, CodexProviderConfig } from "./types";

export type ChatGptWebAdapterFactory = (provider: CodexProviderConfig) => ProviderAdapter;

export interface ResponseRequestOptions {
  /** DEV and other in-process harnesses can keep continuation state in their own canonical store. */
  rememberState?: boolean;
  /** Observe the exact production adapter stream when invoking the handler in-process. */
  onAdapterEvent?: (event: AdapterEvent) => void;
  onTurnIdentity?: (identity: NativeCodexTurnIdentity) => void;
}

export interface ServerDependencies {
  /** Testable general-client wire boundary; production uses the existing restricted Web worker. */
  chatCompletionExecutor?: import("./chat-completions/runtime").ChatCompletionExecutor;
  fetchUpstream?: NativeFetch;
  adapterFactory?: ChatGptWebAdapterFactory;
}
