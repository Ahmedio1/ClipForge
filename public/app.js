import { $, $$, api, esc, fitBox, fmtDateTime, fmtDay, fmtSize, fmtTime, toast, uploadFile, waitJob } from './util.js';
import { openProject, renderProjects, addToProjectMenu } from './montage.js';
import { openPublish, renderPublications } from './publish.js';
import { renderCloud } from './cloud.js';
import { aiState, loadAi, renderAi } from './ai.js';

// ---------------------------------------------------------------- state

const state = {
  view: { kind: 'all' }, // all | favorites | game | exports | projects
  q: '',
  sort: 'recent',
  clips: [],
  libraryVersion: -1,
  exportsKey: '',
  selected: new Set(), // clip ids picked for a new montage
};

/** Lets other modules switch the main view. */
export function navigate(kind) {
  state.view = { kind };
  markActiveNav();
  return renderMain();
}

const overlayOpen = () => !$('#editor').hidden || !$('#montage').hidden;

// ---------------------------------------------------------------- sidebar

async function renderGames() {
  const games = await api('/api/games');
  const total = games.reduce((n, g) => n + g.count, 0);
  $('#count-all').textContent = total || '';
  $('#games').innerHTML = games.map((g) => `
    <button class="nav-item" data-nav="game" data-game="${esc(g.game)}">
      <span>🎮</span><span class="game-name">${esc(g.game)}</span><em>${g.count}</em>
    </button>`).join('') || '<div class="muted" style="padding:6px 10px">Aucun jeu pour l’instant</div>';
  markActiveNav();
}

function markActiveNav() {
  $$('.nav-item').forEach((el) => {
    const v = state.view;
    el.classList.toggle('active',
      el.dataset.nav === v.kind && (v.kind !== 'game' || el.dataset.game === v.game));
  });
}

document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-nav]');
  if (!nav) return;
  state.view = nav.dataset.nav === 'game' ? { kind: 'game', game: nav.dataset.game } : { kind: nav.dataset.nav };
  document.body.classList.remove('nav-open');
  markActiveNav();
  renderMain();
});

// ---------------------------------------------------------------- library

async function loadClips() {
  const params = new URLSearchParams({ sort: state.sort });
  if (state.q) params.set('q', state.q);
  if (state.view.kind === 'favorites') params.set('favorite', '1');
  if (state.view.kind === 'game') params.set('game', state.view.game);
  state.clips = await api(`/api/clips?${params}`);
}

// Renders are async; a slow one must not overwrite a newer view (e.g. after a quick nav click).
let renderSeq = 0;
const viewKey = () => JSON.stringify(state.view);

async function renderMain() {
  const seq = ++renderSeq;
  if (state.view.kind === 'exports') return renderExports();
  if (state.view.kind === 'projects') return renderProjects($('#main'), () => seq === renderSeq);
  if (state.view.kind === 'cloud') return renderCloud($('#main'), () => seq === renderSeq);
  if (state.view.kind === 'ai') return renderAi($('#main'), () => seq === renderSeq);
  await loadClips();
  if (seq !== renderSeq) return;
  const title = { all: 'Tous les clips', favorites: 'Favoris', game: state.view.game }[state.view.kind];
  const main = $('#main');

  if (state.clips.length === 0) {
    const status = await api('/api/status');
    main.innerHTML = `<div class="page-head"><h1>${esc(title)}</h1></div>` + (state.q || state.view.kind !== 'all'
      ? `<div class="empty"><h2>Rien ici</h2>Aucun clip ne correspond.</div>`
      : `<div class="empty">
          <h2>Ta bibliothèque est vide</h2>
          <p>Glisse-dépose des clips n’importe où sur cette page,<br>ou copie-les dans <code>${esc(status.clipsDir)}</code>.</p>
          <p>Les noms Xbox Game Bar (<code>Valorant 2026-10-15 21-04-33.mp4</code>) sont classés automatiquement par jeu.</p>
          <button class="btn" id="empty-settings">Changer de dossier</button>
        </div>`);
    $('#empty-settings')?.addEventListener('click', openSettings);
    return;
  }

  const totalDur = state.clips.reduce((s, c) => s + c.duration, 0);
  let html = `<div class="page-head"><h1>${esc(title)}</h1>
    <span class="muted">${state.clips.length} clip${state.clips.length > 1 ? 's' : ''} · ${fmtTime(totalDur, false)}</span></div>`;

  // Group by day when sorted by date
  const byDate = state.sort === 'recent' || state.sort === 'oldest';
  let currentDay = null;
  let open = false;
  for (const clip of state.clips) {
    const day = clip.recorded_at.slice(0, 10);
    if (byDate && day !== currentDay) {
      if (open) html += '</div>';
      html += `<div class="day">${fmtDay(clip.recorded_at)}</div><div class="grid">`;
      currentDay = day;
      open = true;
    } else if (!open) {
      html += '<div class="grid">';
      open = true;
    }
    html += cardHtml(clip);
  }
  if (open) html += '</div>';
  main.innerHTML = html;
}

