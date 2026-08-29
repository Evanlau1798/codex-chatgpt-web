export const WEB_CONTRACT_COOLDOWN_MS = 2 * 60_000;

const capabilityKeys = [
  "authenticated",
  "temporary",
  "composer",
  "effort",
  "connector",
  "submitted",
  "finalProjection",
  "idle",
] as const;

export type WebContractCapture = Record<(typeof capabilityKeys)[number], boolean>;

export function responseHasFinalProjection(payload: unknown): boolean {
  const output = payload && typeof payload === "object" && !Array.isArray(payload)
    && Array.isArray((payload as { output?: unknown }).output)
    ? (payload as { output: unknown[] }).output
    : [];
  return output.some(item => item && typeof item === "object" && !Array.isArray(item)
    && Array.isArray((item as { content?: unknown }).content)
    && (item as { content: unknown[] }).content.some(part => part && typeof part === "object"
      && !Array.isArray(part) && (part as { type?: unknown }).type === "output_text"
      && typeof (part as { text?: unknown }).text === "string"
      && (part as { text: string }).text.trim().length > 0));
}

export function captureWebContract(source: Record<string, unknown>): WebContractCapture {
  return Object.fromEntries(capabilityKeys.map(key => {
    if (typeof source[key] !== "boolean") throw new Error(`Web contract capability ${key} is missing`);
    return [key, source[key]];
  })) as WebContractCapture;
}

export function deriveWebContractCapabilities(evidence: {
  session: { authenticated: boolean; temporary: boolean; composer: boolean; solAvailable?: boolean };
  connectorVerified: boolean;
  responseAccepted: boolean;
  finalProjection: boolean;
  idle: boolean;
}): WebContractCapture {
  return captureWebContract({
    authenticated: evidence.session.authenticated,
    temporary: evidence.session.temporary,
    composer: evidence.session.composer,
    effort: evidence.session.solAvailable === true,
    connector: evidence.connectorVerified,
    submitted: evidence.responseAccepted,
    finalProjection: evidence.finalProjection,
    idle: evidence.idle,
  });
}

export function assertWebContractCooldown(lastRunAt: number | undefined, now = Date.now()): void {
  if (lastRunAt !== undefined && now - lastRunAt < WEB_CONTRACT_COOLDOWN_MS) {
    throw new Error("Web contract smoke requires a two-minute cooldown between manual runs");
  }
}

export async function requestWebContractTurn(
  fetcher: (request: Request) => Promise<Response>,
  request: Request,
): Promise<{ status: "ok"; response: Response } | { status: "account-blocked"; httpStatus: 429 }> {
  const response = await fetcher(request);
  if (response.status === 429) return { status: "account-blocked", httpStatus: 429 };
  if (response.headers.get("content-type")?.includes("application/json")) {
    const payload = await response.clone().json().catch(() => undefined) as Record<string, unknown> | undefined;
    const error = payload?.error && typeof payload.error === "object" && !Array.isArray(payload.error)
      ? payload.error as Record<string, unknown>
      : undefined;
    if (error?.status === 429 || error?.code === "rate_limit_exceeded" || error?.code === "verification_limit") {
      return { status: "account-blocked", httpStatus: 429 };
    }
  }
  return { status: "ok", response };
}
