import { $, $$, api, debounce, esc, fitBox, fmtDateTime, fmtTime, toast, uploadFile, waitJob } from './util.js';
import { navigate } from './app.js';

const TEXT_SIZES = { S: 0.05, M: 0.075, L: 0.11 };
const newId = () => Math.random().toString(36).slice(2, 10);

const mt = {
  project: null, // { id, name, data, clips }
  selected: null, // segment id
  playing: false,
  global: 0, // current time on the montage timeline
  segIndex: 0,
  raf: 0,
  music: [],
  video: $('#mt-video'),
  audio: $('#mt-audio'),
};

// ---------------------------------------------------------------- projects list

export async function renderProjects(main, isCurrent = () => true) {
  const [projects, templates] = await Promise.all([api('/api/projects'), api('/api/templates')]);
  if (!isCurrent()) return;
  main.innerHTML = `
    <div class="page-head"><h1>Montages</h1>
      <span class="spacer"></span>
      <select id="new-template" class="select" title="Partir d’un modèle">
        <option value="">Sans modèle</option>
        ${templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}
      </select>
      <button class="btn primary" id="new-project">＋ Nouveau montage</button>
    </div>
    ${projects.length ? `<div class="grid">${projects.map((p) => `
      <article class="card" data-project="${p.id}">
        <div class="thumb" style="${p.coverClipId ? `background-image:url(/media/thumbs/${p.coverClipId})` : ''}">
          <span class="dur">${fmtTime(p.duration, false)}</span>
          <span class="fmt-badge">${p.format === 'vertical' ? '9:16' : '16:9'}</span>
        </div>
        <button class="star" data-del-project="${p.id}" title="Supprimer">🗑</button>
        <div class="card-body">
          <div class="card-title">${esc(p.name)}</div>
          <div class="card-meta"><span>${p.segments} clip${p.segments > 1 ? 's' : ''}</span><span>modifié ${fmtDateTime(p.updated_at + 'Z')}</span></div>
        </div>
      </article>`).join('')}</div>`
    : `<div class="empty"><h2>Aucun montage</h2>
        <p>Crée un montage vide, ou coche plusieurs clips dans la bibliothèque (bouton ✓ ou Maj + clic) puis « Créer un montage ».</p></div>`}`;
}

document.addEventListener('click', async (e) => {
  if (e.target.closest('#new-project')) {
    const templateId = Number($('#new-template')?.value) || null;
    const p = await api('/api/projects', { method: 'POST', body: JSON.stringify({ templateId }) });
    return openProject(p.id);
  }
  const del = e.target.closest('[data-del-project]');
  if (del) {
    e.stopPropagation();
    if (!confirm('Supprimer ce montage ? Les clips et exports ne sont pas supprimés.')) return;
    await api(`/api/projects/${del.dataset.delProject}`, { method: 'DELETE' });
    return navigate('projects');
  }
  const card = e.target.closest('[data-project]');
  if (card) openProject(Number(card.dataset.project));
});

// ---------------------------------------------------------------- "add to montage" (clip editor)

export async function addToProjectMenu(container, getSelection) {
  const projects = await api('/api/projects');
  container.innerHTML = `
    <select class="select">
      <option value="new">＋ Nouveau montage</option>
      ${projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
    </select>
    <button class="btn">Ajouter</button>`;
  container.querySelector('button').onclick = async () => {
    const target = container.querySelector('select').value;
    const seg = getSelection();
    const project = target === 'new'
      ? await api('/api/projects', { method: 'POST', body: JSON.stringify({ data: { segments: [seg] } }) })
      : await api(`/api/projects/${target}/segments`, { method: 'POST', body: JSON.stringify(seg) });
    toast(`Ajouté à « ${project.name} » (${project.segments} clip${project.segments > 1 ? 's' : ''})`);
    addToProjectMenu(container, getSelection);
  };
}

// ---------------------------------------------------------------- open / save

export async function openProject(id) {
  mt.project = await api(`/api/projects/${id}`);
  mt.selected = mt.project.data.segments[0]?.id ?? null;
  mt.global = 0;
  $('#montage').hidden = false;
  $('#mt-name').value = mt.project.name;
  $('#mt-saved').textContent = '';
  mt.music = await api('/api/music');
  renderAll();
  seekGlobal(0);
  cancelAnimationFrame(mt.raf);
  tick();
}

