import { $, api, esc, fmtDateTime, fmtSize, toast, waitJob } from './util.js';

const ICONS = { onedrive: '☁', drive: '△', dropbox: '◇', iclouddrive: '', mega: 'M', smb: '🖧', local: '📁' };
let info = { providers: {}, sources: [] };
let pollTimer = null;

export async function renderCloud(main, isCurrent = () => true) {
  info = await api('/api/cloud');
  if (!isCurrent()) return;
  main.innerHTML = `
    <div class="page-head"><h1>Sources cloud</h1><span class="spacer"></span>
      <button class="btn primary" id="cloud-new">＋ Ajouter une source</button></div>
    <p class="muted page-intro">Choisis les vidéos à importer depuis tes comptes et ton NAS, ou active l’import automatique
      d’un dossier. Les vidéos sont copiées sur ce PC ; retirer une source supprime ces copies, jamais les originaux chez le service.</p>
    ${info.sources.length ? `<div class="sources">${info.sources.map(sourceCard).join('')}</div>`
      : '<div class="empty"><h2>Aucune source</h2>OneDrive, Google Drive, Dropbox, iCloud, Mega, NAS… clique sur « Ajouter une source ».</div>'}`;
  clearTimeout(pollTimer);
  if (info.sources.some((s) => s.syncing)) {
    pollTimer = setTimeout(() => isCurrent() && renderCloud(main, isCurrent), 1500);
  }
}

function sourceCard(s) {
  const p = info.providers[s.type];
  let status;
  if (s.syncing) {
    status = `<span class="muted">${esc(s.syncing.message)}</span>
      <div class="progress"><div style="width:${Math.round(s.syncing.progress * 100)}%"></div></div>`;
  } else if (s.status === 'setup') status = '<span class="status-warn">Connexion inachevée</span>';
  else if (s.status === 'error' || s.last_error) status = `<span class="status-failed">⚠ ${esc(s.last_error || 'Erreur')}</span>`;
  else if (s.last_sync) status = `<span class="muted">Dernier import ${fmtDateTime(`${s.last_sync}Z`)} · ${s.last_count ?? 0} nouvelle(s) vidéo(s)</span>`;
  else status = '<span class="muted">Rien d’importé pour l’instant</span>';
  const auto = s.interval_min > 0;
  const folder = s.type === 'local' ? s.folder : s.folder ? `/${s.folder}` : 'Tout le compte';
  return `
    <article class="source" data-source="${s.id}">
      <div class="source-icon">${ICONS[s.type] || '☁'}</div>
      <div class="source-main">
        <b>${esc(s.name)}</b> <span class="muted small">${esc(p?.label || s.type)}</span>
        <div class="small">Dossier suivi : <code>${esc(folder)}</code> · <b>${s.local.count}</b> vidéo(s) importée(s) (${fmtSize(s.local.bytes)})</div>
        <div class="small">${status}</div>
        <div class="source-opts small">
          <label class="check"><input type="checkbox" data-auto ${auto ? 'checked' : ''}> Importer automatiquement les nouvelles vidéos du dossier suivi</label>
          ${auto ? `<label>toutes les <input type="number" min="1" max="1440" data-opt="interval_min" value="${s.interval_min}"> min</label>
          <label>si elles ont moins de <input type="number" min="0" max="3650" data-opt="max_age_days" value="${s.max_age_days}"> jours (0 = toutes)</label>` : ''}
        </div>
      </div>
      <div class="actions">
        ${s.status === 'ready' ? `<button class="btn primary" data-browse ${s.syncing ? 'disabled' : ''}>Choisir des vidéos…</button>` : ''}
        ${s.status === 'ready' ? `<button class="btn" data-sync ${s.syncing ? 'disabled' : ''} title="Importe toutes les vidéos du dossier suivi">Tout importer</button>` : ''}
        <button class="btn danger" data-del-source title="Retirer la source et supprimer ses vidéos importées">🗑</button>
      </div>
    </article>`;
}