function cardHtml(c) {
  const time = new Date(c.recorded_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return `
    <article class="card" data-clip="${c.id}">
      <div class="thumb" style="background-image:url(/media/thumbs/${c.id}?v=${c.size})">
        <span class="dur">${fmtTime(c.duration, false)}</span>
      </div>
      <button class="star ${c.favorite ? 'on' : ''}" data-star="${c.id}" title="Favori">${c.favorite ? '★' : '☆'}</button>
      <button class="pick ${state.selected.has(c.id) ? 'on' : ''}" data-pick="${c.id}" title="Sélectionner pour un montage">✓</button>
      <div class="card-body">
        <div class="card-title">${esc(c.title || c.game)}</div>
        <div class="card-meta">
          ${c.title ? `<span>${esc(c.game)}</span>` : ''}
          <span>${time}</span><span>${c.width}×${c.height}</span><span>${fmtSize(c.size)}</span>
        </div>
      </div>
    </article>`;
}

$('#main').addEventListener('click', async (e) => {
  const star = e.target.closest('[data-star]');
  if (star) {
    e.stopPropagation();
    const clip = state.clips.find((c) => c.id === Number(star.dataset.star));
    await api(`/api/clips/${clip.id}`, { method: 'PATCH', body: JSON.stringify({ favorite: !clip.favorite }) });
    clip.favorite = clip.favorite ? 0 : 1;
    star.classList.toggle('on', !!clip.favorite);
    star.textContent = clip.favorite ? '★' : '☆';
    return;
  }
  const pick = e.target.closest('[data-pick]');
  if (pick || (e.shiftKey && e.target.closest('[data-clip]'))) {
    e.stopPropagation();
    const id = Number((pick || e.target.closest('[data-clip]')).dataset.pick || e.target.closest('[data-clip]').dataset.clip);
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    $(`[data-pick="${id}"]`)?.classList.toggle('on', state.selected.has(id));
    renderSelectionBar();
    return;
  }
  const card = e.target.closest('[data-clip]');
  if (card) openEditor(state.clips.find((c) => c.id === Number(card.dataset.clip)));
});

function renderSelectionBar() {
  const n = state.selected.size;
  $('#selbar').hidden = n === 0;
  $('#selbar-ai').hidden = !aiState.active;
  $('#selbar-count').textContent = `${n} clip${n > 1 ? 's' : ''} sélectionné${n > 1 ? 's' : ''}`;
}

$('#selbar-clear').addEventListener('click', () => {
  state.selected.clear();
  $$('.pick.on').forEach((el) => el.classList.remove('on'));
  renderSelectionBar();
});

$('#selbar-ai').addEventListener('click', () => bestOf($('#selbar-ai'), true));
$('#selbar-auto').addEventListener('click', () => bestOf($('#selbar-auto'), false));

async function bestOf(btn, useAi) {
  const label = btn.textContent;
  btn.disabled = true;
  try {
    const job = await api('/api/projects/auto', {
      method: 'POST', body: JSON.stringify({ clipIds: [...state.selected], maxDuration: 60, ai: useAi }),
    });
    const { projectId } = await waitJob(job, (j) => { btn.textContent = j.message || 'Analyse…'; });
    $('#selbar-clear').click();
    toast(useAi ? 'Best-of choisi par l’IA ✨' : 'Best-of créé à partir des meilleurs moments ✨');
    openProject(projectId);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

$('#selbar-create').addEventListener('click', async () => {
  // keep library order (most recent first reads naturally as a highlight reel when reversed)
  const ordered = state.clips.filter((c) => state.selected.has(c.id)).reverse().map((c) => c.id);
  const project = await api('/api/projects', { method: 'POST', body: JSON.stringify({ clipIds: ordered }) });
  $('#selbar-clear').click();
  openProject(project.id);
});

let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = e.target.value.trim();
    if (state.view.kind === 'exports') state.view = { kind: 'all' };
    markActiveNav();
    renderMain();
  }, 200);
});
$('#sort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  renderMain();
});
$('#btn-scan').addEventListener('click', () => api('/api/scan', { method: 'POST' }));

