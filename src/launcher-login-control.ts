import { timingSafeEqual } from "node:crypto";
import { stdin } from "node:process";
import { readLauncherBrowserHostDescriptor } from "./launcher-browser-host";

export function authorizeLauncherControl(operation: string): void {
  const descriptorPath = process.env.CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR?.trim();
  const supplied = process.env.CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN?.trim();
  delete process.env.CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN;
  if (!descriptorPath || !supplied) {
    throw new Error(`Launcher-controlled ${operation} requires a live launcher authorization`);
  }
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const expectedBytes = Buffer.from(descriptor.control.token);
  const suppliedBytes = Buffer.from(supplied);
  if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
    throw new Error(`Launcher-controlled ${operation} authorization is invalid`);
  }
}

export function launcherLoginContinuation(): { promise: Promise<void>; close: () => void } {
  const maxBytes = 1_024;
  let buffered = "";
  let bytes = 0;
  let settled = false;
  let resolveContinuation!: () => void;
  let rejectContinuation!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveContinuation = resolve;
    rejectContinuation = reject;
  });
  const cleanup = () => {
    stdin.off("data", onData);
    stdin.off("end", onEnd);
    stdin.pause();
  };
  const fail = (message: string) => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectContinuation(new Error(message));
  };
  const onData = (chunk: Buffer | string) => {
    if (settled) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > maxBytes) {
      fail("Launcher passkey control message is too large");
      return;
    }
    buffered += data.toString("utf8");
    const newline = buffered.indexOf("\n");
    if (newline < 0) return;
    const line = buffered.slice(0, newline);
    if (buffered.slice(newline + 1).trim()) {
      fail("Launcher passkey control sent unexpected trailing data");
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      fail("Launcher passkey control sent invalid JSON");
      return;
    }
    if (!message || typeof message !== "object"
      || (message as { version?: unknown }).version !== 1
      || (message as { type?: unknown }).type !== "passkey-login-continue") {
      fail("Launcher passkey control sent an invalid continuation message");
      return;
    }
    settled = true;
    cleanup();
    resolveContinuation();
  };
  const onEnd = () => fail("Launcher closed the passkey control channel before Continue");
  stdin.on("data", onData);
  stdin.once("end", onEnd);
  stdin.resume();
  return {
    promise,
    close: () => {
      if (settled) return;
      settled = true;
      cleanup();
    },
  };
}
