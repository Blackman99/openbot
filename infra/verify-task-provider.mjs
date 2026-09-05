import { createServer } from 'node:http';

// The fixture deliberately holds a real model stream open so the smoke can
// inspect committed running state while the HTTP API process is stopped.
const pending = new Set();
const calls = [];
function frame(response, value) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}
function complete(response, text) {
  frame(response, { choices: [{ delta: { content: text }, finish_reason: null }] });
  for (let index = 0; index < 2; index++)
    frame(response, { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } });
  frame(response, { choices: [{ delta: {}, finish_reason: 'stop' }] });
  response.end('data: [DONE]\n\n');
}
const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/stats') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ calls, pending: pending.size }));
    return;
  }
  if (request.method === 'POST' && request.url === '/release') {
    for (const output of pending) complete(output, 'Persisted separate worker response.');
    pending.clear();
    response.end('released');
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end();
    return;
  }
  if (request.headers.authorization !== 'Bearer compose-private-provider-key') {
    response.writeHead(401).end();
    return;
  }
  try {
    let text = '';
    for await (const chunk of request) {
      text += chunk.toString();
      if (text.length > 2 * 1024 * 1024) throw new Error('fixture input too large');
    }
    const input = JSON.parse(text);
    if (input.tools) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'unsupported_parameter', param: 'tools' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const prompt = input.messages.at(-1)?.content;
    if (prompt === 'compose-success' || prompt === 'compose-failure') {
      calls.push({ prompt, modelId: input.model });
      if (prompt === 'compose-failure') {
        frame(response, { choices: [{ delta: { content: 'Unpublished partial text.' } }] });
        frame(response, {
          error: { code: 'server_error', message: 'private upstream diagnostic fixture' },
        });
        response.end();
      } else {
        response.flushHeaders();
        pending.add(response);
        response.once('close', () => pending.delete(response));
      }
      return;
    }
    complete(response, 'OK');
  } catch {
    response.destroy();
  }
});
server.listen(3100, '0.0.0.0');
process.once('SIGTERM', () => {
  for (const response of pending) response.destroy();
  server.close();
});
