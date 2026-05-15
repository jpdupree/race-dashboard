// Cloudflare Worker: race-dashboard auth proxy.
//
// Endpoints (all under whatever base path you mount the worker at):
//   POST /login    { username, password }              → { token, username, role, expiresAt }
//   POST /commit   { path, content, sha?, message }    + Authorization: Bearer <jwt> → GitHub PUT response
//   GET  /get?path=races/.../config.json               + Authorization: Bearer <jwt> → GitHub Contents response
//   GET  /health                                       → { ok: true }
//
// Env vars (set via `wrangler secret put` for sensitive values):
//   GITHUB_TOKEN     PAT with Contents: Read and write on the hub repo
//   GITHUB_OWNER     e.g. "jpdupree"
//   GITHUB_REPO      e.g. "race-dashboard"
//   GITHUB_BRANCH    e.g. "main"
//   JWT_SECRET       random string, used to sign session tokens (HS256)
//   USERS            JSON array: [{ username, hash, salt, iterations, role? }]
//                    Generate hash/salt with admin/hash.html (PBKDF2-SHA256).
//   ALLOWED_ORIGINS  optional, comma-separated list. Defaults to "*".
//
// Session JWTs are HS256, 12 hours.

const SESSION_HOURS = 12;
const PBKDF2_DEFAULT_ITERATIONS = 100000;

// ---------- CORS ----------
function corsHeaders(env, req) {
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.get('Origin') || '';
  let allowOrigin = '*';
  if (allowed[0] !== '*') {
    allowOrigin = allowed.includes(origin) ? origin : allowed[0];
  }
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(data, init, env, req) {
  return new Response(JSON.stringify(data), {
    ...(init || {}),
    headers: {
      ...((init && init.headers) || {}),
      'Content-Type': 'application/json',
      ...corsHeaders(env, req)
    }
  });
}

// ---------- base64 helpers ----------
function bytesToBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function base64ToBytes(s) {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64UrlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return base64ToBytes(s);
}

// UTF-8 string → base64 (for GitHub PUT content)
function utf8ToBase64(s) {
  const enc = new TextEncoder();
  return bytesToBase64(enc.encode(s));
}

// ---------- PBKDF2 password verification ----------
async function verifyPassword(password, hashB64, saltB64, iterations) {
  const enc = new TextEncoder();
  const salt = base64ToBytes(saltB64);
  const expected = base64ToBytes(hashB64);
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: iterations || PBKDF2_DEFAULT_ITERATIONS, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const actual = new Uint8Array(bits);
  if (actual.length !== expected.length) return false;
  // Constant-time compare
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

// ---------- HS256 JWT ----------
async function hmacKey(secret) {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

async function signJwt(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const enc = new TextEncoder();
  const headerB64 = bytesToBase64Url(enc.encode(JSON.stringify(header)));
  const payloadB64 = bytesToBase64Url(enc.encode(JSON.stringify(payload)));
  const data = headerB64 + '.' + payloadB64;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return data + '.' + bytesToBase64Url(new Uint8Array(sig));
}

async function verifyJwt(token, secret) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const enc = new TextEncoder();
  const data = parts[0] + '.' + parts[1];
  try {
    const key = await hmacKey(secret);
    const sig = base64UrlToBytes(parts[2]);
    const ok = await crypto.subtle.verify('HMAC', key, sig, enc.encode(data));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1])));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch (e) { return null; }
}

async function requireAuth(req, env) {
  const h = req.headers.get('authorization') || '';
  const token = h.replace(/^Bearer\s+/i, '');
  return verifyJwt(token, env.JWT_SECRET);
}

