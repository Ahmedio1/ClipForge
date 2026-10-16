// AI providers: Claude through the official SDK, and every OpenAI-compatible API (OpenAI,
// Gemini, Mistral, Groq, OpenRouter, DeepSeek, Ollama, LM Studio…) through one adapter.
// All features ask for a JSON object matching a schema and get it back parsed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { DATA_DIR } from './config.js';
import { extractJson } from './ai-json.js';

export const PRESETS = {
  anthropic: { label: 'Claude (Anthropic)', kind: 'anthropic', model: 'claude-opus-5-5', keyUrl: 'https://console.anthropic.com/settings/keys' },
  openai: { label: 'ChatGPT (OpenAI)', kind: 'openai', baseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys' },
  gemini: { label: 'Gemini (Google)', kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyUrl: 'https://aistudio.google.com/apikey' },
  mistral: { label: 'Mistral', kind: 'openai', baseUrl: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys' },
  groq: { label: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys' },
  openrouter: { label: 'OpenRouter (accès à presque tous les modèles)', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys' },
  deepseek: { label: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', keyUrl: 'https://platform.deepseek.com/api_keys' },
  ollama: { label: 'Ollama (sur ce PC, gratuit)', kind: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', local: true, model: 'gemma3:4b' },
  lmstudio: { label: 'LM Studio (sur ce PC, gratuit)', kind: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', local: true },
  custom: { label: 'Autre service compatible OpenAI', kind: 'openai', baseUrl: '' },
};

// Overridable so tests can point the Claude client at a fake server.
const ANTHROPIC_BASE = process.env.CLIPFORGE_ANTHROPIC_BASE_URL || undefined;

// Claude models that accept the server-side refusal fallback and the effort setting.
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const EFFORT_MODEL = /^claude-(fable|mythos|opus|sonnet|haiku)-(5|4-[6-9])/;

const STORE = path.join(DATA_DIR, 'ai.json');
let store = { providers: {}, active: null };
try {
  store = { ...store, ...JSON.parse(fs.readFileSync(STORE, 'utf8')) };
} catch {
  // not configured yet
}
const save = () => fs.writeFileSync(STORE, JSON.stringify(store, null, 2), { mode: 0o600 });

const mask = (key) => (key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '');

/** Settings as shown to the UI: keys masked. */
export function settings() {
  return {
    presets: PRESETS,
    active: store.active,
    providers: Object.entries(store.providers).map(([id, p]) => ({
      id, preset: p.preset, label: p.label, baseUrl: p.baseUrl, model: p.model, vision: p.vision !== false,
      hasKey: !!p.apiKey, keyHint: mask(p.apiKey),
    })),
  };
}

export function saveProvider(id, input) {
  const preset = PRESETS[input.preset];
  if (!preset) throw new Error('Fournisseur inconnu');
  const prev = store.providers[id] || {};
  const p = {
    preset: input.preset,
    kind: preset.kind,
    label: String(input.label || preset.label).slice(0, 60),
    baseUrl: String(input.baseUrl ?? prev.baseUrl ?? preset.baseUrl ?? '').trim().replace(/\/+$/, ''),
    // an empty key field keeps the saved key
    apiKey: String(input.apiKey || '').trim() || prev.apiKey || '',
    model: String(input.model || prev.model || preset.model || '').trim(),
    vision: input.vision !== undefined ? !!input.vision : prev.vision !== false,
  };
  if (p.kind === 'openai' && !p.baseUrl) throw new Error('Adresse de l’API requise');
  if (!p.apiKey && !preset.local && p.preset !== 'custom') throw new Error('Clé d’API requise');
  store.providers[id] = p;
  if (!store.active) store.active = id;
  save();
  return settings();
}

export function deleteProvider(id) {
  delete store.providers[id];
  if (store.active === id) store.active = Object.keys(store.providers)[0] || null;
  save();
  return settings();
}

export function setActive(id) {
  if (!store.providers[id]) throw new Error('Fournisseur inconnu');
  store.active = id;
  save();
  return settings();
}

export const isConfigured = () => !!(store.active && store.providers[store.active]);

function provider(id = store.active) {
  const p = store.providers[id];
  if (!p) throw new Error('Aucune IA configurée : ajoute-en une dans Réglages → IA');
  if (!p.model) throw new Error(`Choisis un modèle pour ${p.label}`);
  return p;
}

const anthropicClient = (p) => new Anthropic({ apiKey: p.apiKey, baseURL: p.baseUrl || ANTHROPIC_BASE });

export async function listModels(id) {
  const p = store.providers[id];
  if (!p) throw new Error('Fournisseur inconnu');
  if (p.kind === 'anthropic') {
    const ids = [];
    for await (const m of anthropicClient(p).models.list()) ids.push(m.id);
    return ids;
  }
  const res = await fetch(`${p.baseUrl}/models`, { headers: authHeaders(p), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${p.label} : ${await errorText(res)}`);
  const body = await res.json();
  return (body.data || body.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
}

const authHeaders = (p) => (p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {});

async function errorText(res) {
  const text = await res.text();
  try {
    const j = JSON.parse(text);
    return j.error?.message || j.error || j.message || `${res.status}`;
  } catch {
    return `${res.status} ${text.slice(0, 200)}`;
  }
}

/**
 * Asks the active provider for a JSON object matching `schema`.
 * `images` are base64 JPEGs; they're dropped automatically for models without vision.
 */
export async function askJson({ system, prompt, schema, images = [], effort = 'medium', providerId }) {
  const p = provider(providerId);
  const imgs = p.vision === false ? [] : images;
  return p.kind === 'anthropic'
    ? askClaude(p, { system, prompt, schema, images: imgs, effort })
    : askOpenAiCompatible(p, { system, prompt, schema, images: imgs });
}

async function askClaude(p, { system, prompt, schema, images, effort }) {
  const params = {
    model: p.model,
    max_tokens: 16000,
    system,
    messages: [{
      role: 'user',
      content: [
        ...images.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })),
        { type: 'text', text: prompt },
      ],
    }],
    output_config: { format: { type: 'json_schema', schema } },
  };
  if (EFFORT_MODEL.test(p.model)) params.output_config.effort = effort;
  if (FALLBACK_MODELS.has(p.model)) {
    // a declined request is re-run server-side on Anthropic's recommended model
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  let msg;
  try {
    msg = await anthropicClient(p).beta.messages.create(params);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error('Clé Claude refusée : vérifie-la dans Réglages → IA');
    if (err instanceof Anthropic.RateLimitError) throw new Error('Limite de Claude atteinte, réessaie dans un moment');
    if (err instanceof Anthropic.APIError) throw new Error(`Claude : ${err.message}`);
    throw err;
  }
  if (msg.stop_reason === 'refusal') throw new Error('Claude a refusé cette demande');
  if (msg.stop_reason === 'max_tokens') throw new Error('Réponse de Claude tronquée');
  return extractJson(msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
}

async function askOpenAiCompatible(p, { system, prompt, schema, images }) {
  const userContent = images.length
    ? [{ type: 'text', text: prompt }, ...images.map((b64) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }))]
    : prompt;
  const base = {
    model: p.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: userContent }],
  };
  const withSchema = `${system}\n\nRéponds uniquement avec un objet JSON conforme à ce schéma :\n${JSON.stringify(schema)}`;
  // Strict JSON schema first; providers that don't support it get JSON mode, then plain text.
  const attempts = [
    { ...base, response_format: { type: 'json_schema', json_schema: { name: 'resultat', schema, strict: true } } },
    { ...base, messages: [{ role: 'system', content: withSchema }, base.messages[1]], response_format: { type: 'json_object' } },
    { ...base, messages: [{ role: 'system', content: withSchema }, base.messages[1]] },
  ];
  let lastError;
  for (const body of attempts) {
    const res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(p) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(p.preset === 'ollama' || p.preset === 'lmstudio' ? 600_000 : 120_000),
    });
    if (res.ok) {
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content;
      if (!text) throw new Error(`${p.label} : réponse vide`);
      return extractJson(text);
    }
    lastError = `${p.label} : ${await errorText(res)}`;
    if (res.status === 401 || res.status === 403) throw new Error(`${p.label} : clé refusée`);
    if (res.status === 429) throw new Error(`${p.label} : limite atteinte, réessaie plus tard`);
    if (res.status !== 400 && res.status !== 422) break;
  }
  throw new Error(lastError);
}

// ---- Ollama model management ------------------------------------------------------------

const ollamaRoot = (p) => p.baseUrl.replace(/\/v1$/, '');

export async function ollamaStatus(id) {
  const p = store.providers[id];
  if (!p || p.preset !== 'ollama') throw new Error('Pas un fournisseur Ollama');
  try {
    const res = await fetch(`${ollamaRoot(p)}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const { models } = await res.json();
    return { running: true, models: models.map((m) => ({ name: m.name, size: m.size })) };
  } catch {
    return { running: false, models: [] };
  }
}

/** Downloads a model into Ollama, reporting progress (0..1). */
export async function ollamaPull(id, model, onProgress) {
  const p = store.providers[id];
  const res = await fetch(`${ollamaRoot(p)}/api/pull`, {
    method: 'POST', body: JSON.stringify({ model, stream: true }),
  });
  if (!res.ok) throw new Error(`Ollama : ${await errorText(res)}`);
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines.filter(Boolean)) {
      const ev = JSON.parse(line);
      if (ev.error) throw new Error(`Ollama : ${ev.error}`);
      if (ev.total) onProgress?.(ev.completed / ev.total, ev.status);
    }
  }
}

/**
 * Starts the user-space Ollama install (~/.local/ollama) when a local provider is configured
 * and nothing answers yet. The integrated GPU is enabled through Vulkan.
 */
export async function ensureOllama() {
  const p = Object.values(store.providers).find((x) => x.preset === 'ollama');
  const bin = process.env.CLIPFORGE_OLLAMA_BIN || path.join(os.homedir(), '.local', 'ollama', 'bin', 'ollama');
  if (!p || !fs.existsSync(bin)) return false;
  const root = ollamaRoot(p);
  const up = () => fetch(`${root}/api/version`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
  if (await up()) return true;
  const child = spawn(bin, ['serve'], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      OLLAMA_HOST: new URL(root).host,
      OLLAMA_MODELS: process.env.OLLAMA_MODELS || path.join(path.dirname(path.dirname(bin)), 'models'),
      OLLAMA_VULKAN: '1',
      OLLAMA_IGPU_ENABLE: '1',
    },
  });
  child.unref(); // keeps running across ClipForge restarts, like a normal Ollama service
  for (let i = 0; i < 20; i++) {
    if (await up()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