async function closeProject() {
  pause();
  await save.flush();
  cancelAnimationFrame(mt.raf);
  mt.video.removeAttribute('src');
  mt.video.load();
  $('#montage').hidden = true;
  mt.project = null;
  navigate('projects');
}
$('[data-close-montage]').addEventListener('click', closeProject);

const save = debounce(async () => {
  if (!mt.project) return;
  $('#mt-saved').textContent = 'Enregistrement…';
  const saved = await api(`/api/projects/${mt.project.id}`, {
    method: 'PUT', body: JSON.stringify({ name: $('#mt-name').value, data: mt.project.data }),
  });
  if (!mt.project) return;
  mt.project.clips = saved.clips;
  $('#mt-saved').textContent = 'Enregistré ✓';
}, 500);

function changed({ seq = true } = {}) {
  $('#mt-saved').textContent = '…';
  save();
  if (seq) renderSeq();
  renderTotals();
  renderCanvas();
}

$('#mt-name').addEventListener('input', () => changed({ seq: false }));

// ---------------------------------------------------------------- timeline math

/** Mirrors server/montage.js planTimeline so preview time matches the render. */
function timeline() {
  const { data, clips } = mt.project;
  const segs = data.segments
    .map((s) => {
      const clip = clips[s.clipId];
      if (!clip) return null;
      const start = Math.min(s.start, clip.duration);
      const end = Math.min(s.end > s.start ? s.end : clip.duration, clip.duration);
      return end - start >= 0.3 ? { ...s, start, end, dur: end - start, clip } : null;
    })
    .filter(Boolean);
  const useX = data.transition !== 'none' && segs.length > 1;
  const td = useX ? Math.min(data.transitionDuration, Math.min(...segs.map((s) => s.dur)) / 2) : 0;
  let offset = 0;
  segs.forEach((s, i) => {
    s.offset = offset;
    s.visible = i === segs.length - 1 ? s.dur : s.dur - td; // preview plays each until the next starts
    offset += s.visible;
  });
  return { segs, total: offset };
}

// ---------------------------------------------------------------- rendering

function renderAll() {
  renderSeq();
  renderSegInspector();
  renderTexts();
  renderStyle();
  renderMusic();
  renderTotals();
  renderCanvas();
}

function renderTotals() {
  const { total, segs } = timeline();
  $('#mt-total').textContent = `${segs.length} clip${segs.length > 1 ? 's' : ''} · ${fmtTime(total)}`;
  $('#mt-dur').textContent = fmtTime(total);
  $('#mt-render').disabled = segs.length === 0;
}

function renderSeq() {
  const { data, clips } = mt.project;
  const { segs } = timeline();
  const byId = new Map(segs.map((s) => [s.id, s]));
  $('#mt-seq').innerHTML = data.segments.map((s, i) => {
    const clip = clips[s.clipId];
    const eff = byId.get(s.id);
    const dur = eff ? eff.dur : 0;
    return `
      <div class="seq-item ${s.id === mt.selected ? 'active' : ''} ${eff ? '' : 'invalid'}" draggable="true"
           data-seg="${s.id}" style="width:${Math.max(84, dur * 22)}px">
        <div class="seq-thumb" style="${clip ? `background-image:url(/media/thumbs/${clip.id})` : ''}"></div>
        <div class="seq-label"><span>${i + 1}. ${esc(clip ? clip.title || clip.game : 'Clip introuvable')}</span><b>${fmtTime(dur)}</b></div>
      </div>`;
  }).join('') || '<div class="muted seq-empty">Séquence vide. Clique sur « ＋ Ajouter ».</div>';
}

$('#mt-seq').addEventListener('click', (e) => {
  const item = e.target.closest('[data-seg]');
  if (!item) return;
  mt.selected = item.dataset.seg;
  showTab('clip');
  renderSeq();
  renderSegInspector();
  const seg = timeline().segs.find((s) => s.id === mt.selected);
  if (seg) seekGlobal(seg.offset);
});

