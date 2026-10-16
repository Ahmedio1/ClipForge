import { $, api, esc, toast, waitJob } from './util.js';

const SUGGESTED_LOCAL = [
  ['gemma3:4b', 'Gemma 3 4B : voit les images, bon équilibre (3,3 Go)'],
  ['qwen3:4b', 'Qwen 3 4B : texte seulement, bon en français (2,5 Go)'],
  ['gemma3:12b', 'Gemma 3 12B : meilleur mais lent sur ce PC (8 Go)'],
];

export let aiState = { active: null, providers: [], presets: {} };

const MCP_URL = `${location.origin.replace('127.0.0.1', 'localhost')}/mcp`;
const GEMINI_CONF = JSON.stringify({ mcpServers: { clipforge: { httpUrl: MCP_URL } } });
const desktopConf = () => JSON.stringify({
  mcpServers: { clipforge: { command: 'node', args: [aiState.mcpBin || 'bin/clipforge-mcp.js'] } },
});

export async function loadAi() {
  aiState = await api('/api/ai');
  document.body.classList.toggle('ai-ready', !!aiState.active);
  return aiState;
}

export async function renderAi(main, isCurrent = () => true) {
  await loadAi();
  if (!isCurrent()) return;
  const { presets, providers, active } = aiState;
  main.innerHTML = `
    <div class="page-head"><h1>IA</h1></div>
    <p class="muted page-intro">L’IA écrit tes titres, descriptions et hashtags, propose des accroches, choisit les meilleurs moments
      en regardant les images, et modifie un montage quand tu lui demandes. Choisis un service en ligne (meilleure qualité, payant à l’usage
      avec ta clé) ou l’IA locale (gratuite, privée, plus lente).</p>
    <div class="sources">${providers.map((p) => providerCard(p, p.id === active, presets[p.preset])).join('')
      || '<div class="empty"><h2>Aucune IA configurée</h2>Ajoute-en une ci-dessous.</div>'}</div>
    <h2 class="section-title">Avec ton abonnement (Claude, Gemini…) : sans clé d’API</h2>
    <div class="sub-ai">
      <p class="small">Les abonnements ne donnent pas de clé d’API… alors c’est l’inverse : <b>ton appli d’IA pilote ClipForge</b>.
        Tu lui parles normalement (« fais-moi un short de 30 s avec mes meilleurs combos ») et elle regarde tes clips,
        fait le montage, lance le rendu et vérifie le résultat. ClipForge doit être ouvert.</p>
      <div class="sub-grid">
        <div class="sub-card">
          <b>Claude Code</b> <span class="muted small">(abonnement Claude Pro / Max)</span>
          <p class="small">Dans un terminal :</p>
          <div class="copy-row"><code>${esc(`claude mcp add --transport http clipforge ${MCP_URL}`)}</code>
            <button class="btn small" data-copy="${esc(`claude mcp add --transport http clipforge ${MCP_URL}`)}">Copier</button></div>
          <p class="small muted">Puis lance <code>claude</code> et demande ton montage.</p>
        </div>
        <div class="sub-card">
          <b>Gemini CLI</b> <span class="muted small">(compte Google, gratuit)</span>
          <p class="small">Ajoute dans <code>~/.gemini/settings.json</code> :</p>
          <div class="copy-row"><code>${esc(GEMINI_CONF)}</code>
            <button class="btn small" data-copy="${esc(GEMINI_CONF)}">Copier</button></div>
        </div>
        <div class="sub-card">
          <b>Claude Desktop</b> <span class="muted small">(Windows / Mac)</span>
          <p class="small">Réglages → Développeur → Modifier la config, ajoute :</p>
          <div class="copy-row"><code>${esc(desktopConf())}</code>
            <button class="btn small" data-copy="${esc(desktopConf())}">Copier</button></div>
        </div>
        <div class="sub-card">
          <b>ChatGPT, claude.ai (web)</b>
          <p class="small muted">Leurs connecteurs exigent une adresse publique en HTTPS : ClipForge restant sur ton PC,
            utilise plutôt l’une des applis ci-contre.</p>
        </div>
      </div>
    </div>

    <h2 class="section-title">Ajouter une IA (clé d’API)</h2>
    <form id="ai-add" class="ai-add">
      <label class="field"><span>Service</span>
        <select name="preset" class="select">${Object.entries(presets).map(([k, p]) =>
          `<option value="${k}">${esc(p.label)}</option>`).join('')}</select></label>
      <label class="field" data-for="key"><span>Clé d’API <a id="ai-key-link" target="_blank" rel="noopener">obtenir une clé ↗</a></span>
        <input name="apiKey" type="password" autocomplete="off"></label>
      <label class="field" data-for="url"><span>Adresse de l’API</span><input name="baseUrl" type="text" placeholder="https://…/v1"></label>
      <label class="field"><span>Modèle (tu pourras le changer après)</span><input name="model" type="text"></label>
      <div class="dialog-actions"><button class="btn primary">Ajouter</button></div>
    </form>`;
  syncAddForm();
  for (const p of providers) if (p.preset === 'ollama') renderOllama(p.id);
}

