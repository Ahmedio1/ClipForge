export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const api = async (url, opts = {}) => {
  const res = await fetch(url, {
    ...opts,
    headers: opts.body && !(opts.body instanceof Blob) ? { 'content-type': 'application/json', ...opts.headers } : opts.headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function fmtTime(sec, precise = true) {
  sec = Math.max(0, sec || 0);
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return precise ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
}
export const fmtSize = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(2)} Go` : `${(b / 1e6).toFixed(1)} Mo`);
export const fmtDay = (iso) => new Date(iso).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
export const fmtDateTime = (iso) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

export function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4000);
}

/** Streams a File to an upload endpoint that reads the name from x-filename. */
export function uploadFile(url, file) {
  return api(url, { method: 'POST', body: file, headers: { 'x-filename': encodeURIComponent(file.name) } });
}

export const debounce = (fn, ms) => {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => {
    clearTimeout(t);
    return fn(...args);
  };
  return wrapped;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls a server job until it finishes; `onUpdate` gets the job on each tick. */
export async function waitJob(job, onUpdate) {
  for (;;) {
    const j = await api(`/api/jobs/${job.id}`);
    onUpdate?.(j);
    if (j.status === 'done') return j.result;
    if (j.status === 'failed') throw new Error(j.error);
    await sleep(400);
  }
}

/**
 * Largest box of `ratio` (w/h) fitting the stage. On phones the stage has no fixed height
 * (the page scrolls), so the height is capped by a share of the viewport instead.
 */
export function fitBox(stage, ratio, phoneShare = 0.5) {
  const rect = stage.getBoundingClientRect();
  const phone = matchMedia('(max-width: 900px)').matches;
  const maxH = phone ? innerHeight * phoneShare : rect.height;
  let w = rect.width;
  let h = w / ratio;
  if (h > maxH) {
    h = maxH;
    w = h * ratio;
  }
  return { w, h };
}
