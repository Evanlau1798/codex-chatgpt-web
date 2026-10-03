import { expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TurnBroker } from '../src/adapters/chatgpt-web/turn-broker';

(process.env.CGW_LONG_COMPACTION_ACCEPTANCE === '1' ? test : test.skip)('real MCP compaction token survives the former five-minute cutoff', async () => {
  const socket = join(tmpdir(), `cgw-long-cp-${process.pid}-${Date.now()}.sock`);
  const broker = TurnBroker.forSocket(socket);
  const client = new Client({name:'long-compaction-acceptance',version:'1'});
  const transaction = await broker.beginCompactionTransaction('slow-pro-checkpoint', null);
  try {
    await client.connect(new StdioClientTransport({command:process.execPath,
      args:['src/cli.ts','mcp','--broker-socket',socket],cwd:process.cwd(),stderr:'pipe'}));
    const handoff = broker.waitForCompactionHandoff(transaction.token);
    const start = Date.now();
    await Bun.sleep(310_000);
    const result = await client.callTool({name:'codex_tool_call',arguments:{turn_token:transaction.token,
      wire_name:'codex.control.compaction_handoff',arguments:{handoff_id:transaction.handoffId,
        summary:'Verified late checkpoint; completed evidence is preserved.'}}});
    expect(result.isError).not.toBe(true);
    expect(await handoff).toContain('Verified late checkpoint');
    expect(Date.now()-start).toBeGreaterThan(300_000);
    console.info(`long compaction MCP accepted elapsedMs=${Date.now()-start}`);
  } finally { await client.close().catch(()=>{}); broker.abortCompactionTransaction(transaction.token); await broker.close(); }
}, 340_000);
