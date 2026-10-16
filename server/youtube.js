import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DATA_DIR } from './config.js';
import { db } from './db.js';

// Overridable so the test suite can point at a fake Google.
const AUTH_URL = process.env.YT_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.YT_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const API_BASE = process.env.YT_API_BASE || 'https://www.googleapis.com';
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

const STORE = path.join(DATA_DIR, 'youtube.json');
let store = {};
try {
  store = JSON.parse(fs.readFileSync(STORE, 'utf8'));
} catch {
  // not configured yet
}
const save = () => fs.writeFileSync(STORE, JSON.stringify(store, null, 2), { mode: 0o600 });

let pendingState = null;

export function status(redirectUri) {
  return {
    configured: !!(store.clientId && store.clientSecret),
    connected: !!store.refreshToken,
    channel: store.channel || null,
    redirectUri,
  };
}

export function setCredentials({ clientId, clientSecret }) {
  clientId = String(clientId || '').trim();
  clientSecret = String(clientSecret || '').trim();
  if (!clientId || !clientSecret) throw new Error('Client ID et secret requis');
  store = { clientId, clientSecret };
  save();
}

export function authUrl(redirectUri) {
  if (!store.clientId) throw new Error('Identifiants YouTube non configurés');
  pendingState = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: store.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state: pendingState,
  });
  return `${AUTH_URL}?${params}`;
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: store.clientId, client_secret: store.clientSecret, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `Erreur OAuth ${res.status}`);
  return data;
}

async function api(pathname, init = {}) {
  const res = await fetch(`${API_BASE}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${await accessToken()}`, ...init.headers },
  });
  if (!res.ok) throw new Error(await apiError(res));
  return res;
}

async function apiError(res) {
  const body = await res.json().catch(() => null);
  return body?.error?.message || `YouTube a répondu ${res.status}`;
}

export async function handleCallback({ code, state, error }, redirectUri) {
  if (error) throw new Error(`Autorisation refusée : ${error}`);
  if (!state || state !== pendingState) throw new Error('État OAuth invalide, recommence la connexion');
  pendingState = null;
  const tokens = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri });
  if (!tokens.refresh_token) throw new Error('Google n’a pas renvoyé de refresh token');
  store.refreshToken = tokens.refresh_token;
  store.accessToken = tokens.access_token;
  store.expiresAt = Date.now() + (tokens.expires_in || 3600) * 1000;
  save();

  const res = await api('/youtube/v3/channels?part=snippet&mine=true');
  const channel = (await res.json()).items?.[0];
  store.channel = channel ? { id: channel.id, title: channel.snippet.title } : null;
  save();
}

async function accessToken() {
  if (!store.refreshToken) throw new Error('Compte YouTube non connecté');
  if (store.accessToken && store.expiresAt > Date.now() + 60_000) return store.accessToken;
  const tokens = await tokenRequest({ refresh_token: store.refreshToken, grant_type: 'refresh_token' });
  store.accessToken = tokens.access_token;
  store.expiresAt = Date.now() + (tokens.expires_in || 3600) * 1000;
  save();
  return store.accessToken;
}

export function disconnect() {
  const { clientId, clientSecret } = store;
  store = { clientId, clientSecret };
  save();
}

/** Resumable upload (https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol). */
export async function upload(file, meta, onProgress) {
  const size = fs.statSync(file).size;
  const body = {
    snippet: {
      title: meta.title.slice(0, 100),
      description: (meta.description || '').slice(0, 5000),
      tags: meta.tags || [],
      categoryId: '20', // Gaming
    },
    status: {
      privacyStatus: meta.publishAt ? 'private' : meta.privacy,
      selfDeclaredMadeForKids: false,
      ...(meta.publishAt ? { publishAt: new Date(meta.publishAt).toISOString() } : {}),
    },
  };

  const init = await api('/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-length': String(size),
      'x-upload-content-type': 'video/mp4',
    },
    body: JSON.stringify(body),
  });
  const location = init.headers.get('location');
  if (!location) throw new Error('YouTube n’a pas fourni d’URL d’envoi');

  let sent = 0;
  const stream = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  stream.on('data', (chunk) => {
    sent += chunk.length;
    onProgress(Math.min(0.99, sent / size));
  });
  const res = await fetch(location, {
    method: 'PUT',
    headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'video/mp4', 'content-length': String(size) },
    body: Readable.toWeb(stream),
    duplex: 'half',
  });
  if (!res.ok) throw new Error(await apiError(res));
  const video = await res.json();
  return { id: video.id, url: meta.short ? `https://youtube.com/shorts/${video.id}` : `https://youtu.be/${video.id}` };
}

// ---- Publication queue --------------------------------------------------------

const queue = [];
let busy = false;

export function enqueueYoutube(publicationId, file, meta) {
  queue.push({ publicationId, file, meta });
  pump();
}

async function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const job = queue.shift();
  const set = (sql, ...args) => db.prepare(`UPDATE publications SET ${sql} WHERE id = ?`).run(...args, job.publicationId);
  set(`status = 'running'`);
  let last = 0;
  try {
    const result = await upload(job.file, job.meta, (p) => {
      if (Date.now() - last > 400) {
        last = Date.now();
        set('progress = ?', p);
      }
    });
    set(`status = 'done', progress = 1, remote_id = ?, url = ?`, result.id, result.url);
  } catch (err) {
    set(`status = 'failed', error = ?`, err.message);
  } finally {
    busy = false;
    pump();
  }
}
