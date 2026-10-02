import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';

export const CODEX_MODEL = 'chatgpt-web/gpt-6-pro';
export const CLAUDE_MODEL = 'claude-chatgpt-web-gpt-6-pro';
export const CODEX_VERSION = '0.159.2';
export const QUOTA_CODES = new Set([
  'rate_limit_exceeded',
  'rate_limited',
  'chatgpt_rate_limited',
  'chatgpt_account_safety_stop',
  'chatgpt_account_safety_paused',
  'chatgpt_usage_limit',
  'usage_limit_reached',
  'verification_limit',
  'chatgpt_verification_limit',
  'verification_rate_limit',
  'rate_limit_error',
  'claude_verification_limit',
]);

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);
const NEVER_CAPTURE_HEADERS = new Set([
  'authorization', 'cookie', 'set-cookie', 'proxy-authorization', 'x-api-key',
  'api-key', 'www-authenticate',
]);
const SAFE_HEADERS = new Set([
  'accept', 'accept-encoding', 'anthropic-beta', 'anthropic-version', 'cache-control',
  'content-type', 'content-encoding', 'originator', 'openai-beta', 'traceparent',
  'user-agent', 'x-claude-code-agent-id', 'x-claude-code-session-id',
  'x-codex-session-id', 'x-codex-thread-id', 'x-codex-turn-metadata', 'x-request-id',
]);
const SAFE_RESPONSE_HEADERS = new Set([
  'allow', 'cache-control', 'content-type', 'date', 'etag', 'expires', 'last-modified',
  'retry-after', 'server-timing', 'vary', 'x-request-id',
]);

function sensitiveHeader(key) {
  return NEVER_CAPTURE_HEADERS.has(key)
    || /(?:^|[-_])(authorization|cookie|api[-_]?key|access[-_]?token|auth[-_]?token|secret)(?:$|[-_])/i.test(key);
}
const MAX_REQUEST_BYTES = 24 * 1024 * 1024;
const MAX_DECODED_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_CHARS = 40 * 1024 * 1024;
const MAX_EVENT_VALUE_CHARS = 8 * 1024;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

function bounded(value, max = MAX_EVENT_VALUE_CHARS) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function safeJson(value, redact) {
  try {
    return JSON.parse(redact(JSON.stringify(value)));
  } catch {
    return redact(String(value));
  }
}

export function decodeRequestBody(bytes, encoding) {
  const normalized = String(encoding || 'identity').toLowerCase().trim();
  if (!normalized || normalized === 'identity') return bytes;
  const options = { maxOutputLength: MAX_DECODED_REQUEST_BYTES };
  if (normalized === 'gzip' || normalized === 'x-gzip') return zlib.gunzipSync(bytes, options);
  if (normalized === 'deflate') return zlib.inflateSync(bytes, options);
  if (normalized === 'br') return zlib.brotliDecompressSync(bytes, options);
  if (normalized === 'zstd' && typeof zlib.zstdDecompressSync === 'function') return zlib.zstdDecompressSync(bytes, options);
  throw new Error(`Unsupported request content-encoding: ${normalized}`);
}

function requestBody(req) {
  return new Promise(async (resolve, reject) => {
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) throw new Error('Request body exceeds the recording bound');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const decoded = decodeRequestBody(bytes, req.headers['content-encoding']);
      if (decoded.length > MAX_DECODED_REQUEST_BYTES) throw new Error('Decoded request body exceeds the recording bound');
      let parsed;
      try { parsed = JSON.parse(decoded.toString('utf8')); } catch { parsed = decoded.toString('utf8'); }
      resolve({ bytes, decoded, parsed });
    } catch (error) {
      reject(error);
    }
  });
}

function collectHeaderSecrets(req, secrets) {
  for (const [name, value] of Object.entries(req.headers)) {
    if (!value || !/(authorization|api-key|token|secret|cookie)/i.test(name)) continue;
    const text = Array.isArray(value) ? value.join(',') : String(value);
    const bearer = text.match(/^Bearer\s+(.+)$/i)?.[1];
    if (bearer) secrets.add(bearer);
    if (text.length >= 12 && text.length <= 4096) secrets.add(text);
  }
}

export class StreamRedactor {
  constructor(secrets = []) {
    this.secrets = new Set([...secrets].filter(secret => typeof secret === 'string' && secret.length > 0));
    this.pending = '';
  }

  add(secret) {
    if (typeof secret === 'string' && secret.length > 0) this.secrets.add(secret);
  }

  replace(value) {
    let output = String(value);
    for (const secret of this.secrets) output = output.replaceAll(secret, '<redacted>');
    return output;
  }

  push(value, write) {
    this.pending += String(value);
    const maxSecret = Math.max(...[...this.secrets].map(secret => secret.length), 1);
    let cut = Math.max(0, this.pending.length - maxSecret + 1);
    for (const secret of this.secrets) {
      let at = this.pending.indexOf(secret);
      while (at >= 0) {
        if (at < cut && at + secret.length > cut) cut = at;
        at = this.pending.indexOf(secret, at + secret.length);
      }
    }
    if (cut > 0) write(this.replace(this.pending.slice(0, cut)));
    this.pending = this.pending.slice(cut);
  }

  end(write) {
    write(this.replace(this.pending));
    this.pending = '';
  }
}

function safeHeaders(headers, redactor) {
  const result = {};
  for (const [name, raw] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (sensitiveHeader(key) || !SAFE_HEADERS.has(key)) continue;
    result[key] = redactor.replace(Array.isArray(raw) ? raw.join(',') : String(raw));
  }
  return result;
}

