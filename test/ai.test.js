// AI features against a fake Anthropic API, a fake OpenAI-compatible API, and (when it runs on
// this machine) the real local Ollama.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import ffmpegPath from 'ffmpeg-static';
import { extractJson } from '../server/ai-json.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'clipforge-ai-'));
const CLIPS = path.join(TMP, 'clips');
const PORT = 6500 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
let server;
let fakeClaude;
let fakeOpenAi;
let log = '';
const claudeCalls = [];
const openAiCalls = [];
let claudeRefuses = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (url, opts = {}) => {
  const res = await fetch(BASE + url, { ...opts, headers: opts.body ? { 'content-type': 'application/json' } : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const post = (url, data) => api(url, { method: 'POST', body: JSON.stringify(data ?? {}) });
const put = (url, data) => api(url, { method: 'PUT', body: JSON.stringify(data) });

async function waitJob(job, timeout = 600_000) {
  const t0 = Date.now();
  for (;;) {
    const { body } = await api(`/api/jobs/${job.id}`);
    if (body.status === 'done') return body.result;
    if (body.status === 'failed') throw new Error(body.error);
    if (Date.now() - t0 > timeout) throw new Error(`job timeout\n${log.slice(-1500)}`);
    await sleep(300);
  }
}

/** What a fake model answers, chosen from the JSON schema it was asked for. */
function fakeAnswer(schema, prompt) {
  const req = schema.required || [];
  if (req.includes('title')) return { title: 'ACE en 3 secondes', description: 'Le clutch de ma vie', hashtags: ['#tekken8', 'fgc'] };
  if (req.includes('hooks')) return { hooks: ['Il a pas vu venir 😱', 'Le combo parfait'] };
  if (req.includes('keep')) return { keep: [2, 1], reject: [3] };
  if (req.includes('ok')) return { ok: true, message: 'Salut champion' };
  if (req.includes('explanation')) {
    const clips = JSON.parse(prompt.split('Clips disponibles :\n')[1].split('\nDemande :')[0]);
    return {
      explanation: 'J’ai gardé le meilleur moment et ajouté un titre.',
      format: 'vertical', fit: 'fight', fps: 60, transition: 'none', transitionDuration: 0.3,
      segments: [{ clipId: clips[0].id, start: 1, end: 4 }, { clipId: 99999, start: 0, end: 2 }],
      texts: [{ text: 'TOP 1', start: 0, end: 2, position: 'top', size: 'L' }],
    };
  }
  return {};
}

function startFakeClaude() {
  return new Promise((resolve) => {
    fakeClaude = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const json = (code, data) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.headers['x-api-key'] !== 'sk-ant-test') return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      if (req.url.startsWith('/v1/models')) {
        return json(200, { data: [{ type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-opus-5-5' });
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      claudeCalls.push({ headers: req.headers, body });
      const prompt = body.messages[0].content.find((b) => b.type === 'text').text;
      json(200, {
        id: 'msg_1', type: 'message', role: 'assistant', model: body.model,
        content: claudeRefuses ? [] : [{ type: 'text', text: JSON.stringify(fakeAnswer(body.output_config.format.schema, prompt)) }],
        stop_reason: claudeRefuses ? 'refusal' : 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      });
    });
    fakeClaude.listen(0, resolve);
  });
}

function startFakeOpenAi() {
  return new Promise((resolve) => {
    fakeOpenAi = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const json = (code, data) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.url === '/v1/models') return json(200, { data: [{ id: 'small-model' }, { id: 'big-model' }] });
      const body = JSON.parse(Buffer.concat(chunks).toString());
      openAiCalls.push({ auth: req.headers.authorization, body });
      // this provider doesn't know strict JSON schemas: ClipForge must fall back to JSON mode
      if (body.response_format?.type === 'json_schema') return json(400, { error: { message: 'response_format json_schema is not supported' } });
      const schema = JSON.parse(body.messages[0].content.split('conforme à ce schéma :\n')[1]);
      json(200, { choices: [{ message: { role: 'assistant', content: `\`\`\`json\n${JSON.stringify(fakeAnswer(schema, ''))}\n\`\`\`` } }] });
    });
    fakeOpenAi.listen(0, resolve);
  });
}

function makeClip(file, seconds = 8, burstAt = 3) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `aevalsrc='0.03*sin(2*PI*300*t)+if(between(t,${burstAt},${burstAt + 0.6}),0.9*(random(0)-0.5),0)':s=48000:d=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', file]);
}

const ollamaUp = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) })
  .then((r) => r.json()).then((d) => d.models.some((m) => m.name.startsWith('gemma3:4b')), () => false);

before(async () => {
  makeClip(path.join(CLIPS, 'TEKKEN™8 2026-10-01 20-00-00.mp4'), 8, 3);
  makeClip(path.join(CLIPS, 'TEKKEN™8 2026-10-02 21-00-00.mp4'), 8, 5);
  await startFakeClaude();
  await startFakeOpenAi();
  server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    env: {
      ...process.env, PORT: String(PORT), CLIPFORGE_DATA: path.join(TMP, 'data'), CLIPFORGE_CLIPS: CLIPS,
      CLIPFORGE_ANTHROPIC_BASE_URL: `http://127.0.0.1:${fakeClaude.address().port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; ; i++) {
    const { body } = await api('/api/clips').catch(() => ({ body: [] }));
    if (body?.length === 2) break;
    if (i > 300) throw new Error(`fixtures not scanned\n${log}`);
    await sleep(200);
  }
});

