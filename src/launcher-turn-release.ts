export function parseLauncherTurnRelease(body: Record<string, unknown>): {
  cancelledByUser: boolean;
  authenticationBlocked?: boolean;
  authenticationStatus?: "authenticated" | "signed-out" | "unknown";
} {
  if (typeof body.cancelledByUser !== "boolean") {
    throw new Error("Launcher browser control channel returned an invalid turn release result");
  }
  if (body.authenticationBlocked !== undefined && typeof body.authenticationBlocked !== "boolean") {
    throw new Error("Launcher browser control channel returned an invalid authentication state");
  }
  if (body.authenticationStatus !== undefined
    && (body.authenticationBlocked !== true || !["authenticated", "signed-out", "unknown"].includes(body.authenticationStatus as string))) {
    throw new Error("Launcher browser control channel returned invalid authentication evidence");
  }
  return { cancelledByUser: body.cancelledByUser, ...(body.authenticationBlocked === true ? {
    authenticationBlocked: true,
    authenticationStatus: (body.authenticationStatus ?? "unknown") as "authenticated" | "signed-out" | "unknown",
  } : {}) };
}
