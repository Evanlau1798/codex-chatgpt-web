export type LauncherTurnStartResult = {
  surfaceId: string;
  reused: boolean;
  promptMode: "full" | "resume" | "refresh";
  connectorBound?: true;
};

export function parseLauncherTurnStart(
  body: Record<string, unknown>,
  requiresSystemRefresh: boolean,
): LauncherTurnStartResult {
  if (typeof body.surfaceId !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(body.surfaceId)) {
    throw new Error("Launcher browser control channel returned an invalid turn surface id");
  }
  if (body.reused !== undefined && typeof body.reused !== "boolean") {
    throw new Error("Launcher browser control channel returned an invalid reuse state");
  }
  const explicit = body.promptMode === "full" || body.promptMode === "resume" || body.promptMode === "refresh"
    ? body.promptMode : undefined;
  if (requiresSystemRefresh && !explicit) {
    throw new Error("Launcher browser control channel does not support retained system refresh");
  }
  const promptMode = explicit ?? (typeof body.reused === "boolean" ? (body.reused ? "resume" : "full") : undefined);
  if (!promptMode) throw new Error("Launcher browser control channel returned an invalid prompt mode");
  if (body.connectorBound !== undefined && typeof body.connectorBound !== "boolean") {
    throw new Error("Launcher browser control channel returned an invalid connector state");
  }
  return {
    surfaceId: body.surfaceId,
    reused: body.reused === true,
    promptMode,
    ...(body.connectorBound === true ? { connectorBound: true as const } : {}),
  };
}
