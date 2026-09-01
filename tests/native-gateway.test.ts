import { expect, test } from "bun:test";
import {
  execGatewayProgram,
  transportBoundRawExecProgram,
} from "../src/adapters/chatgpt-web/native-command";
import {
  assertGatewayToolArguments,
  gatewayToolCatalogPage,
  gatewayToolCatalogProgram,
} from "../src/adapters/chatgpt-web/mcp-gateway";

async function execute(program: string, names: string[], calls: Array<{ name: string; input: unknown }>) {
  const tools = Object.fromEntries(names.map(name => [name, async (input: unknown) => {
    calls.push({ name, input });
    return { content: [{ type: "text", text: name }] };
  }]));
  const emitted: unknown[] = [];
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
  ) => (...values: unknown[]) => Promise<void>;
  await new AsyncFunction("tools", "ALL_TOOLS", "text", "image", "audio", "generatedImage", program)(
    tools,
    names.map(name => ({ name, description: `${name} description` })),
    (value: unknown) => emitted.push({ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }),
    () => {}, () => {}, () => {},
  );
  return emitted;
}

test("nested gateway inventory is paginated and rejects hidden outer tools", async () => {
  const emitted = await execute(gatewayToolCatalogProgram({
    query: "agent", offset: 0, limit: 20, excludedNames: ["exec"],
  }), ["exec", "multi_agent_v2__wait_agent", "vendor__agent_status"], []);
  const catalog = gatewayToolCatalogPage({ content: emitted }, new Set(["exec"]));
  expect(catalog.total).toBe(2);
  expect(catalog.tools.map(tool => tool.name)).toEqual([
    "multi_agent_v2__wait_agent", "vendor__agent_status",
  ]);
});

test("structured nested gateway validates availability and fixed wait polling", async () => {
  expect(() => assertGatewayToolArguments("multi_agent_v2__wait_agent", {
    targets: [], timeout_ms: 180_000,
  })).toThrow("timeout_ms=10000");
  const calls: Array<{ name: string; input: unknown }> = [];
  await execute(execGatewayProgram("multi_agent_v2__wait_agent", false, {
    arguments: { targets: [], timeout_ms: 10_000 },
  }, ["exec"]), ["multi_agent_v2__wait_agent"], calls);
  expect(calls).toEqual([{
    name: "multi_agent_v2__wait_agent", input: { targets: [], timeout_ms: 10_000 },
  }]);
  expect(() => execGatewayProgram("exec", true, { input: "text('recursive')" }, ["exec"]))
    .toThrow("not available");
});

test("raw exec proxy blocks recursion and enforces wait_agent polling without hiding other tools", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  await expect(execute(transportBoundRawExecProgram(
    "await tools.multi_agent_v1__wait_agent({ targets: [], timeout_ms: 180000 });", "exec",
  ), ["exec", "multi_agent_v1__wait_agent"], calls)).rejects.toThrow("timeout_ms=10000");
  await expect(execute(transportBoundRawExecProgram(
    "await tools.exec(\"text('nested')\");", "exec",
  ), ["exec"], calls)).rejects.toThrow("Nested raw exec is unavailable");
  await execute(transportBoundRawExecProgram(
    "await tools.vendor__exec({ task: 'safe' });", "exec",
  ), ["exec", "vendor__exec"], calls);
  expect(calls).toEqual([{ name: "vendor__exec", input: { task: "safe" } }]);
});
