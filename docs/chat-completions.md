# Local Chat Completions for agentic clients

The optional general-client API implements a **text/function subset** of OpenAI
Chat Completions. It uses the existing Web worker, browser slots, strict composer
checks, cancellation/cleanup, and shared account-safety guard. It is not another
provider framework or a Native2 capability endpoint.

**Default: disabled.** Candidate functionality requires installed Windows testing
before release promotion. The real pi CLI has an explicit offline integration
probe; a scripted model worker in that probe is not signed-in ChatGPT inference.

## Enable local admission

Start the daemon with `CODEX_CHATGPT_WEB_API_KEY` set to a random 32..512-character
printable ASCII secret. It must differ from the native/admin `controlToken`.
The listener must bind `127.0.0.1`. The same API key must be available to the client.
The key is never written to application configuration, Activity or model prompts.
It is a local admission key, not a ChatGPT cookie, OAuth token or account credential.

For example, generate the value in PowerShell without displaying it:

```powershell
$env:CODEX_CHATGPT_WEB_API_KEY = bun -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))'
```

Start/restart the daemon with this environment, and launch pi from an environment
containing the same value. Do not paste the value into Git, an issue, a prompt, or
`models.json`. An already-running daemon does not acquire later environment changes.
Unsetting the variable and restarting a fully drained daemon disables this API.
No new account/profile manager or login-token storage is involved.

The general key can access only:

| Method | Path | Contract |
|---|---|---|
| GET | `/v1/models` | Configured available automatic Web models only; no native passthrough |
| POST | `/v1/chat/completions` | JSON completion or Chat Completions SSE |

Requests require `Authorization: Bearer <key>` and POST uses `application/json`.
Host, peer address and optional Origin must be loopback; cross-site browser
requests are rejected. No wildcard CORS. Compressed request bodies are not
supported. Bodies are bounded at 4 MiB and 30 seconds. The general key is refused
on admin, health, Responses, Messages, compact, launcher and unknown routes.
Existing native client routes remain separate and unchanged for native clients.

## Unmodified pi configuration

