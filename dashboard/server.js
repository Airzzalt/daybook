'use strict';
const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));

const PORT = process.env.PORT || 10000;
const PASSWORD = process.env.DASH_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const TZ = 'Australia/Perth';

const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').split('?')[0],
  ssl: { rejectUnauthorized: false },
  max: 4,
  idleTimeoutMillis: 20000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 20000,
  query_timeout: 20000,
});
pool.on('error', (e) => console.error('pool error:', e.message));

/* ------------------------------------------------------------------ auth */
const SESSION_DAYS = 180;
function sign(exp) {
  return crypto.createHmac('sha256', SECRET).update(String(exp)).digest('base64url');
}
function makeToken() {
  const exp = Date.now() + 1000 * 60 * 60 * 24 * SESSION_DAYS;
  return exp + '.' + sign(exp);
}
function setSession(res) {
  res.setHeader('Set-Cookie',
    `sid=${makeToken()}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * SESSION_DAYS}`);
}

/* Password: a scrypt hash in the database once changed, otherwise the
   DASH_PASSWORD environment variable. */
function hashPw(pw, salt) {
  return new Promise((ok, no) =>
    crypto.scrypt(pw, salt, 64, (e, dk) => (e ? no(e) : ok(dk.toString('hex')))));
}
async function storedAuth() {
  try {
    const r = await pool.query(`SELECT value FROM dash_settings WHERE key='auth'`);
    return (r.rows[0] && r.rows[0].value) || null;
  } catch { return null; }
}
function sameSecret(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
async function checkPw(given) {
  const a = await storedAuth();
  if (a && a.hash && a.salt) return sameSecret(await hashPw(given, a.salt), a.hash);
  if (!PASSWORD) return false;
  return sameSecret(given, PASSWORD);
}
function validToken(tok) {
  if (!tok || typeof tok !== 'string') return false;
  const i = tok.indexOf('.');
  if (i < 0) return false;
  const exp = Number(tok.slice(0, i));
  const mac = tok.slice(i + 1);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const want = sign(exp);
  if (mac.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want));
}
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const j = part.indexOf('=');
    if (j < 0) continue;
    if (part.slice(0, j).trim() === name) return decodeURIComponent(part.slice(j + 1));
  }
  return null;
}
function authed(req) { return validToken(readCookie(req, 'sid')); }
function requireAuth(req, res, next) {
  if (!authed(req)) return res.status(401).json({ error: 'unauthorised' });
  setSession(res); // sliding expiry — using it keeps you signed in
  next();
}

const attempts = new Map();
function throttled(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a) return false;
  if (now - a.at > 15 * 60 * 1000) { attempts.delete(ip); return false; }
  return a.n >= 8;
}
function noteAttempt(ip, ok) {
  if (ok) { attempts.delete(ip); return; }
  const a = attempts.get(ip) || { n: 0, at: Date.now() };
  a.n += 1; a.at = Date.now();
  attempts.set(ip, a);
}

