import { expect, test } from 'bun:test';
import { diagnosticErrorCode } from '../src/adapters/chatgpt-web/mcp-request-diagnostics';
test('MCP failure classification retains causes without arbitrary error text', () => {
  expect(diagnosticErrorCode(new Error('This Codex turn did not advertise deferred tool search'))).toBe('deferred_search_unavailable');
  expect(diagnosticErrorCode(new Error('Codex Native work tools are closed during final-answer recovery; call codex.control.output with kind=final'))).toBe('work_tools_closed');
  expect(diagnosticErrorCode(new Error('private-token-secret-123'))).toBe('unclassified');
  expect(diagnosticErrorCode({ message: 'This Codex turn did not advertise deferred tool search' })).toBe('unknown');
});