// ---------- handlers ----------
async function handleLogin(req, env) {
  let body;
  try { body = await req.json(); }
  catch (e) { return json({ error: 'Invalid JSON' }, { status: 400 }, env, req); }
  const { username, password } = body || {};
  if (!username || !password) {
    return json({ error: 'username and password required' }, { status: 400 }, env, req);
  }
  let users;
  try { users = JSON.parse(env.USERS || '[]'); }
  catch (e) { return json({ error: 'USERS not configured' }, { status: 500 }, env, req); }
  const user = users.find(u => u.username === username);
  // Always run a hash check (against random data if user missing) to avoid timing leaks.
  if (!user) {
    await verifyPassword(password, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', 'AAAAAAAAAAAAAAAAAAAAAA==', PBKDF2_DEFAULT_ITERATIONS).catch(() => {});
    return json({ error: 'Invalid credentials' }, { status: 401 }, env, req);
  }
  const ok = await verifyPassword(password, user.hash, user.salt, user.iterations);
  if (!ok) return json({ error: 'Invalid credentials' }, { status: 401 }, env, req);
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  const role = user.role || 'crew';
  const token = await signJwt({ sub: user.username, role, exp }, env.JWT_SECRET);
  return json({ token, username: user.username, role, expiresAt: exp }, {}, env, req);
}

function pathIsAllowed(path, role) {
  if (!path) return false;
  if (!path.startsWith('races/')) return false;
  // For v1, any authenticated user can write to anything under races/.
  // Add role gates here when you want them.
  return true;
}

async function handleCommit(req, env) {
  const session = await requireAuth(req, env);
  if (!session) return json({ error: 'Unauthorized' }, { status: 401 }, env, req);

  let body;
  try { body = await req.json(); }
  catch (e) { return json({ error: 'Invalid JSON' }, { status: 400 }, env, req); }
  const { path, content, sha, message } = body || {};
  if (!path || typeof content !== 'string' || !message) {
    return json({ error: 'Missing path, content, or message' }, { status: 400 }, env, req);
  }
  if (!pathIsAllowed(path, session.role)) {
    return json({ error: 'Forbidden path' }, { status: 403 }, env, req);
  }

  const ghUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURI(path)}`;
  const ghBody = {
    message: `${message} (via ${session.sub})`,
    branch: env.GITHUB_BRANCH || 'main',
    content: utf8ToBase64(content)
  };
  if (sha) ghBody.sha = sha;

  const res = await fetch(ghUrl, {
    method: 'PUT',
    headers: {
      Authorization: `token ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'race-dashboard-proxy'
    },
    body: JSON.stringify(ghBody)
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env, req) }
  });
}

async function handleGet(req, env) {
  const session = await requireAuth(req, env);
  if (!session) return json({ error: 'Unauthorized' }, { status: 401 }, env, req);
  const url = new URL(req.url);
  const path = url.searchParams.get('path');
  if (!path) return json({ error: 'Missing path' }, { status: 400 }, env, req);
  if (!pathIsAllowed(path, session.role)) {
    return json({ error: 'Forbidden path' }, { status: 403 }, env, req);
  }
  const ghUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURI(path)}?ref=${encodeURIComponent(env.GITHUB_BRANCH || 'main')}`;
  const res = await fetch(ghUrl, {
    headers: {
      Authorization: `token ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'race-dashboard-proxy'
    }
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env, req) }
  });
}

// ---------- router ----------
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }
    const url = new URL(request.url);
    // Strip an optional mount prefix so the worker can live at /race-dashboard/* on a shared domain.
    const mount = env.MOUNT_PATH || '';
    let path = url.pathname;
    if (mount && path.startsWith(mount)) path = path.slice(mount.length) || '/';
    path = path.replace(/\/+$/, '') || '/';

    if (request.method === 'GET'  && path === '/health') return json({ ok: true }, {}, env, request);
    if (request.method === 'POST' && path === '/login')  return handleLogin(request, env);
    if (request.method === 'POST' && path === '/commit') return handleCommit(request, env);
    if (request.method === 'GET'  && path === '/get')    return handleGet(request, env);

    return json({ error: 'Not found', path }, { status: 404 }, env, request);
  }
};