app.post('/api/login', async (req, res) => {
  const ip = req.ip || 'x';
  if (throttled(ip)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes.' });
  const given = String((req.body && req.body.password) || '');
  let ok = false;
  try { ok = await checkPw(given); } catch { ok = false; }
  noteAttempt(ip, ok);
  if (!ok) return res.status(401).json({ error: 'Wrong password.' });
  setSession(res);
  res.json({ ok: true });
});

app.post('/api/password', requireAuth, async (req, res) => {
  const cur = String((req.body && req.body.current) || '');
  const next = String((req.body && req.body.next) || '');
  if (next.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  let ok = false;
  try { ok = await checkPw(cur); } catch { ok = false; }
  if (!ok) return res.status(401).json({ error: 'Current password is wrong.' });
  try {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await hashPw(next, salt);
    await pool.query(
      `INSERT INTO dash_settings (key, value, updated_at) VALUES ('auth', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = now()`,
      [JSON.stringify({ hash, salt })]);
    setSession(res); // keep this device signed in
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: 'Could not save the new password.', message: e.message });
  }
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => {
  res.json({
    authed: authed(req),
    meta: Boolean(process.env.META_TOKEN && process.env.META_AD_ACCOUNT),
    stripe: Boolean(process.env.STRIPE_KEY),
  });
});

/* ----------------------------------------------------------------- dates */
const DATE = /^\d{4}-\d{2}-\d{2}$/;
function range(req) {
  const from = DATE.test(req.query.from) ? req.query.from : today();
  const to = DATE.test(req.query.to) ? req.query.to : today();
  return from <= to ? { from, to } : { from: to, to: from };
}
function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

/* ------------------------------------------------------------- neon data */
const LIVE = "COALESCE(status,'') NOT IN ('cancelled','refunded')";
const PERTH = (c) => `(${c}::timestamptz AT TIME ZONE 'Australia/Perth')`;

app.get('/api/summary', requireAuth, async (req, res) => {
  const { from, to } = range(req);
  try {
    const daily = await pool.query(
      `WITH o AS (
         SELECT id, revenue_aud, ${PERTH('created_at')}::date AS d
         FROM orders WHERE ${LIVE} AND ${PERTH('created_at')}::date BETWEEN $1::date AND $2::date
       ), i AS (
         SELECT o.d, o.id, MAX(o.revenue_aud) AS rev,
           COALESCE(SUM(oi.quantity) FILTER (WHERE p.product_type='fragrance' OR p.product_type IS NULL),0) AS bottles,
           COALESCE(SUM(oi.quantity) FILTER (WHERE p.product_type='miniature'),0) AS minis
         FROM o
         LEFT JOIN order_items oi ON oi.order_id = o.id
         LEFT JOIN products p ON p.id = oi.product_id
         GROUP BY o.d, o.id
       )
       SELECT d::text AS day, COUNT(*)::int AS orders,
              ROUND(SUM(rev)::numeric,2)::float8 AS revenue,
              SUM(bottles)::int AS bottles, SUM(minis)::int AS minis
       FROM i GROUP BY d ORDER BY d`, [from, to]);

    const utm = await pool.query(
      `SELECT COALESCE(NULLIF(utm_content,''),'(direct)') AS uc,
              COUNT(*)::int AS orders, ROUND(SUM(revenue_aud)::numeric,2)::float8 AS revenue
       FROM orders WHERE ${LIVE} AND ${PERTH('created_at')}::date BETWEEN $1::date AND $2::date
       GROUP BY 1 ORDER BY revenue DESC`, [from, to]);

    const carts = await pool.query(
      `SELECT
        (SELECT COUNT(*)::int FROM abandoned_carts WHERE ${PERTH('created_at')}::date BETWEEN $1::date AND $2::date) AS carts,
        (SELECT COUNT(*)::int FROM checkout_drafts WHERE ${PERTH('created_at')}::date BETWEEN $1::date AND $2::date) AS drafts,
        (SELECT COUNT(*)::int FROM payment_attempt_failures WHERE ${PERTH('created_at')}::date BETWEEN $1::date AND $2::date) AS fails`,
      [from, to]);

    const products = await pool.query(
      `SELECT p.name, p.product_type, SUM(oi.quantity)::int AS qty
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       JOIN products p ON p.id = oi.product_id
       WHERE COALESCE(o.status,'') NOT IN ('cancelled','refunded')
         AND ${PERTH('o.created_at')}::date BETWEEN $1::date AND $2::date
       GROUP BY 1,2 ORDER BY qty DESC LIMIT 15`, [from, to]);

    res.json({
      from, to, today: today(),
      daily: daily.rows, utm: utm.rows,
      carts: carts.rows[0] || null, products: products.rows,
    });
  } catch (e) {
    res.status(502).json({ error: 'database', message: e.message });
  }
});

/* ------------------------------------------------------------------ meta */
const ACT = {
  purchase: ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'],
  lpv: ['omni_landing_page_view', 'landing_page_view'],
  atc: ['omni_add_to_cart', 'add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart'],
  ic: ['omni_initiated_checkout', 'initiate_checkout', 'offsite_conversion.fb_pixel_initiate_checkout'],
};
function pick(list, names) {
  if (!Array.isArray(list)) return 0;
  for (const n of names) {
    const hit = list.find((a) => a.action_type === n);
    if (hit) return Number(hit.value) || 0;
  }
  return 0;
}

app.get('/api/meta', requireAuth, async (req, res) => {
  const token = process.env.META_TOKEN;
  const acct = process.env.META_AD_ACCOUNT;
  if (!token || !acct) return res.json({ available: false, reason: 'not_configured' });
  const { from, to } = range(req);
  const id = acct.startsWith('act_') ? acct : 'act_' + acct;
  const url = `https://graph.facebook.com/v21.0/${id}/insights?` + new URLSearchParams({
    level: 'ad',
    fields: 'ad_id,ad_name,adset_name,spend,impressions,clicks,ctr,cpm,actions,action_values,cost_per_action_type',
    time_range: JSON.stringify({ since: from, until: to }),
    limit: '300',
    access_token: token,
  });
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
    const j = await r.json();
    if (j.error) {
      return res.json({ available: false, reason: 'api_error', message: j.error.message || 'Meta rejected the request' });
    }
    const ads = (j.data || []).map((d) => ({
      id: d.ad_id,
      name: d.ad_name,
      adset: d.adset_name,
      spend: Number(d.spend) || 0,
      impressions: Number(d.impressions) || 0,
      clicks: Number(d.clicks) || 0,
      ctr: Number(d.ctr) || 0,
      cpm: Number(d.cpm) || 0,
      purchases: pick(d.actions, ACT.purchase),
      lpv: pick(d.actions, ACT.lpv),
      atc: pick(d.actions, ACT.atc),
      ic: pick(d.actions, ACT.ic),
      revenue: pick(d.action_values, ACT.purchase),
    })).filter((a) => a.spend > 0);
    res.json({ available: true, ads });
  } catch (e) {
    res.json({ available: false, reason: 'unreachable', message: e.message });
  }
});

