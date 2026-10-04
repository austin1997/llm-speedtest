import http from 'node:http';

let requests = [];
let catchupRequests = 0;
let tokenRequests = [];
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.url === '/test/requests') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(requests)); return; }
  if (req.url === '/test/token-requests') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(tokenRequests)); return; }
  if (req.url === '/test/reset') { requests = []; tokenRequests = []; catchupRequests = 0; res.end('ok'); return; }
  if (req.url.endsWith('/api/tags')) { res.end(JSON.stringify({ models: [{ name: 'test-qwen' }] })); return; }
  if (req.url.endsWith('/v1/models')) { res.end(JSON.stringify({ data: [{ id: 'test-qwen' }] })); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const counterRoute = req.url === '/token-api/tokenize' || req.url === '/token-preflight/tokenize' || req.url === '/token-fail/tokenize' || req.url === '/token-delay/tokenize' || req.url === '/token-llama/tokenize' || req.url === '/token-versioned/v1/tokenize' || req.url === '/token-responses/v1/responses/input_tokens';
  if (counterRoute) {
    const responses = req.url.includes('/responses/');
    const llama = req.url.startsWith('/token-llama');
    const text = responses ? body.input?.[0]?.content : llama ? body.content : body.prompt;
    if (typeof text !== 'string') { res.writeHead(400); res.end('{}'); return; }
    const count = Array.from(text).length;
    tokenRequests.push({ url: req.url, text, body, at: Date.now(), hasAuth: Boolean(req.headers.authorization) });
    const failed = req.url.startsWith('/token-fail') && text.startsWith('abcd');
    const delay = req.url.startsWith('/token-preflight') || req.url.startsWith('/token-delay') && text.startsWith('abcd') ? 1000 : 5;
    const timer = setTimeout(() => {
      res.setHeader('Content-Type', 'application/json');
      if (failed) { res.writeHead(503); res.end('{}'); }
      else res.end(JSON.stringify(responses ? { object: 'response.input_tokens', input_tokens: 7 + count } : llama ? { tokens: Array.from({ length: count }, (_, i) => i) } : { count }));
    }, delay);
    res.on('close', () => clearTimeout(timer));
    return;
  }
  if (req.url.endsWith('/api/show')) { res.end(JSON.stringify({ capabilities: ['completion', 'thinking'], model_info: { 'qwen.context_length': 32768 }, thinking: { values: [false, true], default: true } })); return; }
  if (!req.url.endsWith('/api/chat') && !req.url.endsWith('/v1/chat/completions')) { res.writeHead(404); res.end(); return; }
  requests.push({ url: req.url, body, at: Date.now() });
  if (req.url.startsWith('/error')) { res.writeHead(503); res.end(JSON.stringify({ error: 'fixture overloaded' })); return; }
  const openai = req.url.includes('/v1/');
  const thinking = body.think === true || body.reasoning_effort === 'medium' || body.chat_template_kwargs?.enable_thinking === true;
  res.setHeader('Content-Type', openai ? 'text/event-stream' : 'application/x-ndjson');
  const emit = data => res.write(openai ? `data: ${JSON.stringify(data)}\n\n` : JSON.stringify(data) + '\n');
  if (req.url.startsWith('/catchup')) {
    const first = ++catchupRequests % 2 === 1;
    const content = tokens => emit({ message: { content: 'abcd'.repeat(tokens) }, done: false });
    const timers = first ? [
      setTimeout(() => content(100), 100),
      setTimeout(() => { emit({ done: true, eval_count: 20 }); res.end(); }, 700),
    ] : [
      setTimeout(() => content(20), 300),
      setTimeout(() => content(40), 1800),
      setTimeout(() => content(60), 2800),
      setTimeout(() => { emit({ done: true, eval_count: 120 }); res.end(); }, 4800),
    ];
    res.on('close', () => timers.forEach(clearTimeout));
    return;
  }
  const standardPieces = thinking ? [{ reasoning: '先检查输入数据。\n' }, { content: '部署响应稳定，' }, { content: '吞吐表现良好。' }] : [{ content: '部署响应稳定，' }, { content: '吞吐表现良好。' }, { content: '\n<script>window.injected=true</script>' }];
  const racing = req.url.startsWith('/race-fast') || req.url.startsWith('/race-slow');
  const tokenStream = req.url.startsWith('/token-');
  const pieces = tokenStream ? Array.from({ length: req.url.startsWith('/token-delay') ? 60 : 12 }, () => ({ content: 'abcd'.repeat(4) })) : racing ? Array.from({ length: 60 }, () => ({ content: 'abcd'.repeat(req.url.startsWith('/race-fast') ? 8 : 2) })) : req.url.startsWith('/dashboard') ? Array.from({ length: 60 }, (_, i) => ({ content: `流式输出 ${i + 1}: ${'The benchmark measures latency, throughput, and concurrent requests. All output is preserved within its own scrollable window. '.repeat(10)}\n` })) : standardPieces;
  let index = 0;
  const timer = setInterval(() => {
    if (index < pieces.length) {
      const piece = pieces[index++];
      emit(openai ? { choices: [{ delta: { reasoning_content: piece.reasoning, content: piece.content } }] } : { message: { thinking: piece.reasoning, content: piece.content }, done: false });
    } else {
      if (openai) {
        emit({ choices: [{ delta: {}, finish_reason: 'length' }] });
        if (body.stream_options?.include_usage) emit({ choices: [], usage: { prompt_tokens: 111, completion_tokens: tokenStream ? 192 : 24, completion_tokens_details: { reasoning_tokens: thinking ? 8 : 0 } } });
        res.end('data: [DONE]\n\n');
      } else { emit({ done: true, done_reason: 'length', prompt_eval_count: 111, prompt_eval_cached_count: 10, eval_count: 24, eval_duration: 800000000, prompt_eval_duration: 100000000, load_duration: 20000000 }); res.end(); }
      clearInterval(timer);
    }
  }, tokenStream ? 150 : req.url.startsWith('/race-fast') ? 100 : req.url.startsWith('/race-slow') ? 200 : req.url.startsWith('/slow') ? 3000 : req.url.startsWith('/scroll') ? 600 : req.url.startsWith('/dashboard') ? 150 : 180);
  res.on('close', () => clearInterval(timer));
});
server.listen(4174, '127.0.0.1', () => console.log('Benchmark fixtures on http://127.0.0.1:4174'));
