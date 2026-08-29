import type { ProviderAdapter } from "./adapters/base";
import type { NativeFetch } from "./native-passthrough";
import type { AdapterEvent, CodexProviderConfig } from "./types";

export type ChatGptWebAdapterFactory = (provider: CodexProviderConfig) => ProviderAdapter;

export interface ResponseRequestOptions {
  /** DEV and other in-process harnesses can keep continuation state in their own canonical store. */
  rememberState?: boolean;
  /** Observe the exact production adapter stream when invoking the handler in-process. */
  onAdapterEvent?: (event: AdapterEvent) => void;
}

export interface ServerDependencies {
  fetchUpstream?: NativeFetch;
  adapterFactory?: ChatGptWebAdapterFactory;
}
