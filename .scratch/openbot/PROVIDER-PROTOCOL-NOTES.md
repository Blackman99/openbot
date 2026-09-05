# Provider protocol implementation notes

Reviewed against primary documentation on 2026-09-05. These are preparation notes for PROV-03 and PROV-04; neither ticket may start before PROV-01 merges.

## OpenAI Responses

Sources:

- https://developers.openai.com/api/docs/guides/streaming-responses
- https://developers.openai.com/api/docs/guides/function-calling

Responses uses typed SSE events. Text deltas arrive as `response.output_text.delta`; successful completion is `response.completed`. An `error` event can occur inside the stream.

Function calls begin in `response.output_item.added` with a function-call item containing the name, item ID, and call ID. Argument fragments arrive as `response.function_call_arguments.delta`, keyed by output index and item ID. The completed argument string also appears in `response.function_call_arguments.done` and the final item in `response.output_item.done`. Multiple output items can coexist.

Implementation decisions: accumulate arguments separately for each call, validate them only when complete, and emit one normalized action per call. Receiving EOF alone must not produce a successful completion. Final item snapshots must not duplicate deltas already delivered. Keep protocol selection explicit in the connection rather than guessing from the endpoint. Exclude hosted tools.

## Anthropic Messages

Source: https://platform.claude.com/docs/en/build-with-claude/streaming

Streaming starts with `message_start`, contains indexed content blocks with start/delta/stop events, then ends with `message_delta` and `message_stop`. Ping events may appear. Usage in message deltas is cumulative. Text deltas use `text_delta`; tool arguments use `input_json_delta.partial_json`, collected per block index and parsed after the block stops. A `tool_use` block carries its ID and name. The stop reason can be `tool_use`. Errors may occur after the HTTP response starts, including `overloaded_error`. Unknown event types should be tolerated for forward compatibility.

Implementation decisions: normalize text, tool actions, usage, and stop reasons through the same provider contract. An unknown event is not evidence of completion. Drop the connection on cancellation, and require `message_stop` for normal streamed completion. Do not interpret hosted tool blocks as local collaboration actions.

## Shared local requirements

The approved tickets and PROV-01 implementation remain authoritative for URL policy, encrypted credentials, error redaction, timeout/cancellation, and evidence storage. Text-compatible connections remain usable when a structured-action probe is unsupported. Reuse the same transport policy instead of creating protocol-specific fetch paths. Probe tests need independent mock servers and must not call paid providers.