// ---------------------------------------------------------------- exports

async function renderExports() {
  const view = viewKey();
  const [list, pubs] = await Promise.all([api('/api/exports'), api('/api/publications')]);
  const pubsByExport = Map.groupBy(pubs, (p) => p.export_id);
  const running = list.filter((e) => e.status === 'running' || e.status === 'queued').length;
  $('#exports-badge').textContent = running || '';
  if (state.view.kind !== 'exports' || viewKey() !== view) return;

  const main = $('#main');
  if (!list.length) {
    main.innerHTML = `<div class="page-head"><h1>Exports</h1></div>
      <div class="empty"><h2>Aucun export</h2>Ouvre un clip, choisis ta sélection et clique sur « Exporter ».</div>`;
    return;
  }

  // Keep finished <video> elements in place so they don't reload on every poll
  const keep = new Map($$('.export-row', main).map((row) => [row.dataset.key, row]));
  const rows = list.map((e) => {
    const myPubs = pubsByExport.get(e.id) || [];
    const key = `${e.id}:${e.status}:${myPubs.map((p) => `${p.id}${p.status}`).join()}`;
    const existing = keep.get(key);
    if (existing && e.status !== 'running' && !myPubs.some((p) => p.status === 'running')) return existing;

    const row = document.createElement('div');
    row.className = 'export-row';
    row.dataset.key = key;
    const opts = JSON.parse(e.options);
    const meta = opts.montage
      ? `Montage · ${opts.segments} clip${opts.segments > 1 ? 's' : ''}`
      : `${fmtTime(opts.start)} → ${fmtTime(opts.end)} · ${fmtTime(opts.end - opts.start)}${opts.mute ? ' · sans son' : ''}`;
    let status;
    if (e.status === 'done') status = `<span class="muted">${fmtSize(e.size)} · ${fmtDateTime(e.created_at + 'Z')}</span>`;
    else if (e.status === 'failed') status = `<span class="status-failed">Échec : ${esc(e.error)}</span>`;
    else status = `<span class="muted">${e.status === 'queued' ? 'En attente…' : `Export… ${Math.round(e.progress * 100)} %`}</span>
      <div class="progress"><div style="width:${e.progress * 100}%"></div></div>`;
    row.innerHTML = `
      ${e.status === 'done' ? `<video src="/media/exports/${e.id}#t=1" controls preload="metadata"></video>` : '<div class="ph">⏳</div>'}
      <div><b>${esc(e.name)}</b><div class="muted">${meta}</div>${status}${renderPublications(myPubs)}</div>
      <div class="actions">
        ${e.status === 'done' ? `<button class="btn primary" data-publish="${e.id}">Publier</button>
          <a class="btn" href="/media/exports/${e.id}?download=1" title="Télécharger">⬇</a>` : ''}
        ${e.status === 'done' || e.status === 'failed' ? `<button class="btn danger" data-del-export="${e.id}" title="Supprimer">🗑</button>` : ''}
      </div>`;
    return row;
  });

  if (!$('.export-list', main)) main.innerHTML = '<div class="page-head"><h1>Exports</h1></div><div class="export-list"></div>';
  $('.export-list', main).replaceChildren(...rows);
}

$('#main').addEventListener('click', async (e) => {
  const pub = e.target.closest('[data-publish]');
  if (pub) return openPublish(Number(pub.dataset.publish));
  const del = e.target.closest('[data-del-export]');
  if (!del) return;
  if (!confirm('Supprimer ce fichier exporté ?')) return;
  await api(`/api/exports/${del.dataset.delExport}`, { method: 'DELETE' });
  renderExports();
});

// ---------------------------------------------------------------- editor

const ed = {
  clip: null,
  in: 0,
  out: 0,
  video: $('#ed-video'),
  raf: 0,
};