The verified external client is **pi coding agent 0.86.1**, package
`@earendil-works/pi-coding-agent`, using `openai-completions` (Chat Completions,
not the legacy `/v1/completions` endpoint). No pi extension or source patch is used.
Merge this provider into the user's standard `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "enhanced": {
      "baseUrl": "http://127.0.0.1:17841/v1",
      "api": "openai-completions",
      "apiKey": "$CODEX_CHATGPT_WEB_API_KEY",
      "authHeader": true,
      "models": [
        {
          "id": "chatgpt-web/high",
          "name": "Enhanced High",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 80000,
          "maxTokens": 16384,
          "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
          "compat": {
            "supportsStore": false,
            "supportsDeveloperRole": true,
            "supportsReasoningEffort": false,
            "supportsUsageInStreaming": false,
            "supportsStrictMode": false,
            "maxTokensField": "max_tokens"
          }
        }
      ]
    }
  }
}
```

Select `pi --provider enhanced --model chatgpt-web/high --thinking off`. The model
route fixes Web effort; `reasoning: false` only prevents unsupported pi reasoning
parameters, not the model's actual reasoning. Adjust the port to the running
daemon. Add another ID only if the restricted model catalog exposes it; there is
no model or effort fallback. Client context values are configuration hints, not
provider-measured usage or proof that every escaped history will fit preflight.
The zero cost fields are UI placeholders, **not free-service or zero-usage claims**.

In pi `settings.json`, disable automatic retries for this candidate:

```json
{"retry":{"enabled":false,"provider":{"maxRetries":0}}}
```

Every POST is a new request. Disabling retries prevents a client transport error
from initiating a second model request whose previous completion is uncertain.
The server does not turn a lack of canonical native identity into text-hash dedup.

## Supported subset and deliberate rejections

`model` and nonempty `messages` are required. Roles system/developer/user/assistant/
tool preserve their order and text. Text content parts are accepted; non-text parts
are rejected. `assistant.tool_calls` and `tool.tool_call_id` must pair exactly.
Historical functions need not still be in this request's tool list. Unknown,
duplicate or missing result IDs are rejected instead of guessed.

Current tools must be `type: "function"` with bounded Draft-07 object schemas.
Arguments are checked without coercion, defaults, repairs or property deletion.
Numeric values must be finite; integer parameters and schema bounds must be safely
representable in JavaScript. Larger exact integers must be modeled as strings;
remote schema references and decoder-level `strict: true` are not supported.
`auto`, `none`, `required`, a named function choice and `parallel_tool_calls: false`
are enforced. Invalid or incomplete model output becomes a protocol error, not a
fabricated successful answer or a runnable partially repaired call.

`stream` defaults false. Streaming emits `chat.completion.chunk`, role/content or
indexed `delta.tool_calls`, one final finish reason and one `[DONE]` on success.
Functions are buffered until the completed current assistant output is validated;
the internal JSON envelope is never streamed as prose. This adds first-content
latency in tool-enabled requests. Plain text uses verified append-only worker
output. An error after headers emits a standard error frame, **not** Responses
events and not a successful `[DONE]`. The SSE queue has a 4 MiB byte ceiling; a
stalled consumer that exceeds it aborts the original execution and errors the
transport, rather than buffering unlimited frame overhead. In pi JSON print mode, inspect the assistant
`stopReason: "error"`; the tested CLI can exit 0 even for that model error.

`max_tokens` accepts 1..65536, default 16384. The bridge counts client-visible
output using pinned `tiktoken`/`o200k_base`, not JS characters or provider billing.
For prose it returns a conservative valid Unicode prefix and cancels/settles the
worker on reaching the limit; it never retracts already-streamed text. For calls,
the complete content plus serialized standard tool-call objects (including IDs)
is counted after validation; over-budget calls are not emitted, and completion
uses `length`. Partial arguments are never executable output. This is not a limit
on unexposed reasoning or a decoder-level generation setting. Request lifetime is
also finite (the worker's configured bound, otherwise 10 minutes, including queueing).
Cleanup uncertainty remains an error, even after an output limit.

Usage is omitted rather than invented. `stream_options.include_usage: true`,
`max_completion_tokens`, temperature/top_p/seed/penalties/stop/logprobs,
response_format/strict output, n other than 1, store true, images/audio/files,
legacy functions/function_call, native metadata and unknown semantic fields are
explicitly unsupported. `store: false`, `n: 1` and omitted/null inactive controls
are accepted as documented by the parser. The API does not control ChatGPT's own
website retention policy.

## History and authority

pi executes its own tools and returns their results in full history on the next
request. Each request compiles that history into a **fresh Temporary Chat**.
There is no API retained-conversation pool, previous_response_id, cross-account
continuation, fabricated Codex environment, local broker registration, Native2
connector or automatic terminal/file execution. Tools named like native tools
are still merely validated data returned to pi.

Shared rolling admission counts these Web sessions. Guard stops and drain state
are honored; service warnings stop new work, and a general request cannot bypass
those protections by choosing a native model ID. User-side tool effects already
performed by pi cannot be rolled back by cancelling a later Web request.

## Verification and Windows gate

From an existing development checkout with installed dependencies:

```sh
bun test tests/chat-completions-contract.test.ts tests/chat-completions-runtime.test.ts tests/chat-completions-http.test.ts
bun run scripts/check-chat-completions-pi.ts --pi=/path/to/pi/dist/bundle/cli.js --node=/path/to/node
```

The explicit pi probe creates disposable directories, disables extensions/skills/
context discovery/startup network, generates a disposable local key, and exercises
real pi read/write tools only inside an inert fixture directory. It uses production
HTTP parsing, compiler, runtime capability isolation and output decoding with a
scripted worker. It also verifies SDK-visible SSE failure and RPC cancellation.
It never opens ChatGPT, uses a login profile, installs clients, or calls a real model.
The result under `tmp/chat-completions/pi-result.json` contains only safe metadata.

Before promotion, on the maintainer's Windows installed candidate: confirm the
same standard pi configuration completes at least two actual model/tool rounds,
check tool ID/results and fresh chats, test cancellation/error handling, verify
no Native2 capability for the general key, then recheck existing Codex/Claude
flows. Use only an inert test directory and minimal authorized Web requests.
A security/rate-limit signal stops validation without retries or account switching.
No automatic release or promotion is authorized by these offline results.