// drag & drop reorder
let dragId = null;
$('#mt-seq').addEventListener('dragstart', (e) => {
  dragId = e.target.closest('[data-seg]')?.dataset.seg;
  e.dataTransfer.effectAllowed = 'move';
});
$('#mt-seq').addEventListener('dragover', (e) => {
  if (!dragId) return;
  e.preventDefault();
  e.stopPropagation();
});
$('#mt-seq').addEventListener('drop', (e) => {
  if (!dragId) return;
  e.preventDefault();
  e.stopPropagation();
  const target = e.target.closest('[data-seg]');
  const segs = mt.project.data.segments;
  const from = segs.findIndex((s) => s.id === dragId);
  let to = target ? segs.findIndex((s) => s.id === target.dataset.seg) : segs.length - 1;
  if (target && e.offsetX > target.offsetWidth / 2) to += from < to ? 0 : 1;
  else if (target && from < to) to -= 1;
  const [moved] = segs.splice(from, 1);
  segs.splice(Math.max(0, Math.min(segs.length, to)), 0, moved);
  dragId = null;
  changed();
});
$('#mt-seq').addEventListener('dragend', () => { dragId = null; });

// ---------------------------------------------------------------- segment inspector

const selectedSeg = () => mt.project.data.segments.find((s) => s.id === mt.selected);

function renderSegInspector() {
  const seg = mt.project && selectedSeg();
  $('#mt-seg').hidden = !seg;
  $('#mt-seg-empty').hidden = !!seg;
  if (!seg) return;
  const clip = mt.project.clips[seg.clipId];
  $('#mt-seg-game').textContent = clip ? clip.title || clip.game : 'Clip introuvable';
  $('#mt-seg-len').textContent = clip ? `(clip de ${fmtTime(clip.duration)})` : '';
  $('#mt-seg-start').value = seg.start.toFixed(1);
  $('#mt-seg-end').value = (seg.end || clip?.duration || 0).toFixed(1);
  $('#mt-seg-start').max = $('#mt-seg-end').max = clip?.duration ?? 0;
}

function setSegBounds(start, end) {
  const seg = selectedSeg();
  const clip = mt.project.clips[seg.clipId];
  if (!clip) return;
  seg.start = Math.max(0, Math.min(start, clip.duration - 0.3));
  seg.end = Math.min(clip.duration, Math.max(end, seg.start + 0.3));
  renderSegInspector();
  changed();
}

$('#mt-seg-start').addEventListener('change', (e) => setSegBounds(Number(e.target.value), selectedSeg().end));
$('#mt-seg-end').addEventListener('change', (e) => setSegBounds(selectedSeg().start, Number(e.target.value)));

/** Local time inside the selected segment's source clip, if it is the one on screen. */
function currentClipTime() {
  const { segs } = timeline();
  const cur = segs[mt.segIndex];
  return cur && cur.id === mt.selected ? mt.video.currentTime : null;
}

$('#mt-seg-in').addEventListener('click', () => {
  const t = currentClipTime();
  if (t == null) return toast('Place la tête de lecture dans ce clip', true);
  setSegBounds(t, selectedSeg().end);
});
$('#mt-seg-out').addEventListener('click', () => {
  const t = currentClipTime();
  if (t == null) return toast('Place la tête de lecture dans ce clip', true);
  setSegBounds(selectedSeg().start, t);
});
$('#mt-seg-dup').addEventListener('click', () => {
  const segs = mt.project.data.segments;
  const i = segs.findIndex((s) => s.id === mt.selected);
  const copy = { ...segs[i], id: newId() };
  segs.splice(i + 1, 0, copy);
  mt.selected = copy.id;
  changed();
  renderSegInspector();
});
$('#mt-seg-del').addEventListener('click', () => {
  const segs = mt.project.data.segments;
  const i = segs.findIndex((s) => s.id === mt.selected);
  segs.splice(i, 1);
  mt.selected = segs[Math.min(i, segs.length - 1)]?.id ?? null;
  changed();
  renderSegInspector();
  seekGlobal(Math.min(mt.global, timeline().total));
});

// ---------------------------------------------------------------- texts

