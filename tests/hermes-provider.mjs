// Scripted localhost model for the pinned, real Hermes gateway integration test.
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const port = Number(process.env.HQ_TEST_MODEL_PORT ?? 18761);
const markerDir = process.env.HQ_TEST_MARKER_DIR ?? '/tmp';
function toolCall(command) {
  return { tool_calls: [{ index: 0, id: 'call_hq_test', type: 'function',
    function: { name: 'terminal', arguments: JSON.stringify({ command, timeout: 40 }) } }] };
}

createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'hq-test', context_length: 256000 }] }));
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const last = body.messages.at(-1);
    const prompt = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    const log = JSON.stringify(body.messages);
    const guardian = !body.tools?.length && /APPROVE|ESCALATE/.test(log) && /DENY/.test(log);
    let parts;
    if (guardian) {
      parts = [{ content: 'ESCALATE' }];
    } else if (last.role === 'tool') {
      console.log('tool result', prompt.slice(0, 400));
      parts = [{ content: 'Tool outcome: ' }, { content: prompt }];
    } else if (prompt.includes('HQ_TEST_STOP')) {
      parts = [toolCall(`touch "${markerDir}/hq-started"; sleep 8; touch "${markerDir}/hq-finished"`)];
    } else if (prompt.includes('HQ_TEST_APPROVAL')) {
      parts = [toolCall(`rm -rf "${markerDir}/hq-approval-marker"`)];
    } else if (prompt.includes('HQ_TEST_SAME')) {
      parts = [{ content: log.includes('HQ_TEST_STREAM') ? 'Same thread.' : 'Fresh thread.' }];
    } else {
      parts = [{ content: 'Hello ' }, { content: 'from Hermes.' }];
    }

    const tool = !!parts[0].tool_calls;
    const finish = tool ? 'tool_calls' : 'stop';
    const base = { id: 'chatcmpl_hq_test', model: 'hq-test', created: 0 };
    if (!body.stream) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ...base, object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: null, ...parts[0] }, finish_reason: finish }],
        usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({
      ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }],
    }) + '\n\n');
    emit({ role: 'assistant' });
    for (const part of parts) {
      if (res.destroyed) return;
      emit(part);
      await delay(300);
    }
    emit({}, finish);
    res.end('data: [DONE]\n\n');
  } catch (e) {
    console.error(e.message);
    res.end();
  }
}).listen(port, '127.0.0.1');
