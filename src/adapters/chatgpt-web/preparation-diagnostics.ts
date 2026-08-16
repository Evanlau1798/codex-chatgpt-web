import type { CodexParsedRequest } from "../../types";

type PreparationSource = "full" | "resume";

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function diagnosticValue(value: string, maxChars = 512): string {
  const oneLine = value.replace(/[\r\n\u2028\u2029]+/g, " ");
  return JSON.stringify(oneLine.slice(0, maxChars));
}

export function chatGptErrorDiagnosticIdentity(error: unknown): string {
  const failure = asError(error);
  const errorCode = (failure as Error & { code?: unknown }).code;
  return `errorName=${diagnosticValue(failure.name, 128)}`
    + ` errorCode=${diagnosticValue(typeof errorCode === "string" ? errorCode : "none", 128)}`;
}

export function reportChatGptPreparationFailure(
  traceId: string,
  source: PreparationSource,
  input: CodexParsedRequest,
  error: unknown,
): Error {
  const failure = asError(error);
  console.error(
    `[chatgpt-web] browser turn ${traceId} stage=prompt_preparation source=${source} failed`
    + ` ${chatGptErrorDiagnosticIdentity(failure)}`
    + ` errorMessage=${diagnosticValue(failure.message)}`
    + ` systemItems=${input.context.systemPrompt?.length ?? 0}`
    + ` messages=${input.context.messages.length}`
    + ` tools=${input.context.tools?.length ?? 0}`
    + ` canonicalComplete=${input._canonicalContextComplete === true}`,
  );
  return failure;
}
