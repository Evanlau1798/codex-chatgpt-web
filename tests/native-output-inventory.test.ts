import { expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TurnBroker, callTurnBroker } from '../src/adapters/chatgpt-web/turn-broker';
import {
  armConnectorContractProbeFallback,
  discardConnectorContractProbeFallback,
  consumeConnectorContractProbeEvidence,
  discardConnectorContractProbeEvidence,
  NATIVE2_CONTRACT_REVISION,
} from '../src/adapters/chatgpt-web/connector-contract';
import { readNativeOutputControlInventory } from '../src/adapters/chatgpt-web/native-output-control';

test('real MCP recovery inventory describes final output without reopening work or mutating its fence', async () => {
  const socket = join(tmpdir(), `cgw-output-inventory-${process.pid}-${Date.now()}.sock`);
  const broker = TurnBroker.forSocket(socket);
  const environment = { cwd: process.cwd(), roots: [process.cwd()], writableRoots: [process.cwd()],
    sandboxPolicy: { type: 'dangerFullAccess' as const }, tools: [] };
  const token = await broker.register(environment, undefined, 'inventory-final', undefined, true);
  const disabled = await broker.register(environment);
  const client = new Client({ name: 'output-inventory-integration', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: ['src/cli.ts','mcp','--broker-socket',socket], cwd: process.cwd(), stderr: 'pipe' }));
    const gateway = await client.callTool({ name: 'codex_tool_inventory', arguments: { turn_token: token, query: 'codex_tool_call' } });
    expect(gateway.structuredContent).toMatchObject({ total: 1,
      tools: [{ name: 'codex_tool_call', kind: 'connector', invocation: 'attached_direct',
        parameters: { required: ['turn_token','wire_name'] } }] });
    const patchSchema = await client.callTool({ name: 'codex_tool_inventory', arguments: { turn_token: token, query: 'codex_apply_patch' } });
    const nativeTools = await client.listTools();
    const gatewayCatalog = (gateway.structuredContent as any).tools[0];
    const nativeGateway = nativeTools.tools.find(t => t.name === 'codex_tool_call')!;
    expect(gatewayCatalog.parameters.required).toEqual(nativeGateway.inputSchema.required);
    expect(gatewayCatalog.parameters.properties).toEqual(nativeGateway.inputSchema.properties);
    const nativePatch = nativeTools.tools.find(t => t.name === 'codex_apply_patch')!;
    const catalogPatch = (patchSchema.structuredContent as any).tools[0];
    expect(catalogPatch.invocation).toBe('attached_direct');
    expect(catalogPatch.parameters.required).toEqual(nativePatch.inputSchema.required);
    expect(catalogPatch.parameters.properties).toEqual(nativePatch.inputSchema.properties);
    for (const tool of nativeTools.tools) {
      const lookup = await client.callTool({ name: 'codex_tool_inventory', arguments: { turn_token: token, query: tool.name } });
      const descriptor = (lookup.structuredContent as any).tools[0];
      expect(descriptor.invocation).toBe('attached_direct');
      expect(descriptor.parameters.required).toEqual(tool.inputSchema.required);
      expect(descriptor.parameters.properties).toEqual(tool.inputSchema.properties);
    }
    const before = await broker.beginCompletionFence(token);
    expect(await broker.beginFinalizationOnly(token, before!)).toBe(true);
    const revision = await broker.beginCompletionFence(token);
    const probeNonce = '44444444444444444444444444444444';
    discardConnectorContractProbeEvidence(probeNonce);
    const probe = await client.callTool({ name: 'codex_tool_inventory', arguments: {
      turn_token: token,
      query: `__codex_contract_probe__:${NATIVE2_CONTRACT_REVISION}:${probeNonce}`,
      include_schema: false,
    } });
    expect(probe.structuredContent).toEqual({ tools: [], total: 0, next_offset: null });
    expect(consumeConnectorContractProbeEvidence(probeNonce, NATIVE2_CONTRACT_REVISION)).toBeTrue();
    const lookup = await client.callTool({ name: 'codex_tool_inventory', arguments: { turn_token: token, query: 'output' } });
    expect(lookup.isError).not.toBe(true);
    expect(lookup.structuredContent).toMatchObject({ total: 1, work_tools_closed: true,
      tools: [{ wire_name: 'codex.control.output', parameters: { properties: { kind: { enum: ['final'] } } } }] });
    expect(await broker.beginCompletionFence(token)).toBe(revision);
    const rejected = await client.callTool({ name: 'codex_exec', arguments: { turn_token: token, cmd: 'must-not-run' } });
    expect(rejected.isError).toBe(true);
    // Failed work claims still tombstone their activity ID to prevent delayed resurrection.
    const afterRejectedWork = await broker.beginCompletionFence(token);
    const exact = await client.callTool({ name: 'codex_tool_inventory', arguments: { turn_token: token, query: 'codex.control.output' } });
    expect(exact.isError).not.toBe(true);
    expect(await broker.beginCompletionFence(token)).toBe(afterRejectedWork);
    const submitted = await client.callTool({ name: 'codex_tool_call', arguments: { turn_token: token,
      wire_name: 'codex.control.output', arguments: { kind: 'final', text: 'FINAL_DELIVERED' } } });
    expect(submitted.structuredContent).toMatchObject({ accepted: true });
    expect(await broker.armFinalizationOutput(token, afterRejectedWork!)).toBe(true);
    expect(await broker.nextOutput(token, 0)).toMatchObject({ kind: 'final', text: 'FINAL_DELIVERED' });
    await expect(readNativeOutputControlInventory(socket, disabled)).rejects.toThrow('unavailable');
    broker.revoke(token);
    await expect(callTurnBroker(socket, { method: 'read_output_control', token })).rejects.toThrow('unavailable');
  } finally {
    await client.close().catch(() => {}); broker.revoke(token); broker.revoke(disabled); await broker.close();
  }
}, 10_000);