function openEditor(clip) {
  ed.clip = clip;
  ed.in = 0;
  ed.out = clip.duration;
  $('#editor').hidden = false;
  $('#ed-game').textContent = clip.title || clip.game;
  $('#ed-date').textContent = `${clip.game} · ${fmtDateTime(clip.recorded_at)}`;
  $('#ed-title').value = clip.title || '';
  $('#ed-tags').value = clip.tags || '';
  $('#ed-dur').textContent = fmtTime(clip.duration);
  $('#ed-fav').classList.toggle('on', !!clip.favorite);
  $('#ed-fav').textContent = clip.favorite ? '★' : '☆';
  $('#ed-track').style.backgroundImage = `url(/media/thumbs/${clip.id}?v=${clip.size})`;
  $('#ed-export').disabled = false;
  addToProjectMenu($('#ed-add-montage'), () => ({ clipId: ed.clip.id, start: ed.in, end: ed.out }));
  loadHighlights(clip);
  ed.video.src = `/media/clips/${clip.id}`;
  ed.video.muted = $('#ed-mute').checked;
  fitFrame();
  updateMask();
  updateSelection();
  tick();
}

async function loadHighlights(clip) {
  const box = $('#ed-highlights');
  box.innerHTML = '<span class="muted small">Analyse du clip…</span>';
  $('#ed-marks').innerHTML = '';
  ed.curve = null;
  drawCurve();
  let data;
  try {
    data = await api(`/api/clips/${clip.id}/highlights`);
  } catch (err) {
    box.innerHTML = `<span class="muted small">${esc(err.message)}</span>`;
    return;
  }
  if (ed.clip?.id !== clip.id) return; // closed or switched meanwhile
  ed.curve = data.curve;
  drawCurve();
  const d = clip.duration;
  $('#ed-marks').innerHTML = data.highlights.map((h, i) =>
    `<span class="mark" style="left:${(h.time / d) * 100}%" title="Moment ${i + 1}"></span>`).join('');
  box.innerHTML = data.highlights.length
    ? data.highlights.map((h, i) => `
        <button class="hl" data-hl="${i}" title="Sélectionner ${fmtTime(h.start)} → ${fmtTime(h.end)}">
          <b>${i + 1}</b> ${fmtTime(h.time, false)} <span class="stars">${'★'.repeat(Math.max(1, Math.round(h.score * 3)))}</span>
        </button>`).join('') +
      `<span class="muted small">${data.source === 'audio' ? 'Détecté au son (tirs, cris, explosions).' : 'Clip sans son : détecté aux changements d’image.'}</span>`
    : '<span class="muted small">Rien de marquant détecté.</span>';
  box.onclick = (e) => {
    const b = e.target.closest('[data-hl]');
    if (!b) return;
    const h = data.highlights[Number(b.dataset.hl)];
    ed.in = 0;
    ed.out = clip.duration;
    setOut(h.end);
    setIn(h.start);
    seek(h.start);
    ed.video.play();
  };
}

function drawCurve() {
  const canvas = $('#ed-curve');
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * devicePixelRatio));
  canvas.height = Math.max(1, Math.round(rect.height * devicePixelRatio));
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!ed.curve?.length) return;
  const w = canvas.width / ed.curve.length;
  ctx.fillStyle = 'rgba(140, 255, 90, 0.55)';
  ed.curve.forEach((v, i) => {
    const h = Math.max(1, v * canvas.height * 0.9);
    ctx.fillRect(i * w, canvas.height - h, Math.max(1, w - 1), h);
  });
}
window.addEventListener('resize', () => !$('#editor').hidden && drawCurve());

async function closeEditor() {
  ed.video.pause();
  ed.video.removeAttribute('src');
  ed.video.load();
  cancelAnimationFrame(ed.raf);
  $('#editor').hidden = true;
  await saveMeta();
  renderMain();
  renderGames();
}

async function saveMeta() {
  if (!ed.clip) return;
  const title = $('#ed-title').value.trim();
  const tags = $('#ed-tags').value.trim();
  if (title === (ed.clip.title || '') && tags === (ed.clip.tags || '')) return;
  ed.clip = await api(`/api/clips/${ed.clip.id}`, { method: 'PATCH', body: JSON.stringify({ title, tags }) });
}

function fitFrame() {
  if (!ed.clip) return;
  const { w, h } = fitBox($('#editor .stage'), ed.clip.width / ed.clip.height);
  Object.assign($('#ed-frame').style, { width: `${w}px`, height: `${h}px` });
}
window.addEventListener('resize', fitFrame);

