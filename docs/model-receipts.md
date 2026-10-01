# ChatGPT Web model receipts

The Web adapter emits a provider-private `chatgpt_model_receipt` diagnostic marker when an owned
conversation response contains one unambiguous network `resolved_model_slug`. The current launcher
records that structured marker through its existing daemon stdout/runtime log path; it is not a new
direct Activity IPC event. This is diagnostic evidence for the model that answered; it does not
change the public Responses `model` field, which continues to report the requested Web route.

The receipt keeps the request-side values separate:

- `requestedModel` is the native Responses route.
- `backendContextModel` is the adapter's internal context model, when it differs (for example,
  `gpt-5.6-sol` while a Pro Web route is requested).
- `browserRequestModel`, `defaultModelSlug`, `requestedModelSlug`, and `modelSlug` are retained as
  separate routing observations.
- `servedModel` is emitted only from `resolved_model_slug` in an owned network response.

DOM attributes, HTTP status, assistant/user prose, attachment metadata, and a missing or conflicting
`resolved_model_slug` never substitute for a served model. Chromium network bytes are streamed
through strict allowlists and bounded event/node/byte limits; response bodies are never
materialized by the observer. A completed browser answer may be followed by a bounded 750 ms
telemetry-only terminal drain so `Network.loadingFinished` can settle; this drain is separate from
inference and never retries or cancels the request. Only the current activated
`POST /backend-api/f/conversation` is eligible. Receipts are one-per-physical-Send, retain retry
attempt and provenance, and hash conversation/message identifiers before logging.

Each activated Send also emits one bounded diagnostic outcome through the same helper transport,
including unavailable-CDP, missing-metadata, conflict, bounded, and resolved outcomes. These
diagnostics contain counters and reason codes only; they never substitute a served model.

The production observer uses the exact `https://chatgpt.com/backend-api/f/conversation` URL. The
offline CDP integration test supplies a loopback URL only through an explicit constructor seam for
its self-owned fixture; it does not broaden the production predicate.

This parser was implemented clean-room for this project. Its field-selection and stream-observation
design was informed by the public [Lex-au/chatgpt-receipts](https://github.com/Lex-au/chatgpt-receipts)
extension, released under the MIT license; no extension source or UI/storage code is included here.