function safeResponseHeaders(headers, redactor) {
  const result = {};
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    if (sensitiveHeader(key)) continue;
    if (SAFE_RESPONSE_HEADERS.has(key) || key.startsWith('x-') || key.startsWith('anthropic-')
      || key.startsWith('openai-') || key.startsWith('ratelimit-') || key.startsWith('x-ratelimit-')) {
      result[key] = redactor.replace(value);
    }
  }
  return result;
}

function authMatches(req, expected) {
  if (!expected) return false;
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string' && /^Bearer\s+/i.test(authorization)
    && authorization.slice(7).trim() === expected) return true;
  for (const key of ['x-api-key', 'api-key']) {
    if (req.headers[key] === expected) return true;
  }
  return false;
}

const CODEX_IDENTITY_FIELDS = ['installation_id', 'session_id', 'thread_id', 'turn_id', 'root_turn_id', 'window_id', 'thread_source', 'request_kind'];

function parseMetadataObject(raw) {
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed = JSON.parse(raw);
    return asObject(parsed);
  } catch {
    return undefined;
  }
}

function parseMetadata(req, body) {
  const clientMetadata = asObject(body?.client_metadata);
  const headerMetadata = parseMetadataObject(req.headers['x-codex-turn-metadata']);
  const bodyMetadata = parseMetadataObject(clientMetadata?.['x-codex-turn-metadata']);
  const metadata = headerMetadata ?? bodyMetadata ?? {};
  const copies = {
    installation_id: clientMetadata?.installation_id ?? clientMetadata?.['x-codex-installation-id'],
    session_id: clientMetadata?.session_id,
    thread_id: clientMetadata?.thread_id,
    turn_id: clientMetadata?.turn_id,
    root_turn_id: clientMetadata?.root_turn_id,
    window_id: clientMetadata?.window_id ?? clientMetadata?.['x-codex-window-id'],
    thread_source: clientMetadata?.thread_source,
    request_kind: clientMetadata?.request_kind,
  };
  const mismatches = [];
  const compare = source => {
    if (!source) return;
    for (const field of CODEX_IDENTITY_FIELDS) {
      if (source[field] !== undefined && metadata[field] !== undefined
        && String(source[field]) !== String(metadata[field])) mismatches.push(field);
    }
  };
  compare(bodyMetadata);
  compare(copies);
  return {
    metadata,
    headerMetadataPresent: Boolean(headerMetadata),
    bodyMetadataPresent: Boolean(bodyMetadata),
    mismatches: [...new Set(mismatches)],
    titleEphemeralMismatchAllowed: mismatches.length > 0
      && mismatches.every(field => field === 'thread_id' || field === 'thread_source')
      && ['thread_title', 'system'].includes(String(metadata.thread_source))
      && (!bodyMetadata || ['thread_title', 'system'].includes(String(bodyMetadata.thread_source))),
  };
}

function bodyContainsCwd(body, cwd) {
  if (!cwd) return false;
  const needle = `<cwd>${cwd}</cwd>`;
  try { return JSON.stringify(body).includes(needle); } catch { return false; }
}

function uuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function codexVersionFromUserAgent(value) {
  const match = String(value || '').match(/^(?:codex-tui|codex_exec)\/(\d+\.\d+\.\d+)(?:\s|$)/);
  return match?.[1];
}

function claudeVersionFromUserAgent(value) {
  const match = String(value || '').match(/^(?:claude-code|claude-cli)\/(\d+\.\d+\.\d+)(?:\s|$)/i);
  if (!match) return undefined;
  return match[1].split('.').map(Number);
}

function atLeastVersion(actual, minimum) {
  if (!actual) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if ((actual[index] ?? 0) !== minimum[index]) return (actual[index] ?? 0) > minimum[index];
  }
  return true;
}

function claudeSessionCopies(req, body) {
  const copies = [];
  if (typeof req.headers['x-claude-code-session-id'] === 'string') copies.push(req.headers['x-claude-code-session-id']);
  if (typeof body?.session_id === 'string') copies.push(body.session_id);
  if (typeof body?.metadata?.session_id === 'string') copies.push(body.metadata.session_id);
  if (typeof body?.metadata?.sessionId === 'string') copies.push(body.metadata.sessionId);
  const userId = body?.metadata?.user_id;
  if (typeof userId === 'string') {
    try {
      const parsed = JSON.parse(userId);
      if (asObject(parsed)?.session_id !== undefined) copies.push(parsed.session_id);
    } catch {
      return { copies, invalidUserId: true };
    }
  } else if (asObject(userId)?.session_id !== undefined) {
    copies.push(userId.session_id);
  }
  return { copies: copies.filter(value => typeof value === 'string' && value.length > 0), invalidUserId: false };
}

function captureBody(body, client) {
  if (client !== 'claude' || !asObject(body)) return body;
  const copy = structuredClone(body);
  const metadata = asObject(copy.metadata);
  if (metadata && Object.hasOwn(metadata, 'user_id')) {
    metadata.user_id = '<redacted-claude-user-id>';
  }
  return copy;
}

function clientModel(client) {
  return client === 'codex' ? CODEX_MODEL : CLAUDE_MODEL;
}

