import { $, api, esc, fmtDateTime, toast } from './util.js';

const ICONS = { onedrive: '☁', drive: '△', dropbox: '◇', iclouddrive: '', mega: 'M', smb: '🖧', local: '📁' };
let info = { providers: {}, sources: [] };
let pollTimer = null;

export async function renderCloud(main, isCurrent = () => true) {
  info = await api('/api/cloud');
  if (!isCurrent()) return;
  main.innerHTML = `
    <div class="page-head"><h1>Sources cloud</h1><span class="spacer"></span>
      <button class="btn primary" id="cloud-new">＋ Ajouter une source</button></div>
    <p class="muted page-intro">ClipForge récupère automatiquement les nouvelles vidéos de tes comptes et de ton NAS,
      et les range dans ta bibliothèque. Les fichiers sont copiés, jamais supprimés ni modifiés chez le service.</p>
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
  else if (s.last_sync) status = `<span class="muted">Dernière synchro ${fmtDateTime(`${s.last_sync}Z`)} · ${s.last_count ?? 0} nouvelle(s) vidéo(s)</span>`;
  else status = '<span class="muted">Pas encore synchronisée</span>';
  const folder = s.type === 'local' ? s.folder : s.folder ? `/${s.folder}` : 'Tout le compte';
  return `
    <article class="source" data-source="${s.id}">
      <div class="source-icon">${ICONS[s.type] || '☁'}</div>
      <div class="source-main">
        <b>${esc(s.name)}</b> <span class="muted small">${esc(p?.label || s.type)}</span>
        <div class="small">Dossier surveillé : <code>${esc(folder)}</code></div>
        <div class="small">${status}</div>
        <div class="source-opts small">
          <label>Vidéos de moins de <input type="number" min="0" max="3650" data-opt="max_age_days" value="${s.max_age_days}"> jours (0 = toutes)</label>
          <label>Vérifier toutes les <input type="number" min="0" max="1440" data-opt="interval_min" value="${s.interval_min}"> min (0 = manuel)</label>
        </div>
      </div>
      <div class="actions">
        ${s.status === 'ready' ? `<button class="btn primary" data-sync ${s.syncing ? 'disabled' : ''}>Synchroniser</button>` : ''}
        ${s.status === 'ready' && s.type !== 'local' ? '<button class="btn" data-browse>Dossier…</button>' : ''}
        <button class="btn danger" data-del-source title="Retirer la source (les vidéos déjà copiées restent)">🗑</button>
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
    if (!confirm('Retirer cette source ? Les vidéos déjà copiées restent dans ta bibliothèque.')) return;
    await api(`/api/cloud/sources/${id}`, { method: 'DELETE' });
    renderCloud($('#main'));
  }
});

document.addEventListener('change', async (e) => {
  const opt = e.target.closest('[data-opt]');
  const card = e.target.closest('[data-source]');
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
        if (src?.type !== 'local') openBrowser(id);
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

// ---------------------------------------------------------------- folder browser

const browser = { id: null, path: '' };

async function openBrowser(id, sub = '') {
  browser.id = id;
  browser.path = sub;
  if (!$('#cloud-browse').open) $('#cloud-browse').showModal();
  $('#cb-list').innerHTML = '<div class="setup-wait"><span class="spinner"></span> Lecture…</div>';
  const parts = sub ? sub.split('/') : [];
  $('#cb-path').innerHTML = [`<button data-crumb="">Racine</button>`,
    ...parts.map((p, i) => `<button data-crumb="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</button>`)].join(' / ');
  try {
    const tree = await api(`/api/cloud/sources/${id}/browse?path=${encodeURIComponent(sub)}`);
    $('#cb-list').innerHTML = tree.folders.map((f) => `
      <button class="folder" data-folder="${esc(f.path)}">📁 ${esc(f.name)}</button>`).join('')
      || '<p class="muted">Pas de sous-dossier.</p>';
    $('#cb-count').textContent = `${tree.videos} vidéo(s) directement dans ce dossier`;
  } catch (err) {
    $('#cb-list').innerHTML = `<p class="status-failed">⚠ ${esc(err.message)}</p>`;
  }
}

$('#cb-path').addEventListener('click', (e) => {
  const c = e.target.closest('[data-crumb]');
  if (c) openBrowser(browser.id, c.dataset.crumb);
});
$('#cb-list').addEventListener('click', (e) => {
  const f = e.target.closest('[data-folder]');
  if (f) openBrowser(browser.id, f.dataset.folder);
});
$('#cb-choose').addEventListener('click', async () => {
  await api(`/api/cloud/sources/${browser.id}`, { method: 'PUT', body: JSON.stringify({ folder: browser.path }) });
  $('#cloud-browse').close();
  await api(`/api/cloud/sources/${browser.id}/sync`, { method: 'POST' });
  toast('Dossier enregistré, synchronisation lancée');
  setTimeout(() => renderCloud($('#main')), 400);
});
$('[data-close-cloud-browse]').addEventListener('click', () => $('#cloud-browse').close());
