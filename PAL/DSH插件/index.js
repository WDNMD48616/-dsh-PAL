import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHAT_PORT = 47322;
const PROVIDER = process.env.PAL_LLM_PROVIDER || 'deepseek-account';
const MODEL = process.env.PAL_LLM_MODEL || 'deepseek-flash';
const HISTORY_DIR = path.join(process.env.APPDATA || os.homedir(), 'PalDesktopPet', 'chat');
export const inject = ['llm'];

const SYSTEM = [
  '你是帕尔，一只住在电脑桌面上的小机器人。',
  '用简短、自然的中文回答，通常一到两句话，不要长篇大论。',
  '你有点可爱、有点好奇，但不要油腻，也不要假装是人。',
  '不要主动联网；只有用户明确点了联网问答并同意时，才使用搜索结果。',
  '不要假装记得没有在本次对话里出现过的个人信息。'
].join('');

const histories = new Map();

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}

function safeSession(value) {
  const s = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return s.slice(0, 80) || 'default';
}

function historyFile(session) {
  return path.join(HISTORY_DIR, safeSession(session) + '.json');
}

function loadHistory(session, persist) {
  const key = safeSession(session);
  if (histories.has(key)) return histories.get(key);
  let result = [];
  if (persist) {
    try {
      const parsed = JSON.parse(readFileSync(historyFile(key), 'utf8'));
      if (Array.isArray(parsed)) result = parsed.slice(-24);
    } catch { result = []; }
  }
  histories.set(key, result);
  return result;
}

function saveHistory(session, messages, persist) {
  const key = safeSession(session);
  const trimmed = messages.slice(-24);
  histories.set(key, trimmed);
  if (!persist) return;
  try {
    mkdirSync(HISTORY_DIR, { recursive: true });
    writeFileSync(historyFile(key), JSON.stringify(trimmed, null, 2), 'utf8');
  } catch { /* memory still works */ }
}