const selectedFormat = () => $('input[name=format]:checked').value;

function updateMask() {
  const fmt = selectedFormat();
  // the fight layout's tracked camera is only computed at render time
  $('#ed-mask').hidden = fmt === 'original' || fmt === 'vertical-fight';
  $('#ed-mask').classList.toggle('blur', fmt === 'vertical-blur');
}
$$('input[name=format]').forEach((r) => r.addEventListener('change', updateMask));
$('#ed-mute').addEventListener('change', (e) => { ed.video.muted = e.target.checked; });

function updateSelection() {
  const d = ed.clip.duration;
  $('#ed-sel').style.left = `${(ed.in / d) * 100}%`;
  $('#ed-sel').style.width = `${((ed.out - ed.in) / d) * 100}%`;
  $('#ed-sel-range').textContent = `${fmtTime(ed.in)} → ${fmtTime(ed.out)}`;
  $('#ed-sel-dur').textContent = fmtTime(ed.out - ed.in);
}

function tick() {
  const v = ed.video;
  const d = ed.clip.duration;
  if (!v.paused && $('#ed-loop').checked && v.currentTime >= ed.out) v.currentTime = ed.in;
  $('#ed-head').style.left = `${(v.currentTime / d) * 100}%`;
  $('#ed-time').textContent = fmtTime(v.currentTime);
  $('#ed-play').textContent = v.paused ? '▶' : '❚❚';
  ed.raf = requestAnimationFrame(tick);
}

function togglePlay() {
  const v = ed.video;
  if (v.paused) {
    if (v.currentTime < ed.in || v.currentTime >= ed.out - 0.05) v.currentTime = ed.in;
    v.play();
  } else v.pause();
}

function seek(t) {
  ed.video.currentTime = Math.min(Math.max(0, t), ed.clip.duration);
}

function setIn(t) {
  ed.in = Math.max(0, Math.min(t, ed.out - 0.3));
  updateSelection();
}
function setOut(t) {
  ed.out = Math.min(ed.clip.duration, Math.max(t, ed.in + 0.3));
  updateSelection();
}

$('#ed-play').addEventListener('click', togglePlay);
ed.video.addEventListener('click', togglePlay);
$('#ed-set-in').addEventListener('click', () => setIn(ed.video.currentTime));
$('#ed-set-out').addEventListener('click', () => setOut(ed.video.currentTime));
$$('[data-close-editor]').forEach((b) => b.addEventListener('click', closeEditor));

$('#ed-fav').addEventListener('click', async () => {
  ed.clip = await api(`/api/clips/${ed.clip.id}`, { method: 'PATCH', body: JSON.stringify({ favorite: !ed.clip.favorite }) });
  $('#ed-fav').classList.toggle('on', !!ed.clip.favorite);
  $('#ed-fav').textContent = ed.clip.favorite ? '★' : '☆';
});

// Timeline: drag handles, click/drag elsewhere to scrub
$('#ed-track').addEventListener('pointerdown', (e) => {
  const track = $('#ed-track');
  const rect = track.getBoundingClientRect();
  const timeAt = (x) => ((x - rect.left) / rect.width) * ed.clip.duration;
  const handle = e.target.dataset.handle;
  track.setPointerCapture(e.pointerId);

  const move = (ev) => {
    const t = Math.min(Math.max(0, timeAt(ev.clientX)), ed.clip.duration);
    if (handle === 'in') setIn(t);
    else if (handle === 'out') setOut(t);
    seek(handle === 'in' ? ed.in : handle === 'out' ? ed.out : t);
  };
  move(e);
  track.addEventListener('pointermove', move);
  track.addEventListener('pointerup', () => track.removeEventListener('pointermove', move), { once: true });
});