function renderTexts() {
  const { texts } = mt.project.data;
  $('#mt-text-list').innerHTML = texts.map((t) => `
    <div class="text-item ${t.auto ? 'auto' : ''}" data-text="${t.id}">
      ${t.auto ? '<span class="badge">sous-titre auto</span>' : ''}
      <textarea data-k="text" rows="2" placeholder="Ton texte…">${esc(t.text)}</textarea>
      <div class="row3">
        <label>De <input data-k="start" type="number" step="0.1" min="0" value="${t.start.toFixed(1)}"></label>
        <label>à <input data-k="end" type="number" step="0.1" min="0" value="${t.end.toFixed(1)}"></label>
        <input data-k="color" type="color" value="${t.color}" title="Couleur">
      </div>
      <div class="row3">
        <select data-k="position" class="select">
          ${['top', 'center', 'bottom'].map((p) => `<option value="${p}" ${t.position === p ? 'selected' : ''}>${{ top: 'Haut', center: 'Milieu', bottom: 'Bas' }[p]}</option>`).join('')}
        </select>
        <select data-k="size" class="select">
          ${['S', 'M', 'L'].map((z) => `<option value="${z}" ${t.size === z ? 'selected' : ''}>${{ S: 'Petit', M: 'Moyen', L: 'Grand' }[z]}</option>`).join('')}
        </select>
        <label class="check"><input data-k="box" type="checkbox" ${t.box ? 'checked' : ''}> Fond</label>
      </div>
      <button class="btn small danger" data-del-text>Supprimer</button>
    </div>`).join('') || '<p class="muted">Aucun texte. Ajoute un titre, un compteur de kills, ton pseudo…</p>';
}

$('#mt-text-list').addEventListener('input', (e) => {
  const item = e.target.closest('[data-text]');
  const k = e.target.dataset.k;
  if (!item || !k) return;
  const t = mt.project.data.texts.find((x) => x.id === item.dataset.text);
  const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  t[k] = k === 'start' || k === 'end' ? Math.max(0, Number(v) || 0) : v;
  changed({ seq: false });
});
$('#mt-text-list').addEventListener('click', (e) => {
  if (!e.target.closest('[data-del-text]')) return;
  const id = e.target.closest('[data-text]').dataset.text;
  mt.project.data.texts = mt.project.data.texts.filter((t) => t.id !== id);
  renderTexts();
  changed({ seq: false });
});
$('#mt-text-add').addEventListener('click', () => {
  const start = Math.round(mt.global * 10) / 10;
  mt.project.data.texts.push({
    id: newId(), text: 'Nouveau texte', start, end: start + 3, position: 'bottom', size: 'M', color: '#ffffff', box: true,
  });
  renderTexts();
  changed({ seq: false });
  $('#mt-text-list .text-item:last-child textarea').select();
});

// ---------------------------------------------------------------- automatic subtitles

const SUB_STYLES = {
  tiktok: { style: { position: 'center', size: 'L', color: '#ffffff', box: false }, upper: true },
  classic: { style: { position: 'bottom', size: 'M', color: '#ffffff', box: true }, upper: false },
};

/** Reloads the project from the server after a server-side change, keeping the playhead. */
async function reloadProject() {
  const at = mt.global;
  mt.project = await api(`/api/projects/${mt.project.id}`);
  renderAll();
  seekGlobal(at);
}