export function apply(ctx) {
  if (process.platform !== 'win32') return;

  const dir = path.dirname(fileURLToPath(import.meta.url));
  const exe = path.join(dir, 'PalPet.exe');
  let child = null;
  let server = null;

  async function webContext(text) {
    try {
      const web = ctx.get('web');
      if (!web) return '';
      const result = await web.search({ query: text, maxResults: 5 });
      const sources = Array.isArray(result.sources) ? result.sources : [];
      const parts = [];
      if (result.content) parts.push(result.content);
      for (const source of sources) {
        parts.push([source.title, source.snippet, source.url].filter(Boolean).join(' | '));
      }
      return parts.join('\n').slice(0, 6000);
    } catch (error) {
      return '联网搜索失败：' + String(error && error.message || error);
    }
  }

  async function runModel(messages, maxTokens) {
    const llm = ctx.llm || ctx.get('llm');
    if (!llm) throw new Error('llm service unavailable');
    const stream = llm.stream({
      provider: PROVIDER,
      model: MODEL,
      system: SYSTEM,
      messages,
      maxTokens,
      temperature: 0.7
    });
    let out = '';
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') out += chunk.text;
      if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
        throw new Error(chunk.reason.failure?.message || 'model failed');
      }
    }
    return out.trim();
  }

  async function chat(text, session, useWeb, persist) {
    const history = loadHistory(session, persist);
    let prompt = text;
    if (history.length) {
      const lines = history.slice(-16).map(function (m) {
        const body = Array.isArray(m.content) && m.content[0] && m.content[0].text ? m.content[0].text : '';
        return (m.role === 'assistant' ? '帕尔：' : '用户：') + body;
      });
      prompt = '之前的对话：\n' + lines.join('\n') + '\n\n现在用户说：' + text;
    }
    if (useWeb) {
      const context = await webContext(text);
      if (context) prompt += '\n\n联网搜索结果：\n' + context + '\n\n请结合搜索结果回答，不要编造。';
    }
    const reply = await runModel([{ role: 'user', content: [{ type: 'text', text: prompt }] }], 300);
    if (reply) {
      history.push({ role: 'user', content: [{ type: 'text', text }] });
      history.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
      saveHistory(session, history, persist);
    }
    return reply;
  }

  async function vision(imageBase64, prompt, session, persist) {
    const attachments = ctx.get('attachments');
    if (!attachments) throw new Error('attachments service unavailable');
    const base64 = String(imageBase64 || '').replace(/^data:image\/[a-z]+;base64,/, '');
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length) throw new Error('empty screenshot');
    const ref = await attachments.saveImage({
      data: new Uint8Array(bytes),
      mediaType: 'image/png',
      name: 'pal-screen.png'
    });
    const reply = await runModel([{
      role: 'user',
      content: [
        { type: 'text', text: String(prompt || '请描述一下我整个电脑屏幕上的内容。') },
        { type: 'image', attachment: ref }
      ]
    }], 400);
    const history = loadHistory(session, persist);
    history.push({ role: 'user', content: [{ type: 'text', text: '[看屏幕] ' + (prompt || '') }] });
    history.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
    saveHistory(session, history, persist);
    return reply;
  }

  ctx.effect(() => {
    server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      if (req.method === 'OPTIONS') { res.end(); return; }
      if (req.method === 'GET' && req.url === '/health') {
        json(res, 200, { ok: true, provider: PROVIDER, model: MODEL });
        return;
      }
      if (req.method === 'GET' && req.url === '/info') {
        Promise.resolve(ctx.llm ? ctx.llm.resolveModelInfo(PROVIDER, MODEL) : null)
          .then((info) => json(res, 200, { provider: PROVIDER, model: MODEL, info }))
          .catch((error) => json(res, 503, { error: String(error && error.message || error) }));
        return;
      }
      if (req.method === 'GET' && req.url === '/balance') {
        const account = ctx.get('deepseekAccount');
        if (!account) { json(res, 503, { error: 'account service unavailable' }); return; }
        account.getBalance({
          version: '1.0',
          locale: 'zh-CN',
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
        }).then((balance) => json(res, 200, { balance }))
          .catch((error) => json(res, 503, { error: String(error && error.message || error) }));
        return;
      }
      if (req.method !== 'POST' || (req.url !== '/chat' && req.url !== '/vision' && req.url !== '/forget')) {
        json(res, 404, { error: 'not found' });
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (part) => { body += part; if (body.length > 24000000) req.destroy(); });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');
          const session = payload.session;
          if (req.url === '/forget') {
            const key = safeSession(session);
            histories.delete(key);
            try { unlinkSync(historyFile(key)); } catch { /* already gone */ }
            json(res, 200, { ok: true });
            return;
          }
          if (req.url === '/vision') {
            const reply = await vision(payload.image, payload.prompt, session, payload.memory === true);
            json(res, 200, { reply });
            return;
          }
          const text = typeof payload.text === 'string' ? payload.text.trim() : '';
          if (!text) { json(res, 400, { error: 'empty text' }); return; }
          const reply = await chat(text, session, payload.web === true, payload.memory === true);
          json(res, 200, { reply });
        } catch (error) {
          json(res, 503, { error: String(error && error.message || error) });
        }
      });
    });
    server.on('error', () => {});
    server.listen(CHAT_PORT, '127.0.0.1');

    if (existsSync(exe)) {
      try {
        child = spawn(exe, [], {
          stdio: 'ignore',
          windowsHide: false,
          env: {
            ...process.env,
            PAL_PARENT_PID: String(process.pid),
            PAL_CHAT_URL: `http://127.0.0.1:${CHAT_PORT}/chat`
          }
        });
        child.on('exit', () => { child = null; });
        child.unref();
      } catch { child = null; }
    }

    return () => {
      if (child) { try { child.kill(); } catch { /* ignore */ } child = null; }
      if (server) { try { server.close(); } catch { /* ignore */ } server = null; }
    };
  });
}
