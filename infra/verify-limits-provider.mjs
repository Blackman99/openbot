import { createServer } from 'node:http';
// Isolated Compose HTTP witness. Never logs request headers or provider secrets.
const calls = [];
function frame(response, value) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}
function complete(response, text) {
  frame(response, { choices: [{ delta: { content: text }, finish_reason: null }] });
  frame(response, { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } });
  frame(response, { choices: [{ delta: {}, finish_reason: 'stop' }] });
  response.end('data: [DONE]\n\n');
}
const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/stats') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ calls, pending: 0 }));
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
    const prompt = input.messages.at(-1)?.content;
    calls.push({ prompt, modelId: input.model });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    complete(response, prompt === 'limit-budget' ? 'Resumed after the grant.' : 'OK');
  } catch {
    response.destroy();
  }
});
server.listen(3100, '0.0.0.0');
process.once('SIGTERM', () => {
  server.close();
});