$('#sub-run').addEventListener('click', async () => {
  const btn = $('#sub-run');
  const status = $('#sub-status');
  btn.disabled = true;
  try {
    await save.flush();
    const preset = SUB_STYLES[$('#sub-style').value];
    const job = await api(`/api/projects/${mt.project.id}/subtitles`, {
      method: 'POST',
      body: JSON.stringify({
        language: $('#sub-lang').value, quality: $('#sub-quality').value,
        maxWords: Number($('#sub-words').value), ...preset,
      }),
    });
    const { count } = await waitJob(job, (j) => { status.textContent = j.message; });
    await reloadProject();
    status.textContent = count ? `${count} sous-titres ajoutés. Tu peux corriger chaque ligne ci-dessous.` : 'Aucune voix détectée.';
  } catch (err) {
    status.textContent = '';
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------- AI: hooks & assistant

$('#mt-hooks').addEventListener('click', async () => {
  const btn = $('#mt-hooks');
  const list = $('#mt-hook-list');
  btn.disabled = true;
  try {
    await save.flush();
    const job = await api('/api/ai/hooks', { method: 'POST', body: JSON.stringify({ projectId: mt.project.id }) });
    const { hooks } = await waitJob(job, (j) => { list.innerHTML = `<span class="small muted"><span class="spinner"></span> ${esc(j.message || '')}</span>`; });
    list.innerHTML = hooks.map((h) => `<button class="chip" data-hook="${esc(h)}">${esc(h)}</button>`).join('')
      + '<p class="small muted">Clique sur une accroche pour l’ajouter en haut pendant 3 s.</p>';
  } catch (err) {
    list.innerHTML = '';
    toast(err.message.includes('Aucune IA') ? 'Configure d’abord une IA (menu ✨ IA)' : err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('#mt-hook-list').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-hook]');
  if (!chip) return;
  mt.project.data.texts.push({
    id: newId(), text: chip.dataset.hook, start: 0, end: 3, position: 'top', size: 'L', color: '#ffffff', box: true,
  });
  renderTexts();
  changed({ seq: false });
  toast('Accroche ajoutée');
});

export function openAssistant() {
  $('#as-result').hidden = true;
  $('#as-undo').hidden = !mt.project.canUndo;
  renderPool();
  $('#assistant').showModal();
  $('#as-input').focus();
}

/** The videos the assistant is allowed to use: the ones selected for this montage. */
function renderPool() {
  const d = mt.project.data;
  const ids = [...new Set([...d.pool, ...d.segments.map((s) => s.clipId)])];
  const clips = ids.map((id) => mt.project.clips[id]).filter(Boolean);
  $('#as-pool').innerHTML = clips.length
    ? `<div class="small">L’IA travaille uniquement avec ${clips.length === 1 ? 'cette vidéo' : `ces ${clips.length} vidéos`} :</div>
       <div class="pool-list">${clips.map((c) => `
         <span class="pool-item"><span class="pool-thumb" style="background-image:url(/media/thumbs/${c.id})"></span>${esc(c.title || c.game)}
           <em>${fmtTime(c.duration, false)}</em></span>`).join('')}</div>
       <div class="small muted">Pour en changer : ferme, puis « ＋ Ajouter » dans la séquence.</div>`
    : '<div class="status-warn small">Aucune vidéo sélectionnée : ajoute d’abord des clips avec « ＋ Ajouter ».</div>';
  $('#as-run').disabled = !clips.length;
}

$('#mt-assistant').addEventListener('click', openAssistant);
$('[data-close-assistant]').addEventListener('click', () => $('#assistant').close());
$('#assistant').addEventListener('click', (e) => {
  const ex = e.target.closest('[data-example]');
  if (ex) $('#as-input').value = ex.dataset.example;
});

$('#as-run').addEventListener('click', async () => {
  const instruction = $('#as-input').value.trim();
  if (!instruction) return toast('Écris ce que tu veux', true);
  const btn = $('#as-run');
  const out = $('#as-result');
  btn.disabled = true;
  out.hidden = false;
  try {
    await save.flush();
    const job = await api('/api/ai/director', { method: 'POST', body: JSON.stringify({ projectId: mt.project.id, instruction }) });
    const r = await waitJob(job, (j) => { out.innerHTML = `<span class="spinner"></span> ${esc(j.message || 'L’IA travaille…')}`; });
    await reloadProject();
    out.innerHTML = `✔ ${esc(r.explanation)}`;
    $('#as-undo').hidden = false;
  } catch (err) {
    out.innerHTML = `<span class="status-failed">⚠ ${esc(err.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
});

$('#as-undo').addEventListener('click', async () => {
  await api(`/api/projects/${mt.project.id}/undo`, { method: 'POST' });
  await reloadProject();
  $('#as-undo').hidden = true;
  $('#as-result').hidden = false;
  $('#as-result').textContent = '↶ Modification annulée';
});

// ---------------------------------------------------------------- templates

async function renderTemplates() {
  const list = await api('/api/templates');
  $('#tpl-list').innerHTML = list.map((t) => `
    <div class="tpl">
      <div><b>${esc(t.name)}</b>
        <div class="muted small">${t.data.format === 'vertical' ? '9:16' : '16:9'} · ${{ blur: 'fond flou', crop: 'recadré', bars: 'bandes noires' }[t.data.fit]}
          · ${t.data.transition === 'none' ? 'coupes sèches' : t.data.transition} · ${t.data.fps} i/s
          ${t.data.music ? ' · 🎵' : ''}${t.data.texts?.length ? ` · ${t.data.texts.length} texte(s)` : ''}</div></div>
      <button class="btn small primary" data-apply-tpl="${t.id}">Appliquer</button>
      ${t.builtin ? '' : `<button class="btn small danger" data-del-tpl="${t.id}" title="Supprimer">🗑</button>`}
    </div>`).join('');
}

$('#mt-templates').addEventListener('click', async () => {
  await renderTemplates();
  $('#templates').showModal();
});
$('[data-close-templates]').addEventListener('click', () => $('#templates').close());
$('#tpl-list').addEventListener('click', async (e) => {
  const apply = e.target.closest('[data-apply-tpl]');
  const del = e.target.closest('[data-del-tpl]');
  if (apply) {
    await save.flush();
    await api(`/api/projects/${mt.project.id}/apply-template`, {
      method: 'POST', body: JSON.stringify({ templateId: Number(apply.dataset.applyTpl) }),
    });
    await reloadProject();
    $('#templates').close();
    toast('Modèle appliqué');
  }
  if (del) {
    await api(`/api/templates/${del.dataset.delTpl}`, { method: 'DELETE' });
    renderTemplates();
  }
});
$('#tpl-save').addEventListener('click', async () => {
  const name = $('#tpl-name').value.trim();
  if (!name) return toast('Donne un nom au modèle', true);
  await save.flush();
  await api('/api/templates', { method: 'POST', body: JSON.stringify({ name, projectId: mt.project.id }) });
  $('#tpl-name').value = '';
  renderTemplates();
  toast(`Modèle « ${name} » enregistré`);
});

// ---------------------------------------------------------------- style

function renderStyle() {
  const d = mt.project.data;
  $$('.seg-control[data-bind]').forEach((ctrl) => {
    $$('button', ctrl).forEach((b) => b.classList.toggle('active', String(d[ctrl.dataset.bind]) === b.dataset.value));
  });
  $('#mt-transition').value = d.transition;
  $('#mt-td').value = d.transitionDuration;
  $('#mt-td-val').textContent = `${d.transitionDuration.toFixed(1)} s`;
  $('#mt-td').disabled = d.transition === 'none';
  $('#mt-fade').checked = d.fadeInOut;
  $('#mt-gv').value = d.gameVolume;
  $('#mt-gv-val').textContent = `${Math.round(d.gameVolume * 100)} %`;
}

$$('.seg-control[data-bind]').forEach((ctrl) => ctrl.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const key = ctrl.dataset.bind;
  mt.project.data[key] = key === 'fps' ? Number(b.dataset.value) : b.dataset.value;
  renderStyle();
  changed({ seq: false });
}));
$('#mt-transition').addEventListener('change', (e) => {
  mt.project.data.transition = e.target.value;
  renderStyle();
  changed();
});
$('#mt-td').addEventListener('input', (e) => {
  mt.project.data.transitionDuration = Number(e.target.value);
  renderStyle();
  changed();
});
$('#mt-fade').addEventListener('change', (e) => {
  mt.project.data.fadeInOut = e.target.checked;
  changed({ seq: false });
});
$('#mt-gv').addEventListener('input', (e) => {
  mt.project.data.gameVolume = Number(e.target.value);
  renderStyle();
  applyVolumes();
  changed({ seq: false });
});

// ---------------------------------------------------------------- music

function renderMusic() {
  const d = mt.project.data;
  const current = d.music?.file;
  $('#mt-music-list').innerHTML = `
    <label class="music-item"><input type="radio" name="music" value="" ${current ? '' : 'checked'}> <span>Pas de musique</span></label>
    ${mt.music.map((m) => `
      <label class="music-item">
        <input type="radio" name="music" value="${esc(m.file)}" ${current === m.file ? 'checked' : ''}>
        <span>${esc(m.file)}</span><em>${m.duration ? fmtTime(m.duration, false) : '?'}</em>
        <button class="btn small ghost" data-del-music="${esc(m.file)}" title="Supprimer">🗑</button>
      </label>`).join('')}`;
  const vol = d.music?.volume ?? 0.5;
  $('#mt-mv').value = vol;
  $('#mt-mv').disabled = !current;
  $('#mt-mv-val').textContent = `${Math.round(vol * 100)} %`;
  if (current) {
    const src = `/media/music/${encodeURIComponent(current)}`;
    if (!mt.audio.src.endsWith(src)) mt.audio.src = src;
  } else {
    mt.audio.pause();
    mt.audio.removeAttribute('src');
  }
  applyVolumes();
}

$('#mt-music-list').addEventListener('change', (e) => {
  if (e.target.name !== 'music') return;
  mt.project.data.music = e.target.value ? { file: e.target.value, volume: mt.project.data.music?.volume ?? 0.5 } : null;
  renderMusic();
  changed({ seq: false });
});
$('#mt-music-list').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del-music]');
  if (!del) return;
  e.preventDefault();
  if (!confirm(`Supprimer « ${del.dataset.delMusic} » de la bibliothèque musicale ?`)) return;
  await api(`/api/music/${encodeURIComponent(del.dataset.delMusic)}`, { method: 'DELETE' });
  if (mt.project.data.music?.file === del.dataset.delMusic) {
    mt.project.data.music = null;
    changed({ seq: false });
  }
  mt.music = await api('/api/music');
  renderMusic();
});
$('#mt-music-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const { file: name } = await uploadFile('/api/music', file);
    mt.music = await api('/api/music');
    mt.project.data.music = { file: name, volume: mt.project.data.music?.volume ?? 0.5 };
    renderMusic();
    changed({ seq: false });
    toast('Musique ajoutée');
  } catch (err) {
    toast(err.message, true);
  }
});
$('#mt-mv').addEventListener('input', (e) => {
  if (!mt.project.data.music) return;
  mt.project.data.music.volume = Number(e.target.value);
  $('#mt-mv-val').textContent = `${Math.round(e.target.value * 100)} %`;
  applyVolumes();
  changed({ seq: false });
});

function applyVolumes() {
  const d = mt.project.data;
  mt.video.volume = Math.min(1, d.gameVolume);
  mt.audio.volume = Math.min(1, d.music?.volume ?? 0);
}

// ---------------------------------------------------------------- tabs

function showTab(name) {
  $$('#montage .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('#montage .tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
}
$$('#montage .tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

// ---------------------------------------------------------------- preview canvas

function renderCanvas() {
  if (!mt.project) return;
  const d = mt.project.data;
  const { w, h } = fitBox($('#montage .stage'), d.format === 'vertical' ? 9 / 16 : 16 / 9, 0.62);
  const canvas = $('#mt-canvas');
  Object.assign(canvas.style, { width: `${w}px`, height: `${h}px` });
  canvas.dataset.fit = d.fit;
  renderOverlayTexts();
}
window.addEventListener('resize', () => !$('#montage').hidden && renderCanvas());

function renderOverlayTexts() {
  const canvas = $('#mt-canvas');
  const base = Math.min(canvas.offsetWidth, canvas.offsetHeight);
  const active = mt.project.data.texts.filter((t) => t.text.trim() && mt.global >= t.start && mt.global <= t.end);
  const html = active.map((t) => {
    const size = base * TEXT_SIZES[t.size];
    return `<div class="ov-text pos-${t.position} ${t.box ? 'boxed' : 'outlined'}"
      style="font-size:${size}px;color:${t.color}">${t.text.split('\n').map((l) => `<span>${esc(l)}</span>`).join('')}</div>`;
  }).join('');
  if ($('#mt-texts').innerHTML !== html) $('#mt-texts').innerHTML = html;
}

// ---------------------------------------------------------------- playback

function loadSegment(i, localTime, autoplay) {
  const { segs } = timeline();
  const seg = segs[i];
  if (!seg) return;
  mt.segIndex = i;
  const src = `/media/clips/${seg.clip.id}`;
  const v = mt.video;
  const go = () => {
    v.currentTime = seg.start + localTime;
    if (autoplay) v.play().catch(() => {});
  };
  $('#mt-bg').style.backgroundImage = `url(/media/thumbs/${seg.clip.id})`;
  if (!v.src.endsWith(src)) {
    v.src = src;
    v.addEventListener('loadedmetadata', go, { once: true });
  } else go();
}

function seekGlobal(t) {
  const { segs, total } = timeline();
  mt.global = Math.max(0, Math.min(t, total));
  if (!segs.length) {
    mt.video.removeAttribute('src');
    return;
  }
  let i = segs.findIndex((s) => mt.global < s.offset + s.visible);
  if (i < 0) i = segs.length - 1;
  loadSegment(i, Math.min(mt.global - segs[i].offset, segs[i].visible - 0.05), mt.playing);
  syncAudio(true);
}

function syncAudio(force = false) {
  const a = mt.audio;
  if (!a.src || !a.duration) return;
  const want = mt.global % a.duration;
  if (force || Math.abs(a.currentTime - want) > 0.3) a.currentTime = want;
  if (mt.playing && a.paused) a.play().catch(() => {});
  if (!mt.playing && !a.paused) a.pause();
}

function play() {
  const { total } = timeline();
  if (!total) return;
  if (mt.global >= total - 0.05) mt.global = 0;
  mt.playing = true;
  seekGlobal(mt.global);
}

function pause() {
  mt.playing = false;
  mt.video.pause();
  mt.audio.pause();
}

$('#mt-play').addEventListener('click', () => (mt.playing ? pause() : play()));
mt.video.addEventListener('click', () => (mt.playing ? pause() : play()));

function tick() {
  if (mt.project) {
    const { segs, total } = timeline();
    const seg = segs[mt.segIndex];
    if (seg && mt.playing && !mt.video.seeking) {
      const local = mt.video.currentTime - seg.start;
      if (local >= seg.visible || mt.video.ended) {
        if (mt.segIndex + 1 < segs.length) loadSegment(mt.segIndex + 1, 0, true);
        else {
          pause();
          mt.global = total;
        }
      } else {
        mt.global = seg.offset + Math.max(0, local);
      }
      syncAudio();
    }
    $('#mt-time').textContent = fmtTime(mt.global);
    $('#mt-play').textContent = mt.playing ? '❚❚' : '▶';
    $('#mt-scrub-head').style.left = `${total ? (mt.global / total) * 100 : 0}%`;
    renderOverlayTexts();
  }
  mt.raf = requestAnimationFrame(tick);
}

$('#mt-scrub').addEventListener('pointerdown', (e) => {
  const el = $('#mt-scrub');
  const rect = el.getBoundingClientRect();
  const at = (x) => ((x - rect.left) / rect.width) * timeline().total;
  el.setPointerCapture(e.pointerId);
  const move = (ev) => seekGlobal(at(ev.clientX));
  move(e);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', () => el.removeEventListener('pointermove', move), { once: true });
});

document.addEventListener('keydown', (e) => {
  if ($('#montage').hidden || !$('#mt-picker').hidden) return;
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === ' ') {
    e.preventDefault();
    mt.playing ? pause() : play();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    seekGlobal(mt.global + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5 : 1));
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && mt.selected) {
    $('#mt-seg-del').click();
  }
});

// ---------------------------------------------------------------- clip picker

let pickerClips = [];

async function openPicker() {
  pickerClips = await api('/api/clips');
  $('#mt-picker-q').value = '';
  renderPicker();
  $('#mt-picker').hidden = false;
  $('#mt-picker-q').focus();
}

function renderPicker() {
  const q = $('#mt-picker-q').value.trim().toLowerCase();
  const list = pickerClips.filter((c) => !q || `${c.game} ${c.title || ''} ${c.tags}`.toLowerCase().includes(q));
  const counts = new Map();
  for (const s of mt.project.data.segments) counts.set(s.clipId, (counts.get(s.clipId) || 0) + 1);
  $('#mt-picker-grid').innerHTML = list.map((c) => `
    <article class="card" data-pick-clip="${c.id}">
      <div class="thumb" style="background-image:url(/media/thumbs/${c.id}?v=${c.size})">
        <span class="dur">${fmtTime(c.duration, false)}</span>
        ${counts.get(c.id) ? `<span class="fmt-badge on">×${counts.get(c.id)}</span>` : ''}
      </div>
      <div class="card-body"><div class="card-title">${esc(c.title || c.game)}</div>
        <div class="card-meta"><span>${esc(c.game)}</span><span>${fmtDateTime(c.recorded_at)}</span></div></div>
    </article>`).join('') || '<p class="muted">Aucun clip.</p>';
}

$('#mt-add').addEventListener('click', openPicker);
$('#mt-picker-q').addEventListener('input', renderPicker);
$('[data-close-picker]').addEventListener('click', () => { $('#mt-picker').hidden = true; });
$('#mt-picker-grid').addEventListener('click', (e) => {
  const card = e.target.closest('[data-pick-clip]');
  if (!card) return;
  const clip = pickerClips.find((c) => c.id === Number(card.dataset.pickClip));
  const seg = { id: newId(), clipId: clip.id, start: 0, end: clip.duration };
  mt.project.data.segments.push(seg);
  mt.project.clips[clip.id] = clip;
  if (!mt.project.data.pool.includes(clip.id)) mt.project.data.pool.push(clip.id);
  mt.selected = seg.id;
  changed();
  renderSegInspector();
  renderPicker();
});

// ---------------------------------------------------------------- render

$('#mt-render').addEventListener('click', async () => {
  const btn = $('#mt-render');
  btn.disabled = true;
  try {
    await save.flush();
    await api(`/api/projects/${mt.project.id}/render`, { method: 'POST' });
    toast('Rendu lancé, suis-le dans « Exports & publication »');
  } catch (err) {
    toast(err.message, true);
  } finally {
    setTimeout(() => { btn.disabled = false; }, 800);
  }
});