function providerCard(p, isActive, preset) {
  return `
    <article class="source ${isActive ? 'active' : ''}" data-ai="${esc(p.id)}">
      <div class="source-icon">${preset?.local ? '🖥' : '✨'}</div>
      <div class="source-main">
        <label class="check"><input type="radio" name="ai-active" ${isActive ? 'checked' : ''}> <b>${esc(p.label)}</b></label>
        <div class="small muted">${p.hasKey ? `Clé ${esc(p.keyHint)}` : preset?.local ? 'Sur ce PC' : 'Sans clé'} · ${esc(p.baseUrl || 'api.anthropic.com')}</div>
        <div class="model-row">
          <input class="model-input" type="text" value="${esc(p.model)}" list="models-${esc(p.id)}" placeholder="modèle">
          <datalist id="models-${esc(p.id)}"></datalist>
          <button class="btn small" data-load-models>Liste des modèles</button>
          <label class="check small"><input type="checkbox" data-vision ${p.vision ? 'checked' : ''}> voit les images</label>
        </div>
        <div class="small" data-test-result></div>
        ${p.preset === 'ollama' ? '<div class="ollama" data-ollama></div>' : ''}
      </div>
      <div class="actions">
        <button class="btn" data-test-ai>Tester</button>
        <button class="btn danger" data-del-ai title="Supprimer">🗑</button>
      </div>
    </article>`;
}

function syncAddForm() {
  const form = $('#ai-add');
  if (!form) return;
  const preset = aiState.presets[form.preset.value];
  form.querySelector('[data-for="key"]').hidden = !!preset.local;
  form.querySelector('[data-for="url"]').hidden = form.preset.value !== 'custom';
  form.model.value = preset.model || '';
  const link = $('#ai-key-link');
  link.hidden = !preset.keyUrl;
  if (preset.keyUrl) link.href = preset.keyUrl;
}

document.addEventListener('change', async (e) => {
  if (e.target.closest('#ai-add') && e.target.name === 'preset') return syncAddForm();
  const card = e.target.closest('[data-ai]');
  if (!card) return;
  const id = card.dataset.ai;
  const p = aiState.providers.find((x) => x.id === id);
  if (e.target.name === 'ai-active') {
    await api('/api/ai/active', { method: 'PUT', body: JSON.stringify({ id }) });
    toast(`${p.label} est maintenant l’IA utilisée`);
    renderAi($('#main'));
  } else if (e.target.matches('.model-input, [data-vision]')) {
    await api(`/api/ai/providers/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ preset: p.preset, label: p.label, model: card.querySelector('.model-input').value, vision: card.querySelector('[data-vision]').checked }),
    });
    await loadAi();
    toast('Enregistré');
  }
});

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'ai-add') return;
  e.preventDefault();
  const f = new FormData(e.target);
  const preset = f.get('preset');
  const id = `${preset}-${Date.now().toString(36)}`;
  try {
    await api(`/api/ai/providers/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ preset, apiKey: f.get('apiKey'), baseUrl: f.get('baseUrl') || undefined, model: f.get('model') }),
    });
    toast('IA ajoutée');
    renderAi($('#main'));
  } catch (err) {
    toast(err.message, true);
  }
});

document.addEventListener('click', async (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    await navigator.clipboard.writeText(copy.dataset.copy).catch(() => {});
    toast('Copié');
    return;
  }
  const card = e.target.closest('[data-ai]');
  if (!card) return;
  const id = card.dataset.ai;
  if (e.target.closest('[data-load-models]')) {
    try {
      const models = await api(`/api/ai/providers/${id}/models`);
      card.querySelector('datalist').innerHTML = models.map((m) => `<option value="${esc(m)}">`).join('');
      toast(`${models.length} modèle(s) disponibles : clique dans le champ pour choisir`);
      card.querySelector('.model-input').focus();
    } catch (err) {
      toast(err.message, true);
    }
  } else if (e.target.closest('[data-test-ai]')) {
    const out = card.querySelector('[data-test-result]');
    out.innerHTML = '<span class="spinner"></span> Test…';
    try {
      const r = await waitJob(await api(`/api/ai/providers/${id}/test`, { method: 'POST' }));
      out.innerHTML = `<span class="ok">✔ ${esc(r.message)}</span>`;
    } catch (err) {
      out.innerHTML = `<span class="status-failed">⚠ ${esc(err.message)}</span>`;
    }
  } else if (e.target.closest('[data-del-ai]')) {
    if (!confirm('Supprimer cette IA (et sa clé) ?')) return;
    await api(`/api/ai/providers/${id}`, { method: 'DELETE' });
    renderAi($('#main'));
  } else if (e.target.closest('[data-pull]')) {
    const model = card.querySelector('[data-pull-name]').value.trim();
    const status = card.querySelector('[data-pull-status]');
    try {
      await waitJob(await api(`/api/ai/providers/${id}/ollama/pull`, { method: 'POST', body: JSON.stringify({ model }) }),
        (j) => { status.textContent = j.message || 'Téléchargement…'; });
      toast(`${model} installé`);
      renderOllama(id);
    } catch (err) {
      status.textContent = '';
      toast(err.message, true);
    }
  }
});

async function renderOllama(id) {
  const box = document.querySelector(`[data-ai="${CSS.escape(id)}"] [data-ollama]`);
  if (!box) return;
  const s = await api(`/api/ai/providers/${id}/ollama`).catch(() => ({ running: false, models: [] }));
  box.innerHTML = s.running
    ? `<div class="small">Ollama tourne · modèles installés : ${s.models.map((m) => `<code>${esc(m.name)}</code>`).join(' ') || 'aucun'}</div>
       <div class="model-row">
         <input data-pull-name type="text" list="ollama-suggest" value="${s.models.length ? '' : 'gemma3:4b'}" placeholder="ex. gemma3:4b">
         <datalist id="ollama-suggest">${SUGGESTED_LOCAL.map(([m, l]) => `<option value="${m}">${esc(l)}</option>`).join('')}</datalist>
         <button class="btn small" data-pull>Télécharger un modèle</button>
         <span class="small muted" data-pull-status></span>
       </div>`
    : `<div class="small status-warn">Ollama ne répond pas. Installe-le depuis <a href="https://ollama.com/download" target="_blank" rel="noopener">ollama.com</a>
       (ClipForge le démarre tout seul s’il est dans ~/.local/ollama).</div>`;
}
