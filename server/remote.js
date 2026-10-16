import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import QRCode from 'qrcode';
import { getConfig, updateConfig } from './config.js';

// Phone access: the app normally listens on 127.0.0.1 only. When enabled, it also listens on
// the computer's LAN addresses, and every request from there must carry the secret key
// (from the QR code once, then an httpOnly cookie).

const COOKIE = 'cf_key';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
let lanServers = [];

export const isLocal = (req) => LOOPBACK.has(req.socket.remoteAddress);

export function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    // docker/libvirt bridges aren't reachable from a phone
    .filter((a) => !/^(172\.(1[7-9]|2\d|3[01])|192\.168\.122)\./.test(a.address))
    .map((a) => a.address);
}

function readCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

const safeEqual = (a, b) => {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The host name of a Host header ("localhost:4317" → "localhost", "[::1]:4317" → "[::1]"). */
export function hostName(header) {
  try {
    return new URL(`http://${header}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Only our own names are served. Without this, a website could point its domain at 127.0.0.1
 * (DNS rebinding): the browser would then treat the API as same-origin and drive it freely.
 */
export function knownHost(header) {
  const name = hostName(header);
  if (!name) return false;
  if (LOCAL_NAMES.has(name)) return true;
  return !!getConfig().remote?.enabled && lanAddresses().includes(name);
}

/** Express middleware: gatekeeps non-local requests and blocks cross-site writes. */
export function guard(req, res, next) {
  if (!knownHost(req.headers.host)) return res.status(421).send('Hôte inconnu');
  // Another website open in the browser must not be able to drive the API (CSRF).
  const origin = req.headers.origin;
  if (origin && req.method !== 'GET' && req.method !== 'HEAD') {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      host = null;
    }
    if (host !== req.headers.host) return res.status(403).json({ error: 'Origine refusée' });
  }

  if (isLocal(req)) return next();
  const { remote } = getConfig();
  if (!remote?.enabled) return res.status(403).send('Accès à distance désactivé');

  if (req.query.key) {
    if (!safeEqual(String(req.query.key), remote.token)) return res.status(401).send('Clé invalide');
    res.setHeader('Set-Cookie', `${COOKIE}=${remote.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`);
    return res.redirect('/');
  }
  if (!safeEqual(readCookie(req, COOKIE), remote.token)) {
    return res.status(401).send(`<!doctype html><meta name="viewport" content="width=device-width">
      <body style="font:16px system-ui;background:#0b0e13;color:#e8ecf2;padding:24px">
      <h2>ClipForge</h2><p>Scanne le QR code affiché dans les réglages de ClipForge sur ton PC.</p>`);
  }
  next();
}

export async function remoteStatus(port) {
  const { remote } = getConfig();
  const enabled = !!remote?.enabled;
  const urls = enabled ? lanAddresses().map((ip) => `http://${ip}:${port}/?key=${remote.token}`) : [];
  const qrs = await Promise.all(urls.map((u) => QRCode.toString(u, { type: 'svg', margin: 1 })));
  return { enabled, urls, qrs, listening: lanServers.map((s) => s.address()?.address).filter(Boolean) };
}

export function setRemote(enabled, app, port, { rotate = false } = {}) {
  const current = getConfig().remote || {};
  const token = rotate || !current.token ? crypto.randomBytes(24).toString('base64url') : current.token;
  updateConfig({ remote: { enabled: !!enabled, token } });
  return applyListeners(app, port);
}

export function applyListeners(app, port) {
  for (const s of lanServers) {
    s.closeAllConnections?.();
    s.close();
  }
  lanServers = [];
  if (!getConfig().remote?.enabled) return Promise.resolve();
  return Promise.all(lanAddresses().map((ip) => new Promise((resolve) => {
    const server = http.createServer(app);
    server.on('error', (err) => {
      console.warn(`[remote] écoute impossible sur ${ip}:${port}: ${err.message}`);
      resolve();
    });
    server.listen(port, ip, () => {
      lanServers.push(server);
      resolve();
    });
  })));
}
