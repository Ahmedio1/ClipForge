import { $, $$, api, esc, toast } from './util.js';

const PLATFORM = {
  youtube: { label: 'YouTube', icon: '▶' },
  tiktok: { label: 'TikTok', icon: '♪', upload: 'https://www.tiktok.com/tiktokstudio/upload', limit: 2200 },
  instagram: { label: 'Instagram', icon: '◎', upload: 'https://www.instagram.com/', limit: 2200 },
  x: { label: 'X', icon: '𝕏', upload: 'https://x.com/compose/post', limit: 280 },
};

const pub = { exp: null, tab: 'youtube' };

/** Small badges listing where an export was published, shown in the exports list. */
export function renderPublications(list) {
  if (!list.length) return '';
  return `<div class="pubs">${list.map((p) => {
    const name = PLATFORM[p.platform]?.label || p.platform;
    if (p.status === 'running' || p.status === 'queued') {
      return `<span class="pub running">${name} · envoi ${Math.round(p.progress * 100)} %</span>`;
    }
    if (p.status === 'failed') return `<span class="pub failed" title="${esc(p.error)}">${name} · échec</span>`;
    if (p.url) return `<a class="pub done" href="${esc(p.url)}" target="_blank" rel="noopener">${name} ✓ voir</a>`;
    return `<span class="pub done">${name} ✓ (manuel)</span>`;
  }).join('')}</div>`;
}

export async function openPublish(exportId) {
  const exportsList = await api('/api/exports');
  pub.exp = exportsList.find((e) => e.id === exportId);
  if (!pub.exp) return;
  $('#pub-name').textContent = `· ${pub.exp.name}`;
  await showTab(pub.tab);
  $('#publish').showModal();
}