after(() => {
  server?.kill();
  fakeClaude?.close();
  fakeOpenAi?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('extractJson tolerates fences and chatter', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Voici : {"a": {"b": 2}} voilà'), { a: { b: 2 } });
  assert.throws(() => extractJson('rien'), /illisible/);
});

test('provider settings: keys required, stored privately, never sent back', async () => {
  assert.equal((await put('/api/ai/providers/claude', { preset: 'anthropic' })).status, 400);
  const { body } = await put('/api/ai/providers/claude', { preset: 'anthropic', apiKey: 'sk-ant-test' });
  const p = body.providers.find((x) => x.id === 'claude');
  assert.equal(p.model, 'claude-opus-5-5');
  assert.equal(p.keyHint, 'sk-a…test');
  assert.ok(!JSON.stringify(body).includes('sk-ant-test'));
  assert.equal(body.active, 'claude');
  const stat = fs.statSync(path.join(TMP, 'data', 'ai.json'));
  assert.equal(stat.mode & 0o077, 0, 'ai.json readable by the owner only');
  // saving again without a key keeps the stored one
  await put('/api/ai/providers/claude', { preset: 'anthropic', model: 'claude-opus-5-5' });
  assert.deepEqual((await api('/api/ai/providers/claude/models')).body, ['claude-opus-5-5']);
});

test('Claude: structured JSON, images, refusal fallback enabled', async () => {
  const { body: clips } = await api('/api/clips');
  const { body: job } = await post(`/api/clips/${clips[0].id}/export`, { start: 0, end: 6, format: 'vertical-blur' });
  for (let i = 0; i < 200; i++) {
    const e = (await api('/api/exports')).body.find((x) => x.id === job.id);
    if (e.status === 'done') break;
    await sleep(300);
  }
  const before = claudeCalls.length;
  const out = await waitJob((await post('/api/ai/publish-text', { exportId: job.id, platform: 'tiktok' })).body);
  assert.deepEqual(out, { title: 'ACE en 3 secondes', description: 'Le clutch de ma vie', hashtags: ['tekken8', 'fgc'] });

  const call = claudeCalls[before];
  assert.equal(call.body.model, 'claude-opus-5-5');
  assert.equal(call.body.fallbacks, 'default');
  assert.match(call.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(call.body.output_config.format.type, 'json_schema');
  assert.equal(call.body.output_config.effort, 'low');
  const images = call.body.messages[0].content.filter((b) => b.type === 'image');
  assert.equal(images.length, 3);
  assert.equal(images[0].source.media_type, 'image/jpeg');
  assert.ok(Buffer.from(images[0].source.data, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), 'real JPEG');
  assert.match(call.body.system, /monteur/);

  claudeRefuses = true;
  await assert.rejects(waitJob((await post('/api/ai/publish-text', { exportId: job.id, platform: 'x' })).body), /refusé/);
  claudeRefuses = false;
});

test('hook ideas and AI-ranked best-of', async () => {
  const { body: clips } = await api('/api/clips');
  const { body: project } = await post('/api/projects', { clipIds: clips.map((c) => c.id) });
  const { hooks } = await waitJob((await post('/api/ai/hooks', { projectId: project.id })).body);
  assert.deepEqual(hooks, ['Il a pas vu venir 😱', 'Le combo parfait']);

  const { projectId } = await waitJob((await post('/api/projects/auto', { clipIds: clips.map((c) => c.id), ai: true })).body);
  const { body: best } = await api(`/api/projects/${projectId}`);
  assert.match(best.name, /Best-of IA/);
  assert.ok(best.data.segments.length >= 1 && best.data.segments.length <= 2, 'rejected candidates dropped');
  const call = claudeCalls.at(-1);
  assert.ok(call.body.messages[0].content.filter((b) => b.type === 'image').length >= 2);
});

test('montage assistant edits the project, ignores unknown clips, and can be undone', async () => {
  const { body: clips } = await api('/api/clips');
  const { body: project } = await post('/api/projects', { clipIds: [clips[1].id], data: { fit: 'blur' } });
  const result = await waitJob((await post('/api/ai/director', { projectId: project.id, instruction: 'Fais un short de combat avec un titre' })).body);
  assert.match(result.explanation, /meilleur moment/);
  const { body: edited } = await api(`/api/projects/${project.id}`);
  assert.equal(edited.data.fit, 'fight');
  assert.equal(edited.data.segments.length, 1, 'made-up clip id 99999 dropped');
  assert.deepEqual([edited.data.segments[0].start, edited.data.segments[0].end], [1, 4]);
  assert.equal(edited.data.texts[0].text, 'TOP 1');
  assert.equal(edited.canUndo, true);

  const { body: undone } = await post(`/api/projects/${project.id}/undo`);
  assert.equal(undone.data.fit, 'blur');
  assert.equal(undone.canUndo, false);
  assert.equal((await post(`/api/projects/${project.id}/undo`)).status, 400);
});

test('OpenAI-compatible provider: falls back to JSON mode, lists models, switches active', async () => {
  const baseUrl = `http://127.0.0.1:${fakeOpenAi.address().port}/v1`;
  await put('/api/ai/providers/autre', { preset: 'custom', baseUrl, apiKey: 'k-123', model: 'small-model' });
  assert.deepEqual((await api('/api/ai/providers/autre/models')).body, ['big-model', 'small-model']);
  const r = await waitJob((await post('/api/ai/providers/autre/test')).body);
  assert.deepEqual(r, { ok: true, message: 'Salut champion' });
  assert.equal(openAiCalls.length, 2, 'json_schema refused, then JSON mode');
  assert.equal(openAiCalls[1].body.response_format.type, 'json_object');
  assert.equal(openAiCalls[1].auth, 'Bearer k-123');

  const { body } = await put('/api/ai/active', { id: 'autre' });
  assert.equal(body.active, 'autre');
  const { hooks } = await waitJob((await post('/api/ai/hooks', { projectId: (await api('/api/projects')).body[0].id })).body);
  assert.ok(hooks.length);
  await put('/api/ai/active', { id: 'claude' });
});

test('local Ollama (real model) writes publication texts', { skip: !ollamaUp && 'Ollama with gemma3:4b not running', timeout: 900_000 }, async () => {
  await put('/api/ai/providers/local', { preset: 'ollama' });
  await put('/api/ai/active', { id: 'local' });
  const exp = (await api('/api/exports')).body.find((e) => e.status === 'done');
  const out = await waitJob((await post('/api/ai/publish-text', { exportId: exp.id, platform: 'youtube' })).body);
  assert.ok(out.title.length > 3, `title: ${out.title}`);
  assert.ok(out.description.length > 3);
  assert.ok(out.hashtags.length >= 1 && out.hashtags.every((h) => !h.startsWith('#') && !/\s/.test(h)));
  await put('/api/ai/active', { id: 'claude' });
});
