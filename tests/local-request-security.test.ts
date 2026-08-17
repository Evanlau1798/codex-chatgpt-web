import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { startServer } from "../src/server";

const dataRoutes = ["/v1/responses", "/v1/messages", "/v1/responses/compact"] as const;

async function withServer(run: (endpoint: string) => Promise<void>): Promise<void> {
  const server = startServer({ ...defaultConfig("browser-only"), port: 0 });
  try {
    await run(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.stop(true);
  }
}

test("rejects cross-site browser requests before parsing public data-route bodies", async () => {
  await withServer(async endpoint => {
    for (const path of dataRoutes) {
      const response = await fetch(`${endpoint}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
        body: "not-json",
      });
      expect(response.status).toBe(403);
    }
  });
});

test("rejects non-loopback or wrong-port browser origins on public data routes", async () => {
  await withServer(async endpoint => {
    const port = new URL(endpoint).port;
    for (const path of dataRoutes) {
      const foreign = await fetch(`${endpoint}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: `https://attacker.example:${port}` },
        body: "not-json",
      });
      expect(foreign.status).toBe(403);

      const wrongPort = await fetch(`${endpoint}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:1" },
        body: "not-json",
      });
      expect(wrongPort.status).toBe(403);
    }
  });
});

test("requires a JSON media type on public data routes", async () => {
  await withServer(async endpoint => {
    for (const path of dataRoutes) {
      const response = await fetch(`${endpoint}${path}`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "not-json",
      });
      expect(response.status).toBe(415);
    }
  });
});

test("preserves CLI compatibility without browser metadata and accepts loopback origins", async () => {
  await withServer(async endpoint => {
    const port = new URL(endpoint).port;
    const requests = [
      new Headers({ "content-type": "application/vnd.codex+json" }),
      new Headers({ "content-type": "application/json", origin: `http://localhost:${port}` }),
      new Headers({ "content-type": "application/json", origin: `http://[::1]:${port}` }),
    ];
    for (const headers of requests) {
      const response = await fetch(`${endpoint}/v1/responses`, {
        method: "POST",
        headers,
        body: "not-json",
      });
      expect(response.status).toBe(400);
    }
  });
});