document.addEventListener('click', async (e) => {
  if (e.target.closest('#cloud-new')) return openAdd();
  const card = e.target.closest('[data-source]');
  if (!card) return;
  const id = Number(card.dataset.source);
  if (e.target.closest('[data-sync]')) {
    await api(`/api/cloud/sources/${id}/sync`, { method: 'POST' });
    toast('Synchronisation lancée');
    setTimeout(() => renderCloud($('#main')), 400);
  } else if (e.target.closest('[data-browse]')) {
    openBrowser(id);
  } else if (e.target.closest('[data-del-source]')) {
    const s = info.sources.find((x) => x.id === id);
    const what = s.local.count
      ? `\n\nSes ${s.local.count} vidéo(s) importée(s) (${fmtSize(s.local.bytes)}) seront supprimées de ce PC et de ta bibliothèque.`
      : '';
    if (!confirm(`Retirer « ${s.name} » ?${what}\n\nRien n’est supprimé sur le service cloud lui-même.`)) return;
    try {
      const r = await api(`/api/cloud/sources/${id}?videos=1`, { method: 'DELETE' });
      toast(r.deleted ? `Source retirée, ${r.deleted} vidéo(s) supprimée(s)` : 'Source retirée');
    } catch (err) {
      toast(err.message, true);
    }
    renderCloud($('#main'));
  }
});

document.addEventListener('change', async (e) => {
  const card = e.target.closest('[data-source]');
  if (card && e.target.matches('[data-auto]')) {
    await api(`/api/cloud/sources/${card.dataset.source}`, {
      method: 'PUT', body: JSON.stringify({ interval_min: e.target.checked ? 15 : 0 }),
    });
    toast(e.target.checked ? 'Import automatique activé (toutes les 15 min)' : 'Import automatique désactivé');
    return renderCloud($('#main'));
  }
  const opt = e.target.closest('[data-opt]');
  if (!opt || !card) return;
  await api(`/api/cloud/sources/${card.dataset.source}`, {
    method: 'PUT', body: JSON.stringify({ [opt.dataset.opt]: Number(opt.value) }),
  });
  toast('Réglage enregistré');
});

// ---------------------------------------------------------------- add-source wizard

function openAdd() {
  const body = $('#ca-body');
  body.innerHTML = `
    <div class="provider-grid">
      ${Object.entries(info.providers).map(([key, p]) => `
        <button class="provider" data-provider="${key}"><span>${ICONS[key] || '☁'}</span>${esc(p.label)}</button>`).join('')}
    </div>`;
  $('#cloud-add').showModal();
}

$('[data-close-cloud-add]').addEventListener('click', () => {
  $('#cloud-add').close();
  renderCloud($('#main'));
});

$('#ca-body').addEventListener('click', async (e) => {
  const prov = e.target.closest('[data-provider]');
  if (prov) return showForm(prov.dataset.provider);
});

