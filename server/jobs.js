import crypto from 'node:crypto';

// In-memory registry for long requests (analysis, transcription) the UI polls.
const jobs = new Map();

export function startJob(kind, fn) {
  const id = crypto.randomBytes(6).toString('hex');
  const job = { id, kind, status: 'running', progress: 0, message: '', result: null, error: null };
  jobs.set(id, job);
  const update = (patch) => Object.assign(job, patch);
  fn(update)
    .then((result) => update({ status: 'done', progress: 1, result }))
    .catch((err) => update({ status: 'failed', error: err.message }))
    .finally(() => setTimeout(() => jobs.delete(id), 10 * 60_000));
  return job;
}

export const getJob = (id) => jobs.get(id) || null;

/** Serializes async work that must not run concurrently (e.g. one model in memory). */
export function mutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}
