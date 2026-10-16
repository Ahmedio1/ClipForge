// ClipForge as an MCP server, driven by the official MCP client over HTTP and stdio,
// the way Claude Code / Gemini CLI / Claude Desktop would.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import ffmpegPath from 'ffmpeg-static';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'clipforge-mcp-'));
const CLIPS = path.join(TMP, 'clips');
const PORT = 7600 + Math.floor(Math.random() * 400);
const BASE = `http://localhost:${PORT}`;
let server;
let client;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClip(file, seconds, burstAt) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `aevalsrc='0.03*sin(2*PI*300*t)+if(between(t,${burstAt},${burstAt + 0.6}),0.9*(random(0)-0.5),0)':s=48000:d=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', file]);
}

const textOf = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const json = (r) => JSON.parse(textOf(r));

before(async () => {
  makeClip(path.join(CLIPS, 'TEKKEN™8 2026-10-01 20-00-00.mp4'), 8, 3);
  makeClip(path.join(CLIPS, 'TEKKEN™8 2026-10-02 21-00-00.mp4'), 6, 2);
  server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    env: { ...process.env, PORT: String(PORT), CLIPFORGE_DATA: path.join(TMP, 'data'), CLIPFORGE_CLIPS: CLIPS },
    stdio: 'ignore',
  });
  for (let i = 0; ; i++) {
    const clips = await fetch(`${BASE}/api/clips`).then((r) => r.json(), () => []);
    if (clips.length === 2) break;
    if (i > 300) throw new Error('server not ready');
    await sleep(200);
  }
  client = new Client({ name: 'clipforge-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
});

after(async () => {
  await client?.close();
  server?.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('exposes the editing tools with instructions', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  for (const n of ['list_clips', 'view_clip', 'create_montage', 'edit_montage', 'render_montage', 'view_export', 'publish_youtube']) {
    assert.ok(names.includes(n), n);
  }
  assert.match(client.getInstructions(), /fight/);
  const edit = tools.find((t) => t.name === 'edit_montage');
  assert.deepEqual(edit.inputSchema.properties.fit.enum, ['blur', 'crop', 'bars', 'follow', 'stack', 'fight']);
});

test('an AI can browse, look at and assemble a fight short, then check the render', { timeout: 300_000 }, async () => {
  const clips = json(await client.callTool({ name: 'list_clips', arguments: { query: 'tekken' } }));
  assert.equal(clips.length, 2);
  const [newer, older] = clips;

  const { highlights } = json(await client.callTool({ name: 'get_clip_highlights', arguments: { clipId: older.id } }));
  assert.ok(Math.abs(highlights[0].time - 3.4) < 0.6);

  const look = await client.callTool({ name: 'view_clip', arguments: { clipId: older.id } });
  const images = look.content.filter((c) => c.type === 'image');
  assert.ok(images.length >= 1);
  assert.equal(images[0].mimeType, 'image/jpeg');
  assert.ok(Buffer.from(images[0].data, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])));

  const created = json(await client.callTool({
    name: 'create_montage', arguments: { clipIds: [older.id, newer.id], name: 'Short IA', template: 'combat' },
  }));
  assert.equal(created.data.fit, 'fight');
  assert.equal(created.data.fps, 60);

  const edited = json(await client.callTool({
    name: 'edit_montage',
    arguments: {
      projectId: created.projectId,
      transition: 'none',
      segments: [{ clipId: older.id, start: 1, end: 5 }, { clipId: newer.id, start: 0.5, end: 3.5 }],
      texts: [{ text: 'LE COMBO 😱', start: 0, end: 2.5, position: 'top', size: 'L' }],
    },
  }));
  assert.equal(edited.duration, 7);
  assert.equal(edited.data.texts[0].text, 'LE COMBO 😱');

  const rendered = json(await client.callTool({ name: 'render_montage', arguments: { projectId: created.projectId } }));
  assert.equal(rendered.status, 'done', JSON.stringify(rendered));
  assert.ok(fs.existsSync(rendered.file));

  const check = await client.callTool({ name: 'view_export', arguments: { exportId: rendered.exportId, count: 2 } });
  assert.equal(check.content.filter((c) => c.type === 'image').length, 2);
});

test('mistakes come back as readable tool errors', async () => {
  const bad = await client.callTool({ name: 'edit_montage', arguments: { projectId: 1, segments: [{ clipId: 999, start: 0, end: 2 }] } });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /Clips inconnus : 999/);
  const missing = await client.callTool({ name: 'get_montage', arguments: { projectId: 4242 } });
  assert.equal(missing.isError, true);
  const noYoutube = await client.callTool({ name: 'publish_youtube', arguments: { exportId: 1, title: 'x' } });
  assert.equal(noYoutube.isError, true);
  assert.match(textOf(noYoutube), /YouTube/);
});

test('the endpoint refuses non-POST requests', async () => {
  assert.equal((await fetch(`${BASE}/mcp`)).status, 405);
});

test('stdio bridge (Claude Desktop style) works, and explains when ClipForge is not running', async () => {
  const bin = path.join(ROOT, 'bin/clipforge-mcp.js');
  const up = new Client({ name: 'stdio-test', version: '1.0.0' });
  await up.connect(new StdioClientTransport({ command: process.execPath, args: [bin], env: { ...process.env, CLIPFORGE_URL: BASE } }));
  assert.equal(json(await up.callTool({ name: 'list_clips', arguments: {} })).length, 2);
  await up.close();

  const down = new Client({ name: 'stdio-test', version: '1.0.0' });
  await down.connect(new StdioClientTransport({ command: process.execPath, args: [bin], env: { ...process.env, CLIPFORGE_URL: 'http://127.0.0.1:9' } }));
  const r = await down.callTool({ name: 'list_clips', arguments: {} });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /npm start/);
  await down.close();
});