function codexIdentityDiagnostic(req, metadata, metadataInfo, reason) {
  return {
    reason,
    nativeVersion: codexVersionFromUserAgent(req.headers['user-agent']),
    originator: req.headers.originator,
    threadSource: metadata.thread_source,
    headerMetadataPresent: metadataInfo.headerMetadataPresent,
    bodyMetadataPresent: metadataInfo.bodyMetadataPresent,
    identityMismatchFields: metadataInfo.mismatches,
    projectMarkerPresent: typeof req.headers['openai-project'] === 'string',
  };
}

function modelFromBody(body) {
  return typeof body?.model === 'string' ? body.model : undefined;
}

function isValidMessageSchema(body) {
  if (!Array.isArray(body?.input) || body.input.length < 1 || body.input.length > 8) return false;
  return body.input.every(item => item && typeof item === 'object' && !Array.isArray(item)
    && typeof item.type === 'string' && (item.type === 'message' || item.type === 'input_text' || item.type === 'input_image'));
}

function exactKeys(value, keys) {
  if (!asObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isTitleOutputSchema(body) {
  const format = asObject(asObject(body?.text)?.format);
  const schema = asObject(format?.schema);
  const properties = asObject(schema?.properties);
  const title = asObject(properties?.title);
  return format?.type === 'json_schema'
    && typeof format.name === 'string' && format.name.length > 0
    && format.strict === true
    && exactKeys(schema, ['additionalProperties', 'properties', 'required', 'type'])
    && schema.type === 'object' && schema.additionalProperties === false
    && Array.isArray(schema.required) && schema.required.length === 1 && schema.required[0] === 'title'
    && exactKeys(properties, ['title'])
    && exactKeys(title, ['maxLength', 'minLength', 'type'])
    && title.type === 'string' && title.minLength === 1 && title.maxLength === 36;
}

function isTitleScaffold(value) {
  if (!Array.isArray(value)) return false;
  if (value.length !== 2 && value.length !== 3) return false;
  let requestUserInput = false;
  let clock = false;
  let toolSearch = false;
  for (const raw of value) {
    const tool = asObject(raw);
    if (!tool || typeof tool.type !== 'string') return false;
    if (tool.type === 'function' && tool.name === 'request_user_input_async' && !requestUserInput) {
      requestUserInput = true;
      continue;
    }
    if (tool.type === 'tool_search' && tool.execution === 'client' && !toolSearch) {
      toolSearch = true;
      continue;
    }
    if (tool.type === 'namespace' && tool.name === 'clock' && !clock && Array.isArray(tool.tools) && tool.tools.length === 2) {
      const names = new Set(tool.tools.map(item => asObject(item)?.name));
      if (tool.tools.every(item => asObject(item)?.type === 'function') && names.has('curr_time') && names.has('sleep') && names.size === 2) {
        clock = true;
        continue;
      }
    }
    return false;
  }
  return requestUserInput && clock && (value.length === 2 ? !toolSearch : toolSearch);
}

function isTitleInputEnvelope(body) {
  if (!isTitleOutputSchema(body) || typeof body.instructions !== 'string' || !body.instructions.trim()
    || (body.previous_response_id !== undefined && body.previous_response_id !== null)
    || body.tool_choice !== 'auto' || typeof body.stream !== 'boolean' || !isTitleScaffold(body.tools)) return false;
  if (!Array.isArray(body.input) || body.input.length !== 3) return false;
  const expected = [['developer'], ['user'], ['user']];
  return body.input.every((item, index) => {
    if (!item || item.type !== 'message' || item.role !== expected[index][0] || typeof item.id !== 'string' || !item.id.trim()) return false;
    if (!Array.isArray(item.content) || item.content.length === 0) return false;
    if (index > 0 && item.content.length !== 1) return false;
    return item.content.every(part => part && part.type === 'input_text' && typeof part.text === 'string');
  }) && /<environment_context>[\s\S]*<\/environment_context>/.test(String(body.input[1].content[0].text));
}

function looksLikeCodexTitleAuxiliary({ req, body, metadata }) {
  return metadata.thread_source === 'thread_title'
    && metadata.request_kind === 'turn'
    && uuid(metadata.thread_id)
    && uuid(metadata.session_id)
    && uuid(metadata.installation_id)
    && typeof metadata.turn_id === 'string' && metadata.turn_id.length > 0
    && Number.isFinite(Number(metadata.turn_started_at_unix_ms))
    && Number(metadata.turn_started_at_unix_ms) >= 0
    && req.headers.originator === 'codex-tui'
    && codexVersionFromUserAgent(req.headers['user-agent']) === CODEX_VERSION
    && String(body.model || '').startsWith('chatgpt-web/')
    && isValidMessageSchema(body)
    && isTitleInputEnvelope(body);
}

function streamFrameData(frame) {
  const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart()).join('\n');
  if (!data || data === '[DONE]') return undefined;
  try { return JSON.parse(data); } catch { return undefined; }
}

function structuredSseEvent(parsed, sequence, elapsedMs, redactor) {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const item = asObject(parsed.item);
  const contentBlock = asObject(parsed.content_block);
  const delta = asObject(parsed.delta);
  const response = asObject(parsed.response);
  const error = asObject(parsed.error) ?? asObject(response?.error);
  const code = typeof error?.code === 'string' ? error.code : (typeof parsed.code === 'string' ? parsed.code : undefined);
  const toolItem = ['function_call', 'custom_tool_call', 'tool_search_call', 'function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(item?.type);
  const toolBlock = ['tool_use', 'server_tool_use', 'tool_result'].includes(contentBlock?.type);
  const name = toolItem && typeof item?.name === 'string' ? item.name
    : toolBlock && typeof contentBlock?.name === 'string' ? contentBlock.name : undefined;
  const callId = toolItem && typeof item?.call_id === 'string' ? item.call_id
    : toolItem && typeof item?.id === 'string' ? item.id
      : toolBlock && typeof contentBlock?.id === 'string' ? contentBlock.id : undefined;
  const value = {
    type: 'sse',
    sequence,
    eventType: typeof parsed.type === 'string' ? parsed.type : undefined,
    itemType: typeof item?.type === 'string' ? item.type : undefined,
    blockType: typeof contentBlock?.type === 'string' ? contentBlock.type : undefined,
    toolName: name,
    callId,
    code,
    status: typeof response?.status === 'string' ? response.status : undefined,
    deltaType: typeof delta?.type === 'string' ? delta.type : undefined,
    deltaChars: [typeof parsed.delta === 'string' ? parsed.delta : undefined, delta?.text, delta?.thinking, delta?.partial_json, delta?.arguments].filter(value => typeof value === 'string')
      .reduce((sum, value) => sum + value.length, 0),
    toolCall: ['function_call', 'custom_tool_call', 'tool_search_call'].includes(item?.type)
      || ['tool_use', 'server_tool_use'].includes(contentBlock?.type)
      || /^(?:response\.(?:function_call_arguments|custom_tool_call_input)\.|tool_use$)/.test(String(parsed.type || '')),
    toolResult: ['function_call_output', 'custom_tool_call_output', 'tool_search_output', 'tool_result'].includes(item?.type)
      || contentBlock?.type === 'tool_result' || parsed.type === 'tool_result',
    errorMessage: typeof error?.message === 'string' ? bounded(redactor.replace(error.message)) : undefined,
    elapsedMs,
  };
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
}

function quotaCodeFromSse(parsed) {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const response = asObject(parsed.response);
  const error = asObject(parsed.error) ?? asObject(response?.error);
  const code = typeof error?.code === 'string' ? error.code
    : typeof error?.type === 'string' ? error.type : undefined;
  const explicitFailure = parsed.type === 'response.failed'
    || parsed.type === 'error'
    || parsed.type === 'message.error';
  return explicitFailure && code && QUOTA_CODES.has(code) ? code : undefined;
}

function explicitFailureSse(parsed) {
  return parsed && typeof parsed === 'object'
    && (parsed.type === 'response.failed' || parsed.type === 'error' || parsed.type === 'message.error');
}

function safeQuotaError(parsed, redactor) {
  const response = asObject(parsed?.response);
  const error = asObject(parsed?.error) ?? asObject(response?.error) ?? {};
  return {
    code: typeof error.code === 'string' ? error.code : 'unknown_quota_code',
    type: typeof error.type === 'string' ? error.type : undefined,
    message: typeof error.message === 'string' ? bounded(redactor.replace(error.message)) : undefined,
  };
}

function makeRedactor(options, req) {
  const secrets = [options.childToken, options.controlToken].filter(Boolean);
  const redactor = new StreamRedactor(secrets);
  collectHeaderSecrets(req, redactor.secrets);
  return redactor;
}

function writeJson(file, value, redactor) {
  fs.writeFileSync(file, `${redactor.replace(JSON.stringify(value, null, 2))}\n`, { mode: 0o600, flag: 'w' });
}

function appendEvent(file, value, redactor) {
  fs.appendFileSync(file, `${redactor.replace(JSON.stringify({ at: new Date().toISOString(), ...value }))}\n`, { mode: 0o600 });
}

function requestIdentity(options, req, body, metadata, pathname) {
  const version = req.headers['user-agent'];
  if (options.client === 'codex') {
    const uaVersion = codexVersionFromUserAgent(version);
    const expectedOriginator = options.headless ? 'codex_exec' : 'codex-tui';
    if (uaVersion !== CODEX_VERSION || req.headers.originator !== expectedOriginator) return { ok: false, reason: 'codex_originator_or_version' };
    if (req.headers['openai-project'] !== options.childToken) return { ok: false, reason: 'codex_project_marker' };
    if (isModelsPath(pathname)) {
      const installation = metadata.installation_id;
      const session = metadata.session_id;
      if (installation && !uuid(installation)) return { ok: false, reason: 'codex_catalog_installation_id' };
      if (session && !uuid(session)) return { ok: false, reason: 'codex_catalog_session_id' };
      return { ok: true, installation, session, version: uaVersion, catalog: true };
    }
    const thread = metadata.thread_id ?? req.headers['x-codex-thread-id'] ?? req.headers['x-codex-session-id'];
    if (!uuid(thread)) return { ok: false, reason: 'codex_thread_id' };
    const installation = metadata.installation_id;
    if (!uuid(installation)) return { ok: false, reason: 'codex_installation_id' };
    const session = metadata.session_id;
    if (!uuid(session)) return { ok: false, reason: 'codex_session_id' };
    if (options.expectedRootThreadId && metadata.thread_source !== 'thread_title' && thread !== options.expectedRootThreadId) {
      return { ok: false, reason: 'codex_resume_thread_id' };
    }
    if (options.codexInstallationId && installation !== options.codexInstallationId) return { ok: false, reason: 'codex_installation_changed' };
    if (options.codexSessionId && session !== options.codexSessionId && metadata.thread_source !== 'thread_title') {
      return { ok: false, reason: 'codex_session_changed' };
    }
    if (metadata.turn_started_at_unix_ms !== undefined && Number(metadata.turn_started_at_unix_ms) < options.launchedAt) {
      return { ok: false, reason: 'codex_turn_before_launch' };
    }
    if (metadata.thread_source === 'thread_title') {
      if (Number(metadata.turn_started_at_unix_ms) < options.launchedAt) return { ok: false, reason: 'codex_title_before_launch' };
      if (!looksLikeCodexTitleAuxiliary({ req, body, metadata })) return { ok: false, reason: 'codex_title_schema' };
      return { ok: true, auxiliary: 'title', thread, installation, session, version: uaVersion };
    }
    const ownedProject = bodyContainsCwd(body, options.cwd)
      || metadata.cwd === options.cwd
      || req.headers['x-codex-project'] === options.cwd;
    if (!ownedProject && !options.codexProjectSeen) return { ok: false, reason: 'codex_project_identity' };
    return { ok: true, auxiliary: undefined, thread, installation, session, version: uaVersion, ownedProject };
  }
  const parsedVersion = claudeVersionFromUserAgent(version);
  if (!atLeastVersion(parsedVersion, options.minimumClaudeVersion)) return { ok: false, reason: 'claude_version' };
  if (!authMatches(req, options.childToken)) return { ok: false, reason: 'claude_child_auth' };
  if (isModelsPath(pathname)) return { ok: true, version: parsedVersion.join('.'), catalog: true };
  const sessionCopies = claudeSessionCopies(req, body);
  if (sessionCopies.invalidUserId || sessionCopies.copies.length === 0
    || sessionCopies.copies.some(session => session !== options.sessionId)) {
    return { ok: false, reason: sessionCopies.invalidUserId ? 'claude_session_metadata_invalid' : 'claude_session_id' };
  }
  return { ok: true, session: options.sessionId, version: parsedVersion.join('.') };
}

function bridgeUrl(options) {
  const host = options.upstreamHost || '127.0.0.1';
  return `http://${host}:${options.upstreamPort}`;
}

function jsonError(res, status, code, message) {
  const body = JSON.stringify({ error: { type: 'invalid_request_error', code, message } });
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
}

function isModelsPath(pathname) {
  return pathname === '/v1/models';
}

function pathAllowed(client, pathname) {
  if (client === 'codex') return ['/v1/responses', '/v1/responses/compact', '/v1/models', '/v1/alpha/search', '/v1/images/generations', '/v1/images/edits'].includes(pathname);
  return ['/v1/messages', '/v1/messages/count_tokens', '/v1/models', '/v1/messages/steering'].includes(pathname);
}

function filterForwardHeaders(req, redactor, options) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
    if (key.toLowerCase() === 'x-owned-test-capture') continue;
    if (options.client === 'codex' && ['authorization', 'openai-project', 'x-api-key', 'api-key'].includes(key.toLowerCase())) continue;
    headers.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  headers.set('x-astra6-client', options.client);
  headers.set('x-astra6-client-version', options.client === 'codex' ? CODEX_VERSION : String(options.clientVersion || '2.1.285+'));
  headers.set('x-astra6-route', clientModel(options.client));
  headers.set('accept-encoding', 'identity');
  void redactor;
  return headers;
}

function isInferenceRequest(client, pathname, method) {
  if (method !== 'POST') return false;
  return client === 'codex' ? (pathname === '/v1/responses' || pathname === '/v1/responses/compact')
    : (pathname === '/v1/messages');
}

export function createRecordingProxy(options) {
  const client = options.client;
  if (!['codex', 'claude'].includes(client)) throw new Error('Proxy client must be codex or claude');
  const artifactRoot = path.resolve(options.artifactRoot);
  ensureDir(artifactRoot);
  const eventsPath = path.join(artifactRoot, 'events.jsonl');
  fs.writeFileSync(eventsPath, '', { mode: 0o600, flag: 'wx' });
  const launchedAt = Number(options.launchedAt || Date.now());
  const state = {
    quotaLatched: false,
    quota: undefined,
    codexInstallationId: undefined,
    codexSessionId: undefined,
    codexRootThreadId: options.expectedRootThreadId,
    codexProjectSeen: false,
    sessionId: options.sessionId,
    sequence: 0,
  };
  const listeners = new Set();
  const emit = value => { for (const listener of listeners) listener(value); };
  const latchQuota = (reason, detail) => {
    if (state.quotaLatched) return;
    state.quotaLatched = true;
    state.quota = { reason, ...detail, latchedAt: new Date().toISOString() };
    appendEvent(eventsPath, { type: 'quota_latch', ...state.quota, action: 'stop_inference_and_interrupt_owned_child' }, redactorForEvents);
    writeJson(path.join(artifactRoot, 'quota-latch.json'), state.quota, redactorForEvents);
    emit({ type: 'quota_latch', ...state.quota });
  };
  const redactorForEvents = new StreamRedactor([options.childToken, options.controlToken].filter(Boolean));
  const activeUpstream = new Set();
  const server = http.createServer(async (req, res) => {
    const id = String(++state.sequence).padStart(4, '0');
    const started = Date.now();
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = parsedUrl.pathname;
    const inference = isInferenceRequest(client, pathname, req.method);
    let bodyResult;
    let redactor;
    let upstreamAbort;
    let responseCapture;
    try {
      if (req.method === 'GET' && pathname === '/v1/responses' && client === 'codex') {
        appendEvent(eventsPath, { id, type: 'transport_negotiation', scope: 'local-auxiliary', method: req.method, path: pathname, status: 426 }, redactorForEvents);
        res.writeHead(426, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: { message: 'Use the local Responses HTTP/SSE transport.' } }));
        return;
      }
      if (!pathAllowed(client, pathname)) {
        appendEvent(eventsPath, { id, type: 'rejected_path', path: pathname, method: req.method }, redactorForEvents);
        jsonError(res, 404, 'route_not_allowed', 'Route is not enabled by this launcher');
        return;
      }
      const earlyToken = client === 'claude' && pathname === '/v1/messages/steering' ? options.controlToken : options.childToken;
      if (client === 'codex' ? req.headers['openai-project'] !== earlyToken : !authMatches(req, earlyToken)) {
        jsonError(res, 403, 'owned_client_required', 'Owned client credentials are required before decoding');
        req.resume();
        return;
      }
      bodyResult = await requestBody(req);
      redactor = makeRedactor(options, req);
      for (const secret of redactor.secrets) redactorForEvents.add(secret);
      const body = bodyResult.parsed;
      const metadataInfo = client === 'codex' ? parseMetadata(req, body) : {
        metadata: {}, headerMetadataPresent: true, bodyMetadataPresent: true, mismatches: [], titleThreadMismatchOnly: false,
      };
      const metadata = metadataInfo.metadata;
      const steering = client === 'claude' && req.method === 'POST' && pathname === '/v1/messages/steering';
      let identity;
      if (steering) {
        if (!authMatches(req, options.controlToken)) {
          appendEvent(eventsPath, { id, type: 'rejected_steering_auth', path: pathname, scope: 'local-control' }, redactor);
          jsonError(res, 403, 'bridge_control_auth_required', 'Only the bridge control token may submit steering');
          return;
        }
        const version = claudeVersionFromUserAgent(req.headers['user-agent']);
        if (!atLeastVersion(version, options.minimumClaudeVersion)) {
          appendEvent(eventsPath, { id, type: 'rejected_steering_version', path: pathname, scope: 'local-control' }, redactor);
          jsonError(res, 403, 'owned_client_required', 'Only the owned Claude client may submit steering');
          return;
        }
        const steeringSession = body?.session_id ?? body?.sessionId ?? body?.metadata?.session_id ?? body?.metadata?.sessionId;
        if (steeringSession !== options.sessionId) {
          appendEvent(eventsPath, { id, type: 'rejected_steering_session', path: pathname, scope: 'local-control', sessionId: steeringSession }, redactor);
          jsonError(res, 403, 'owned_session_required', 'Steering session does not belong to this Claude child');
          return;
        }
        identity = { ok: true, version: version.join('.'), auxiliary: 'steering', session: steeringSession };
      } else {
        if (client === 'codex' && !isModelsPath(pathname)
          && (!metadataInfo.headerMetadataPresent || !metadataInfo.bodyMetadataPresent)) {
          appendEvent(eventsPath, { id, type: 'rejected_identity', path: pathname, reason: 'codex_metadata_copy_missing' }, redactor);
          jsonError(res, 403, 'owned_client_required', 'Codex body and header turn identity are both required');
          return;
        }
        if (client === 'codex' && metadataInfo.mismatches.length > 0
          && !(metadata.thread_source === 'thread_title' && metadataInfo.titleEphemeralMismatchAllowed)) {
          appendEvent(eventsPath, { id, type: 'rejected_identity', path: pathname, reason: 'codex_metadata_copy_mismatch', fields: metadataInfo.mismatches }, redactor);
          jsonError(res, 403, 'owned_client_required', 'Codex body and header turn identities disagree');
          return;
        }
        identity = requestIdentity({
          ...options,
          ...state,
          launchedAt,
          expectedRootThreadId: state.codexRootThreadId,
        }, req, body, metadata, pathname);
      }
      if (!identity.ok) {
        appendEvent(eventsPath, {
          id, type: 'rejected_identity', path: pathname,
          ...(client === 'codex' ? codexIdentityDiagnostic(req, metadata, metadataInfo, identity.reason) : { reason: identity.reason }),
        }, redactor);
        jsonError(res, 403, 'owned_client_required', 'Only the owned native client may use this proxy');
        return;
      }
      if (client === 'codex') {
        if (identity.installation) state.codexInstallationId ??= identity.installation;
        if (identity.session && identity.auxiliary !== 'title') state.codexSessionId ??= identity.session;
        if (identity.thread && identity.auxiliary !== 'title') state.codexRootThreadId ??= identity.thread;
        if (identity.ownedProject) state.codexProjectSeen = true;
      }
      const isTitle = identity.auxiliary === 'title';
      const isSteering = identity.auxiliary === 'steering';
      const actualModel = modelFromBody(body);
      if (isTitle) {
        appendEvent(eventsPath, {
          id, type: 'local_auxiliary', auxiliary: 'codex_title', path: pathname,
          model: actualModel, requestedModel: actualModel, installationId: identity.installation,
          sessionId: identity.session, ephemeralThreadId: identity.thread,
          provenance: 'bridge-local-title-handler-no-authority', elapsedMs: Date.now() - started,
        }, redactor);
      }
      const inferenceScope = inference && !isTitle && !isSteering;
      const modelBound = inference || (client === 'claude' && pathname === '/v1/messages/count_tokens');
      const modelGuard = modelBound || (client === 'codex' && typeof actualModel === 'string');
      if (state.quotaLatched && inferenceScope) {
        appendEvent(eventsPath, { id, type: 'blocked_after_quota_latch', path: pathname, model: actualModel }, redactor);
        jsonError(res, 429, 'quota_latch', 'Inference is latched after a rate or verification limit; no retry was sent');
        return;
      }
      if (!isTitle && modelGuard && actualModel !== clientModel(client)) {
        appendEvent(eventsPath, { id, type: 'rejected_model', path: pathname, model: actualModel, expected: clientModel(client) }, redactor);
        jsonError(res, 400, 'wrong_web_model', `This launcher only accepts ${clientModel(client)}`);
        return;
      }
      if (!isTitle && client === 'codex' && modelGuard && !String(metadata.model || actualModel).startsWith('chatgpt-web/')) {
        appendEvent(eventsPath, { id, type: 'rejected_non_web_model', path: pathname, model: actualModel }, redactor);
        jsonError(res, 400, 'non_web_model', 'Non-Web models are not forwarded by this launcher');
        return;
      }
      if (!isTitle && client === 'claude' && modelGuard && !String(actualModel || '').startsWith('claude-chatgpt-web-')) {
        appendEvent(eventsPath, { id, type: 'rejected_non_web_model', path: pathname, model: actualModel }, redactor);
        jsonError(res, 400, 'non_web_model', 'Non-Web models are not forwarded by this launcher');
        return;
      }
      const safeRequest = {
        id, method: req.method, path: req.url, headers: safeHeaders(req.headers, redactor),
        body: safeJson(captureBody(body, client), value => redactor.replace(value)),
      };
      writeJson(path.join(artifactRoot, `${id}.request.json`), safeRequest, redactor);
      appendEvent(eventsPath, {
        id, type: 'request', scope: inferenceScope ? 'gpt-6-pro-inference' : (isSteering ? 'local-control' : 'local-auxiliary'),
        method: req.method, path: req.url, model: actualModel, bytes: bodyResult.bytes.length,
        decodedBytes: bodyResult.decoded.length, contentEncoding: req.headers['content-encoding'] || 'identity',
        provenance: {
          client, clientVersion: identity.version, originator: req.headers.originator,
          installationId: identity.installation, sessionId: identity.session,
          threadId: identity.thread, threadSource: metadata.thread_source,
          projectMatched: client === 'codex' ? (bodyContainsCwd(body, options.cwd) || state.codexProjectSeen) : undefined,
        },
        toolNames: Array.isArray(body?.tools) ? body.tools.map(tool => tool?.name || tool?.type).filter(Boolean).slice(0, 128) : [],
      }, redactor);
      upstreamAbort = new AbortController();
      activeUpstream.add(upstreamAbort);
      res.on('close', () => { if (!res.writableEnded) upstreamAbort.abort(); });
      const upstream = await fetch(`${bridgeUrl(options)}${req.url}`, {
        method: req.method,
        headers: filterForwardHeaders(req, redactor, options),
        ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: bodyResult.bytes }),
        signal: upstreamAbort.signal,
      });
      if (isTitle && (upstream.headers.get('x-codex-local-handling') !== 'codex-thread-title'
        || upstream.headers.get('x-codex-response-provenance') !== 'local-auxiliary')) {
        appendEvent(eventsPath, { id, type: 'rejected_title_provenance', path: pathname }, redactor);
        upstreamAbort.abort();
        jsonError(res, 502, 'title_handler_not_local', 'The recognized title request did not receive local-handler provenance');
        return;
      }
      const outHeaders = safeResponseHeaders(upstream.headers, redactor);
      res.writeHead(upstream.status, outHeaders);
      appendEvent(eventsPath, {
        id, type: 'response_start', scope: inferenceScope ? 'gpt-6-pro-inference' : (isSteering ? 'local-control' : 'local-auxiliary'),
        status: upstream.status, headers: outHeaders, elapsedMs: Date.now() - started,
      }, redactor);
      if (inferenceScope && (upstream.status === 429 || (options.diagnostic && upstream.status >= 500))) {
        latchQuota(upstream.status === 429 ? 'upstream_http_429' : 'diagnostic_upstream_http_5xx', {
          id, status: upstream.status, path: pathname,
        });
      }
      const responseFile = path.join(artifactRoot, `${id}.response.txt`);
      responseCapture = fs.createWriteStream(responseFile, { mode: 0o600, flags: 'wx' });
      const responseRedactor = redactor;
      const decoder = new TextDecoder();
      let frameBuffer = '';
      let frameCount = 0;
      let responseChars = 0;
      let classificationText = '';
      const reader = upstream.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          if (!res.write(chunk)) await once(res, 'drain', { signal: upstreamAbort.signal });
          const text = decoder.decode(chunk, { stream: true });
          responseChars += text.length;
          if (responseChars > MAX_RESPONSE_CHARS) throw new Error('Response exceeds the recording bound');
          if ((upstream.status === 429 || (options.diagnostic && upstream.status >= 500)) && classificationText.length < MAX_EVENT_VALUE_CHARS) {
            classificationText += text.slice(0, MAX_EVENT_VALUE_CHARS - classificationText.length);
          }
          responseRedactor.push(text, piece => responseCapture.write(piece));
          frameBuffer += text;
          let boundary;
          while ((boundary = /\r?\n\r?\n/.exec(frameBuffer))) {
            const frame = frameBuffer.slice(0, boundary.index);
            frameBuffer = frameBuffer.slice(boundary.index + boundary[0].length);
            const parsed = streamFrameData(frame);
            if (!parsed) continue;
            const event = structuredSseEvent(parsed, ++frameCount, Date.now() - started, responseRedactor);
            if (event) appendEvent(eventsPath, { id, ...event }, responseRedactor);
            const code = quotaCodeFromSse(parsed);
            if (inferenceScope && code) latchQuota('sse_response_failed', { id, code, error: safeQuotaError(parsed, responseRedactor) });
            else if (inferenceScope && options.diagnostic && explicitFailureSse(parsed)) {
              latchQuota('diagnostic_sse_response_failed', { id, error: safeQuotaError(parsed, responseRedactor) });
            }
          }
        }
      }
      const tail = decoder.decode();
      if (tail) responseRedactor.push(tail, piece => responseCapture.write(piece));
      if ((upstream.status === 429 || (options.diagnostic && upstream.status >= 500)) && classificationText.length < MAX_EVENT_VALUE_CHARS) {
        classificationText += tail.slice(0, MAX_EVENT_VALUE_CHARS - classificationText.length);
      }
      responseRedactor.end(piece => responseCapture.write(piece));
      responseCapture.end();
      if (inferenceScope && (upstream.status === 429 || (options.diagnostic && upstream.status >= 500))) {
        let error;
        try {
          const parsed = JSON.parse(classificationText);
          const raw = asObject(parsed?.error) ?? {};
          error = {
            code: typeof raw.code === 'string' ? raw.code : undefined,
            type: typeof raw.type === 'string' ? raw.type : undefined,
            message: typeof raw.message === 'string' ? bounded(responseRedactor.replace(raw.message)) : undefined,
          };
        } catch {
          const message = classificationText.trim();
          if (message) error = { message: bounded(responseRedactor.replace(message)) };
        }
        if (error && (error.code || error.type || error.message)) {
          state.quota = { ...state.quota, error };
          writeJson(path.join(artifactRoot, 'quota-latch.json'), state.quota, responseRedactor);
          appendEvent(eventsPath, { id, type: 'quota_error_captured', error }, responseRedactor);
        }
      }
      appendEvent(eventsPath, {
        id, type: 'response_end', scope: inferenceScope ? 'gpt-6-pro-inference' : (isSteering ? 'local-control' : 'local-auxiliary'),
        status: upstream.status, responseChars, frameCount, elapsedMs: Date.now() - started,
      }, responseRedactor);
      writeJson(path.join(artifactRoot, `${id}.response.meta.json`), {
        id, status: upstream.status, headers: outHeaders, responseChars, frameCount,
        elapsedMs: Date.now() - started, quotaLatched: state.quotaLatched,
      }, responseRedactor);
      res.end();
    } catch (error) {
      responseCapture?.end();
      const message = error instanceof Error ? error.message : String(error);
      appendEvent(eventsPath, { id, type: 'proxy_error', path: req.url, message, elapsedMs: Date.now() - started }, redactor || redactorForEvents);
      if (!res.headersSent) jsonError(res, 502, 'proxy_error', 'Recording proxy failed while forwarding the local request');
      else res.end();
    } finally {
      if (upstreamAbort) activeUpstream.delete(upstreamAbort);
    }
  });
  return {
    server,
    state,
    eventsPath,
    artifactRoot,
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setClientVersion(version) { options.clientVersion = version; },
    async listen() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Recording proxy did not expose an ephemeral TCP port');
      return { host: '127.0.0.1', port: address.port, url: `http://127.0.0.1:${address.port}` };
    },
    async close() {
      for (const controller of activeUpstream) controller.abort();
      activeUpstream.clear();
      const closed = new Promise(resolve => server.close(() => resolve()));
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      let timer;
      try { await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 750); })]); }
      finally { clearTimeout(timer); }
    },
  };
}