document.addEventListener('keydown', (e) => {
  if ($('#editor').hidden || e.target.matches('input[type=text], input[type=search], textarea, select')) return;
  const v = ed.video;
  const step = e.shiftKey ? 5 : 1;
  const frame = 1 / 60;
  const actions = {
    ' ': togglePlay,
    i: () => setIn(v.currentTime),
    o: () => setOut(v.currentTime),
    ArrowLeft: () => seek(v.currentTime - step),
    ArrowRight: () => seek(v.currentTime + step),
    ',': () => { v.pause(); seek(v.currentTime - frame); },
    '.': () => { v.pause(); seek(v.currentTime + frame); },
    Home: () => seek(ed.in),
    End: () => seek(ed.out),
    Escape: closeEditor,
  };
  const fn = actions[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (fn) {
    e.preventDefault();
    fn();
  }
});

$('#ed-export').addEventListener('click', async () => {
  const btn = $('#ed-export');
  btn.disabled = true;
  try {
    await saveMeta();
    await api(`/api/clips/${ed.clip.id}/export`, {
      method: 'POST',
      body: JSON.stringify({
        start: ed.in, end: ed.out, format: selectedFormat(),
        mute: $('#ed-mute').checked, title: $('#ed-title').value,
      }),
    });
    toast('Export lancé, suis-le dans « Exports & publication »');
    renderExports();
  } catch (err) {
    toast(err.message, true);
  } finally {
    setTimeout(() => { btn.disabled = false; }, 800);
  }
});

// ---------------------------------------------------------------- settings

async function openSettings() {
  const cfg = await api('/api/settings');
  $('#set-dir').value = cfg.clipsDir;
  await renderRemote();
  $('#settings').showModal();
}
$('#btn-settings').addEventListener('click', openSettings);
$('#settings').addEventListener('close', async () => {
  if ($('#settings').returnValue !== 'save') return;
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ clipsDir: $('#set-dir').value }) });
    toast('Dossier enregistré, scan en cours…');
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------------------------------------------------------------- drag & drop import

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer.types.includes('Files')) return;
  dragDepth++;
  $('#drop').hidden = false;
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('#drop').hidden = true;
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop').hidden = true;
  importFiles([...e.dataTransfer.files]);
});

$('#import-files').addEventListener('change', (e) => {
  importFiles([...e.target.files]);
  e.target.value = '';
});

async function importFiles(files) {
  for (const file of files) {
    toast(`Import de ${file.name}…`);
    try {
      await uploadFile('/api/upload', file);
    } catch (err) {
      toast(`${file.name} : ${err.message}`, true);
    }
  }
  if (files.length) toast(`${files.length} fichier(s) importé(s), analyse en cours…`);
}

// ---------------------------------------------------------------- live updates

async function poll() {
  try {
    const s = await api('/api/status');
    $('#btn-scan').classList.toggle('scanning', s.scanning);
    if (s.version !== state.libraryVersion) {
      state.libraryVersion = s.version;
      await renderGames();
      if (!['exports', 'projects', 'cloud', 'ai'].includes(state.view.kind) && !overlayOpen()) await renderMain();
    }
    if (s.exportsKey !== state.exportsKey) {
      state.exportsKey = s.exportsKey;
      await renderExports();
    }
  } catch {
    // server restarting; try again next tick
  }
  setTimeout(poll, 1500);
}

$('#btn-menu').addEventListener('click', () => document.body.classList.toggle('nav-open'));

// ---------------------------------------------------------------- phone access (settings)

async function renderRemote() {
  let r;
  try {
    r = await api('/api/remote');
  } catch {
    $('.field.phone').hidden = true; // opened from the phone itself
    return;
  }
  $('#set-remote').checked = r.enabled;
  $('#remote-info').hidden = !r.enabled;
  $('#remote-qr').innerHTML = r.qrs[0] || '';
  $('#remote-url').textContent = r.urls[0] || (r.enabled ? 'Aucun réseau Wi-Fi/Ethernet détecté' : '');
}
$('#set-remote').addEventListener('change', async (e) => {
  await api('/api/remote', { method: 'PUT', body: JSON.stringify({ enabled: e.target.checked }) });
  renderRemote();
});
$('#remote-rotate').addEventListener('click', async () => {
  await api('/api/remote', { method: 'PUT', body: JSON.stringify({ enabled: true, rotate: true }) });
  renderRemote();
  toast('Nouvelle clé : rescanne le QR code sur ton téléphone');
});

// Back from Google's consent screen
function handleHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.get('youtube') === 'connected') toast('Compte YouTube connecté ✔');
  if (params.get('youtube') === 'error') toast(`YouTube : ${params.get('message')}`, true);
  if (params.has('youtube')) {
    history.replaceState(null, '', location.pathname);
    state.view = { kind: 'exports' };
  }
}

handleHash();
loadAi().catch(() => {});
markActiveNav();
renderMain();
poll();