/* ------------------------------------------------------- ad spend by day */
app.get('/api/adspend', requireAuth, async (req, res) => {
  const token = process.env.META_TOKEN;
  const acct = process.env.META_AD_ACCOUNT;
  if (!token || !acct) return res.json({ available: false, reason: 'not_configured' });
  const { from, to } = range(req);
  const id = acct.startsWith('act_') ? acct : 'act_' + acct;
  const url = `https://graph.facebook.com/v21.0/${id}/insights?` + new URLSearchParams({
    level: 'account',
    fields: 'spend',
    time_range: JSON.stringify({ since: from, until: to }),
    time_increment: '1',
    limit: '200',
    access_token: token,
  });
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
    const j = await r.json();
    if (j.error) return res.json({ available: false, reason: 'api_error', message: j.error.message });
    const days = {};
    (j.data || []).forEach((d) => { if (d.date_start) days[d.date_start] = Number(d.spend) || 0; });
    res.json({ available: true, days });
  } catch (e) {
    res.json({ available: false, reason: 'unreachable', message: e.message });
  }
});

/* ---------------------------------------------------------------- stripe */
app.get('/api/stripe', requireAuth, async (req, res) => {
  const key = process.env.STRIPE_KEY;
  if (!key) return res.json({ available: false, reason: 'not_configured' });
  try {
    const r = await fetch('https://api.stripe.com/v1/payouts?limit=8', {
      headers: { Authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json();
    if (j.error) return res.json({ available: false, reason: 'api_error', message: j.error.message });
    res.json({
      available: true,
      payouts: (j.data || []).map((p) => ({ arrival: p.arrival_date, amount: p.amount / 100, status: p.status })),
    });
  } catch (e) {
    res.json({ available: false, reason: 'unreachable', message: e.message });
  }
});

/* -------------------------------------------------------------- settings */
app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT value FROM dash_settings WHERE key='dashboard'`);
    res.json((r.rows[0] && r.rows[0].value) || {});
  } catch (e) { res.status(502).json({ error: 'database', message: e.message }); }
});
app.put('/api/settings', requireAuth, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const clean = {};
  for (const k of ['carBalance', 'manualAdSpend', 'stockUnits']) {
    if (body[k] != null && Number.isFinite(Number(body[k]))) clean[k] = Number(body[k]);
  }
  // Per-day actual supplier invoices and manual adjustments, keyed by trading date.
  for (const k of ['supplierActual', 'adjust']) {
    if (body[k] && typeof body[k] === 'object' && !Array.isArray(body[k])) {
      const map = {};
      for (const [d, v] of Object.entries(body[k]).slice(0, 400)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Number(v))) map[d] = Number(v);
      }
      if (Object.keys(map).length) clean[k] = map;
    }
  }
  try {
    const r = await pool.query(
      `INSERT INTO dash_settings (key, value, updated_at) VALUES ('dashboard', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = dash_settings.value || $1::jsonb, updated_at = now()
       RETURNING value`, [JSON.stringify(clean)]);
    res.json(r.rows[0].value);
  } catch (e) { res.status(502).json({ error: 'database', message: e.message }); }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use(express.static(__dirname + '/public', {
  setHeaders(res, path) {
    if (path.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
  },
}));
app.get('*', (_req, res) => res.sendFile(__dirname + '/public/index.html'));

app.listen(PORT, () => console.log('listening on ' + PORT));