export function bridgeConfig(pathname) {
  const raw = fs.readFileSync(pathname, 'utf8');
  const value = JSON.parse(raw);
  if (!value || value.host !== '127.0.0.1' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new Error('Bridge config must point to a loopback TCP endpoint');
  }
  if (value.mode !== 'full' || value.proAvailable !== true || value.solAvailable !== true
    || value.browserInteractionMode === 'manual') {
    throw new Error('Bridge config must be a full-mode automatic account with Pro GPT-6 capability enabled');
  }
  if (value.subagentProtocol !== undefined && value.subagentProtocol !== 'native' && value.subagentProtocol !== 'compatibility-v1') {
    throw new Error('Bridge config subagentProtocol is not recognized');
  }
  if (typeof value.controlToken !== 'string' || value.controlToken.length < 40) {
    throw new Error('Bridge config controlToken is missing or malformed');
  }
  return {
    host: value.host,
    port: value.port,
    controlToken: value.controlToken,
    releaseVersion: typeof value.releaseVersion === 'string' ? value.releaseVersion : undefined,
    mode: value.mode,
    runtimeCommand: Array.isArray(value.runtimeCommand) ? value.runtimeCommand : undefined,
    proAvailable: value.proAvailable === true,
    solAvailable: value.solAvailable === true,
    extraHighAvailable: value.extraHighAvailable === true,
    experimentalBiggerContext: value.experimentalBiggerContext === true,
    experimentalNoAutoCompact: value.experimentalNoAutoCompact === true,
    subagentProtocol: value.subagentProtocol === 'compatibility-v1' ? 'compatibility-v1' : 'native',
    useEnhancedWebSessionMode: value.useEnhancedWebSessionMode !== false,
    useEnhancedOutputTunnel: value.useEnhancedOutputTunnel !== false,
  };
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}