function showForm(type) {
  const p = info.providers[type];
  const notes = {
    drive: info.googleClient
      ? 'Tes identifiants Google de YouTube seront réutilisés (active « Google Drive API » dans le même projet Google Cloud).'
      : 'rclone arrête son accès Google partagé courant 2026 : le plus fiable est de créer tes identifiants (même procédure que YouTube, dans Exports → Publier) puis d’activer « Google Drive API ». Sans eux, ça marche encore un temps.',
    iclouddrive: 'Apple t’enverra un code de validation sur ton iPhone. La protection avancée des données doit être désactivée pour que l’accès web fonctionne.',
    onedrive: 'Astuce Xbox : dans les réglages de la console, active l’envoi automatique des captures vers OneDrive, ClipForge les récupérera.',
    smb: 'Pour un dossier partagé Windows ou un NAS (Synology, QNAP…). Tu choisiras le partage et le dossier juste après.',
    local: 'Pour un NAS déjà monté (ex. /mnt/nas), un disque externe ou n’importe quel dossier de ce PC.',
  }[type];
  $('#ca-body').innerHTML = `
    <form id="ca-form" class="ca-form">
      <h3>${esc(p.label)}</h3>
      ${notes ? `<p class="note">${esc(notes)}</p>` : ''}
      <label class="field"><span>Nom dans ClipForge</span><input name="name" type="text" value="${esc(p.label.split(' (')[0])}"></label>
      ${p.fields.map((f) => (f.choices
        ? `<label class="field"><span>${esc(f.label)}</span><select class="select" name="${f.key}">
            ${f.choices.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select></label>`
        : `<label class="field"><span>${esc(f.label)}</span>
            <input name="${f.key}" type="${f.password ? 'password' : 'text'}" ${f.optional ? '' : 'required'} autocomplete="off"></label>`)).join('')}
      ${p.oauth ? '<p class="muted small">Une page de connexion va s’ouvrir dans ton navigateur.</p>' : ''}
      <div class="dialog-actions">
        <button type="button" class="btn ghost" data-back>← Autre service</button>
        <button class="btn primary">${p.oauth ? 'Se connecter' : 'Ajouter'}</button>
      </div>
    </form>`;
  $('#ca-form [data-back]').onclick = openAdd;
  $('#ca-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const form = new FormData(ev.target);
    const params = Object.fromEntries(p.fields.map((f) => [f.key, form.get(f.key)]));
    try {
      const src = await api('/api/cloud/sources', {
        method: 'POST', body: JSON.stringify({ type, name: form.get('name'), params }),
      });
      followSetup(src.id);
    } catch (err) {
      toast(err.message, true);
    }
  };
}

/** Polls the server-side rclone set-up and shows whatever it needs: a link, a question, done. */
async function followSetup(id) {
  const body = $('#ca-body');
  let lastKey = '';
  for (;;) {
    if (!$('#cloud-add').open) return;
    const s = await api(`/api/cloud/sources/${id}/setup`);
    const key = JSON.stringify(s);
    if (key !== lastKey) {
      lastKey = key;
      if (s.phase === 'working') {
        body.innerHTML = '<div class="setup-wait"><span class="spinner"></span> Connexion en cours…</div>';
      } else if (s.phase === 'oauth') {
        body.innerHTML = `<div class="setup-wait">
          <p><span class="spinner"></span> Connecte-toi dans l’onglet qui vient de s’ouvrir, puis reviens ici.</p>
          <a class="btn primary" href="${esc(s.url)}" target="_blank" rel="noopener">Ouvrir la page de connexion</a></div>`;
      } else if (s.phase === 'question') {
        renderQuestion(id, s.question);
      } else if (s.phase === 'done') {
        toast('Source connectée ✔');
        $('#cloud-add').close();
        const src = (await api('/api/cloud')).sources.find((x) => x.id === id);
        if (src) openBrowser(id);
        renderCloud($('#main'));
        return;
      } else if (s.phase === 'error') {
        body.innerHTML = `<p class="status-failed">⚠ ${esc(s.error)}</p>
          <div class="dialog-actions"><button class="btn" data-retry>Réessayer</button></div>`;
        body.querySelector('[data-retry]').onclick = openAdd;
        return;
      }
    }
    if (s.phase === 'question') return; // waits for the user's answer
    await new Promise((r) => setTimeout(r, 700));
  }
}

function renderQuestion(id, q) {
  const field = q.examples.length && q.exclusive
    ? `<div class="choices">${q.examples.map((ex) => `
        <label class="choice"><input type="radio" name="answer" value="${esc(ex.value)}" ${ex.value === q.default ? 'checked' : ''}>
          <span>${esc(ex.label || ex.value)}</span></label>`).join('')}</div>`
    : `<input name="answer" type="${q.password ? 'password' : 'text'}" value="${esc(q.default)}" autocomplete="one-time-code" required>`;
  $('#ca-body').innerHTML = `
    <form id="ca-q" class="ca-form">
      <p class="question">${esc(q.help).replace(/\n/g, '<br>')}</p>
      ${q.error ? `<p class="status-failed">⚠ ${esc(q.error)}</p>` : ''}
      ${field}
      <div class="dialog-actions"><button class="btn primary">Continuer</button></div>
    </form>`;
  $('#ca-q').onsubmit = async (ev) => {
    ev.preventDefault();
    const value = new FormData(ev.target).get('answer') ?? '';
    await api(`/api/cloud/sources/${id}/answer`, { method: 'POST', body: JSON.stringify({ state: q.state, value }) });
    followSetup(id);
  };
}

// ---------------------------------------------------------------- video picker

const browser = { id: null, path: '', videos: [] };

async function openBrowser(id, sub = '') {
  browser.id = id;
  browser.path = sub;
  if (!$('#cloud-browse').open) $('#cloud-browse').showModal();
  $('#cb-list').innerHTML = '<div class="setup-wait"><span class="spinner"></span> Lecture…</div>';
  $('#cb-import').disabled = true;
  const parts = sub ? sub.split('/') : [];
  $('#cb-path').innerHTML = [`<button data-crumb="">Racine</button>`,
    ...parts.map((p, i) => `<button data-crumb="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</button>`)].join(' / ');
  try {
    const tree = await api(`/api/cloud/sources/${id}/browse?path=${encodeURIComponent(sub)}`);
    browser.videos = tree.videos;
    const fresh = tree.videos.filter((v) => !v.imported).length;
    $('#cb-list').innerHTML = `
      ${tree.folders.map((f) => `<button class="folder" data-folder="${esc(f.path)}">📁 ${esc(f.name)}</button>`).join('')}
      ${tree.videos.length ? `
        <label class="check pick-all"><input type="checkbox" data-pick-all ${fresh ? '' : 'disabled'}> Tout cocher (${fresh} non importée(s))</label>
        ${tree.videos.map((v, i) => `
          <label class="video-row ${v.imported ? 'imported' : ''}">
            <input type="checkbox" data-pick-video="${i}" ${v.imported ? 'disabled' : ''}>
            <span class="vname">🎞 ${esc(v.name)}</span>
            <span class="muted small">${fmtSize(v.size)} · ${fmtDateTime(v.modTime)}</span>
            ${v.imported ? '<span class="ok small">✓ déjà importée</span>' : ''}
          </label>`).join('')}` : ''}
      ${!tree.folders.length && !tree.videos.length ? '<p class="muted">Dossier vide.</p>' : ''}`;
    updatePickCount();
  } catch (err) {
    $('#cb-list').innerHTML = `<p class="status-failed">⚠ ${esc(err.message)}</p>`;
  }
}

function picked() {
  return [...document.querySelectorAll('[data-pick-video]:checked')].map((el) => browser.videos[Number(el.dataset.pickVideo)]);
}

function updatePickCount() {
  const sel = picked();
  const bytes = sel.reduce((t, v) => t + v.size, 0);
  $('#cb-count').textContent = sel.length ? `${sel.length} vidéo(s) cochée(s) · ${fmtSize(bytes)}` : 'Coche les vidéos à importer';
  $('#cb-import').disabled = !sel.length;
  $('#cb-import').textContent = sel.length ? `Importer ${sel.length} vidéo(s)` : 'Importer la sélection';
}

$('#cb-list').addEventListener('change', (e) => {
  if (e.target.matches('[data-pick-all]')) {
    document.querySelectorAll('[data-pick-video]:not(:disabled)').forEach((el) => { el.checked = e.target.checked; });
  }
  updatePickCount();
});
$('#cb-path').addEventListener('click', (e) => {
  const c = e.target.closest('[data-crumb]');
  if (c) openBrowser(browser.id, c.dataset.crumb);
});
$('#cb-list').addEventListener('click', (e) => {
  const f = e.target.closest('[data-folder]');
  if (f) openBrowser(browser.id, f.dataset.folder);
});

$('#cb-import').addEventListener('click', async () => {
  const sel = picked();
  const btn = $('#cb-import');
  btn.disabled = true;
  try {
    const job = await api(`/api/cloud/sources/${browser.id}/import`, {
      method: 'POST', body: JSON.stringify({ paths: sel.map((v) => v.path) }),
    });
    const r = await waitJob(job, () => { btn.textContent = 'Import en cours…'; });
    toast(`${r.imported} vidéo(s) importée(s)${r.errors.length ? `, ${r.errors.length} en échec` : ''}`, !!r.errors.length);
    openBrowser(browser.id, browser.path);
    renderCloud($('#main'));
  } catch (err) {
    toast(err.message, true);
    updatePickCount();
  }
});

$('#cb-choose').addEventListener('click', async () => {
  const src = info.sources.find((x) => x.id === browser.id);
  if (src?.type === 'local') return toast('Pour un dossier de ce PC, le dossier suivi est celui choisi à l’ajout', true);
  await api(`/api/cloud/sources/${browser.id}`, { method: 'PUT', body: JSON.stringify({ folder: browser.path }) });
  toast(`Dossier suivi : /${browser.path || ''}`);
  renderCloud($('#main'));
});
$('[data-close-cloud-browse]').addEventListener('click', () => $('#cloud-browse').close());