test('Native2 inventory fallback records evidence only for an armed turn token', async () => {
  const socket = join(tmpdir(), `cgw-contract-fallback-${process.pid}-${Date.now()}.sock`);
  const broker = TurnBroker.forSocket(socket);
  const environment = { cwd: process.cwd(), roots: [process.cwd()], writableRoots: [],
    sandboxPolicy: { type: 'readOnly' as const, networkAccess: false }, tools: [] };
  const token = await broker.register(environment);
  const unarmed = await broker.register(environment);
  const nonce = '66666666666666666666666666666666';
  const client = new Client({ name: 'contract-fallback-integration', version: '1' });
  try {
    discardConnectorContractProbeEvidence(nonce);
    armConnectorContractProbeFallback(token, nonce, NATIVE2_CONTRACT_REVISION);
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: ['src/cli.ts', 'mcp', '--broker-socket', socket], cwd: process.cwd(), stderr: 'pipe' }));
    await client.callTool({ name: 'codex_tool_inventory', arguments: { turn_token: unarmed } });
    expect(consumeConnectorContractProbeEvidence(nonce, NATIVE2_CONTRACT_REVISION)).toBeFalse();
    await client.callTool({ name: 'codex_tool_inventory', arguments: { turn_token: token, query: 'ordinary search' } });
    expect(consumeConnectorContractProbeEvidence(nonce, NATIVE2_CONTRACT_REVISION)).toBeFalse();
    const fallback = await client.callTool({ name: 'codex_tool_inventory', arguments: {
      turn_token: token, include_schema: false,
    } });
    expect(fallback.structuredContent).toEqual({ tools: [], total: 0, next_offset: null });
    expect(consumeConnectorContractProbeEvidence(nonce, NATIVE2_CONTRACT_REVISION)).toBeTrue();
    const escaped = await client.callTool({ name: 'codex_tool_inventory', arguments: {
      turn_token: token,
      query: `\\_\\_codex_contract_probe\\_\\_:${NATIVE2_CONTRACT_REVISION}:${nonce}`,
    } });
    expect(escaped.isError).not.toBe(true);
    expect(consumeConnectorContractProbeEvidence(nonce, NATIVE2_CONTRACT_REVISION)).toBeTrue();
    armConnectorContractProbeFallback(token, nonce, NATIVE2_CONTRACT_REVISION);
    broker.revoke(token);
    const retired = await client.callTool({ name: 'codex_tool_inventory', arguments: { turn_token: token } });
    expect(retired.isError).toBeTrue();
    expect(consumeConnectorContractProbeEvidence(nonce, NATIVE2_CONTRACT_REVISION)).toBeFalse();
  } finally {
    discardConnectorContractProbeFallback(token);
    discardConnectorContractProbeEvidence(nonce);
    await client.close().catch(() => {});
    broker.revoke(token);
    broker.revoke(unarmed);
    await broker.close();
  }
}, 10_000);