$('[data-close-publish]').addEventListener('click', () => $('#publish').close());
$$('#publish .tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.ptab)));

const isVertical = () => /9:16/.test(pub.exp.name);
const baseTitle = () => pub.exp.name.replace(/\s+–\s+.*$/, '');
const gameTag = () => (pub.exp.game ? `#${pub.exp.game.replace(/[^\p{L}\p{N}]/gu, '')}` : '');

async function showTab(tab) {
  pub.tab = tab;
  $$('#publish .tab').forEach((t) => t.classList.toggle('active', t.dataset.ptab === tab));
  $('#pub-body').innerHTML = tab === 'youtube' ? await youtubeHtml() : manualHtml(tab);
}

// ---------------------------------------------------------------- YouTube

async function youtubeHtml() {
  const s = await api('/api/youtube');
  if (!s.configured) return setupHtml();
  return s.connected ? uploadHtml(s) : connectHtml();
}

function setupHtml() {
  return `
    <div class="setup">
        <p><b>Configuration unique (≈ 5 min).</b> YouTube exige que chaque appli ait ses propres identifiants Google :</p>
        <ol>
          <li>Va sur <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Google Cloud Console</a> et crée un projet (ex. « ClipForge »).</li>
          <li>Active <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener">YouTube Data API v3</a>.</li>
          <li>Dans <i>Écran de consentement OAuth</i> : type « Externe », ajoute ton adresse Gmail dans <i>Utilisateurs test</i>.</li>
          <li>Dans <i>Identifiants → Créer → ID client OAuth</i>, choisis <b>Application de bureau</b>.</li>
          <li>Colle ici l’ID client et le code secret :</li>
        </ol>
        <label class="field"><span>ID client</span><input id="yt-cid" type="text" placeholder="xxxx.apps.googleusercontent.com"></label>
        <label class="field"><span>Code secret du client</span><input id="yt-secret" type="password"></label>
        <div class="dialog-actions"><button class="btn primary" id="yt-save">Enregistrer</button></div>
      </div>`;
}

function connectHtml() {
  return `
    <div class="setup">
        <p>Identifiants enregistrés. Il reste à autoriser ClipForge à envoyer des vidéos sur ta chaîne.</p>
        <div class="dialog-actions">
          <button class="btn ghost" id="yt-reset">Changer les identifiants</button>
          <a class="btn primary" href="/api/youtube/connect">Connecter mon compte YouTube</a>
        </div>
      </div>`;
}

function uploadHtml(s) {
  const vertical = isVertical();
  return `
    <div class="connected">Connecté à <b>${esc(s.channel?.title || 'ta chaîne')}</b>
      <button class="btn small ghost" id="yt-disconnect">Déconnecter</button></div>
    <label class="field"><span>Titre <em class="count" data-count-for="yt-title" data-max="100"></em></span>
      <input id="yt-title" type="text" maxlength="100" value="${esc(baseTitle() + (vertical ? ' #Shorts' : ''))}"></label>
    <label class="field"><span>Description</span>
      <textarea id="yt-desc" rows="4" maxlength="5000">${esc(`${gameTag()} #gaming`)}</textarea></label>
    <label class="field"><span>Tags (séparés par des virgules)</span>
      <input id="yt-tags" type="text" value="${esc([pub.exp.game, 'gaming', vertical ? 'shorts' : 'clip'].filter(Boolean).join(', '))}"></label>
    <div class="row2">
      <label class="field"><span>Visibilité</span>
        <select id="yt-privacy" class="select">
          <option value="private">Privée</option>
          <option value="unlisted">Non répertoriée</option>
          <option value="public">Publique</option>
        </select></label>
      <label class="field"><span>Programmer (optionnel)</span>
        <input id="yt-at" type="datetime-local"></label>
    </div>
    <label class="check"><input id="yt-short" type="checkbox" ${vertical ? 'checked' : ''}> C’est un Short (vertical, moins de 3 min)</label>
    <p class="note">⚠ Tant que ton projet Google n’a pas passé l’audit YouTube (gratuit, sur demande), YouTube
      verrouille en <b>privé</b> les vidéos envoyées par API. Tu pourras alors les passer en public après l’audit.</p>
    <div class="dialog-actions"><button class="btn primary" id="yt-send">Envoyer sur YouTube</button></div>`;
}

$('#pub-body').addEventListener('click', async (e) => {
  const id = e.target.id;
  try {
    if (id === 'yt-save') {
      await api('/api/youtube/credentials', {
        method: 'PUT', body: JSON.stringify({ clientId: $('#yt-cid').value, clientSecret: $('#yt-secret').value }),
      });
      return showTab('youtube');
    }
    if (id === 'yt-reset') {
      $('#pub-body').innerHTML = setupHtml();
      return;
    }
    if (id === 'yt-disconnect') {
      await api('/api/youtube/disconnect', { method: 'POST' });
      return showTab('youtube');
    }
    if (id === 'yt-send') {
      const at = $('#yt-at').value;
      await api(`/api/exports/${pub.exp.id}/publish`, {
        method: 'POST',
        body: JSON.stringify({
          platform: 'youtube',
          title: $('#yt-title').value,
          description: $('#yt-desc').value,
          tags: $('#yt-tags').value,
          privacy: $('#yt-privacy').value,
          publishAt: at ? new Date(at).toISOString() : null,
          short: $('#yt-short').checked,
        }),
      });
      $('#publish').close();
      toast(at ? 'Envoi lancé, la vidéo sera publiée à la date choisie' : 'Envoi vers YouTube lancé');
    }
    if (e.target.dataset.manual === 'copy') {
      await navigator.clipboard.writeText($('#man-caption').value);
      toast('Légende copiée');
    }
    if (e.target.dataset.manual === 'done') {
      await api(`/api/exports/${pub.exp.id}/publish`, {
        method: 'POST', body: JSON.stringify({ platform: pub.tab, description: $('#man-caption').value }),
      });
      $('#publish').close();
      toast(`Publication ${PLATFORM[pub.tab].label} enregistrée`);
    }
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------------------------------------------------------------- assisted platforms

function manualHtml(tab) {
  const p = PLATFORM[tab];
  const caption = `${baseTitle()} ${gameTag()} #gaming${tab === 'tiktok' ? ' #fyp' : ''}`.trim();
  const why = {
    tiktok: 'TikTok n’ouvre la publication directe qu’aux applis auditées et en HTTPS, pas à une appli locale.',
    instagram: 'Instagram exige un compte pro relié à Facebook et une vidéo hébergée sur une URL publique.',
    x: 'L’API de X pour les vidéos est payante.',
  }[tab];
  return `
    <p class="muted small">${why} ClipForge prépare donc tout et tu postes en 3 clics :</p>
    <label class="field"><span>Légende <em class="count" data-count-for="man-caption" data-max="${p.limit}"></em></span>
      <textarea id="man-caption" rows="4" maxlength="${p.limit}">${esc(caption)}</textarea></label>
    <ol class="steps">
      <li><button class="btn" data-manual="copy">1 · Copier la légende</button></li>
      <li><a class="btn" href="/media/exports/${pub.exp.id}?download=1">2 · Télécharger la vidéo</a></li>
      <li><a class="btn" href="${p.upload}" target="_blank" rel="noopener">3 · Ouvrir ${p.label}</a></li>
    </ol>
    ${tab !== 'x' && !isVertical() ? `<p class="note">Astuce : ${p.label} met en avant les vidéos verticales. Exporte en 9:16.</p>` : ''}
    <div class="dialog-actions"><button class="btn primary" data-manual="done">C’est posté ✓</button></div>`;
}

// live character counters
$('#pub-body').addEventListener('input', updateCounts);
new MutationObserver(updateCounts).observe($('#pub-body'), { childList: true });
function updateCounts() {
  $$('[data-count-for]', $('#pub-body')).forEach((el) => {
    const input = $(`#${el.dataset.countFor}`);
    if (input) el.textContent = `${input.value.length}/${el.dataset.max}`;
  });
}
