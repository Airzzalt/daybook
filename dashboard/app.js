(function () {
  'use strict';

  /* The same figures the live dashboard has always used. */
  var TZ = 'Australia/Perth';
  var K = { cogsBottle: 37.50, cogsMini: 9.80, fee: 0.051, gstFrom: '2026-08-18', breakeven: 132, carTarget: 35000, shutStart: '2026-09-25', shutEnd: '2026-10-08' };
  var ALLOC_DEFAULT = { switchDate: '2026-09-08', before: { car: 45, stock: 20 }, after: { car: 65, stock: 0 } };
  var D = { loaded: false, first: null, hourly: null, summary: null, meta: null, stripe: null, adspend: null, settings: {}, wide: {}, err: {} };
  var S = { preset: 'today', from: '', to: '', view: 'overview', metric: 'rev', gran: 'hour', larp: false };
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var busy = false, again = false, timer = null, seeded = false;

  /* ---------- helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function num(v) { var x = Number(v); return isFinite(x) ? x : 0; }
  function money(v, d) { d = d || 0; return '$' + (v < 0 ? '-' : '') + Math.abs(v).toLocaleString('en-AU', { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function pct(v) { return (isFinite(v) ? v.toFixed(1) : '0.0') + '%'; }
  function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  function clock() { return new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()); }
  function nowFrac() {
    var p = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date()), h = 0, m = 0;
    p.forEach(function (x) { if (x.type === 'hour') h = parseInt(x.value, 10) % 24; if (x.type === 'minute') m = parseInt(x.value, 10); });
    return (h + m / 60) / 24;
  }
  function shift(iso, d) { var x = new Date(iso + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); }
  function span(a, b) { return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5) + 1; }
  function md(iso) { var d = new Date(iso + 'T12:00:00Z'); return d.getUTCDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]; }
  function dw(iso) { return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(iso + 'T12:00:00Z').getUTCDay()]; }
  function tap() { try { if (navigator.vibrate) navigator.vibrate(8); } catch (e) {} }

  /* ---------- session + data ---------- */
  function api(path, opts) {
    return fetch(path, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, opts || {}))
      .then(function (r) {
        if (r.status === 401) { showGate(); throw { code: 'auth' }; }
        return r.json().then(function (j) { if (!r.ok) throw j; return j; });
      });
  }
  function showGate() { $('gate').hidden = false; $('app').hidden = true; }
  function showApp() { $('gate').hidden = true; $('app').hidden = false; }

  function allocCfg() { var a = D.settings && D.settings.alloc; return (a && a.switchDate && a.before && a.after) ? a : ALLOC_DEFAULT; }
  function supplierMap() { return (D.settings && D.settings.supplierActual) || {}; }
  function stockUnits() { return D.settings && D.settings.stockUnits != null ? num(D.settings.stockUnits) : 400; }
  function daySpend(iso) {
    if (D.adspend && D.adspend.available && D.adspend.days) return D.adspend.days[iso] != null ? num(D.adspend.days[iso]) : 0;
    var m = D.settings && D.settings.manualAdSpend;
    return m != null ? num(m) : null;
  }
  /* One row for every calendar day, zero-filled, because the database only returns days that had orders. */
  function windowRows(f, t) {
    var out = [], d = f, guard = 0;
    while (d <= t && guard++ < 4000) {
      var w = D.wide[d] || {}, sp = daySpend(d);
      out.push({ day: d, orders: num(w.orders), revenue: num(w.revenue), bottles: num(w.bottles), minis: num(w.minis), ad: sp == null ? 0 : sp, adKnown: sp != null });
      d = shift(d, 1);
    }
    return out;
  }
  function wideFrom() {
    var n = span(S.from, S.to), f = shift(S.from, -n), t28 = shift(S.to, -27);
    if (t28 < f) f = t28;
    var asOf = D.settings && D.settings.carBalanceAsOf;
    if (asOf && shift(asOf, -6) < f) f = shift(asOf, -6);
    var lim = shift(today(), -400); if (S.preset !== 'all' && f < lim) f = lim;
    return f;
  }
  function load() {
    if (busy) { again = true; return; }
    busy = true; var rb = $('refresh'); if (rb) rb.classList.add('spin');
    function finish() { busy = false; if (rb) rb.classList.remove('spin'); if (again) { again = false; load(); } }
    var pre = S.preset === 'all' && !D.first ? api('/api/first').then(function (f) { D.first = f && f.first; setRange('all'); }).catch(function () {}) : Promise.resolve();
    pre.then(function () { return api('/api/settings'); }).catch(function (e) { if (e && e.code === 'auth') throw e; return {}; })
      .then(function (st) {
        D.settings = st || {};
        var W = wideFrom(), WT = S.to > today() ? S.to : today(), q = '?from=' + S.from + '&to=' + S.to;
        return Promise.allSettled([api('/api/summary' + q), api('/api/meta' + q), api('/api/stripe'), api('/api/summary?from=' + W + '&to=' + WT), api('/api/adspend?from=' + W + '&to=' + WT), S.from === S.to ? api('/api/hourly?day=' + S.to) : Promise.resolve(null)]);
      })
      .then(function (r) {
        D.loaded = true;
        D.summary = r[0].status === 'fulfilled' ? r[0].value : null; D.err.summary = r[0].reason;
        D.meta = r[1].status === 'fulfilled' ? r[1].value : null;
        D.stripe = r[2].status === 'fulfilled' ? r[2].value : null;
        D.adspend = r[4].status === 'fulfilled' ? r[4].value : null;
        D.hourly = r[5] && r[5].status === 'fulfilled' ? r[5].value : null;
        D.wide = {};
        if (D.summary) D.summary.daily.forEach(function (x) { D.wide[x.day] = x; });
        if (r[3].status === 'fulfilled') r[3].value.daily.forEach(function (x) { D.wide[x.day] = x; });
        render(); seedFund(); finish();
      })
      .catch(function () { finish(); });
  }
  /* The first time the dashboard sees a saved balance with no date, it stamps today on it, so the fund starts growing from here. */
  function seedFund() {
    var s = D.settings || {};
    if (seeded || s.carBalance == null || s.carBalanceAsOf) return;
    seeded = true;
    api('/api/settings', { method: 'PUT', body: JSON.stringify({ carBalance: num(s.carBalance), carBalanceAsOf: today() }) })
      .then(function (v) { if (v && v.carBalanceAsOf) { D.settings = v; render(false); } }).catch(function () {});
  }

  /* ---------- the maths (same as the live dashboard) ---------- */
  function allocFor(day) { var a = allocCfg(), s = day >= a.switchDate ? a.after : a.before; return { car: num(s.car) / 100, stock: num(s.stock) / 100 }; }
  function crunch(rows) {
    var t = { orders: 0, revenue: 0, bottles: 0, minis: 0, gst: 0, cogs: 0, fees: 0, ad: 0, adKnown: true, days: rows.length };
    rows.forEach(function (r) {
      var gst = r.day >= K.gstFrom ? r.revenue / 11 : 0, cogs = r.bottles * K.cogsBottle + r.minis * K.cogsMini, fees = r.revenue * K.fee;
      t.orders += r.orders; t.revenue += r.revenue; t.bottles += r.bottles; t.minis += r.minis; t.gst += gst; t.cogs += cogs; t.fees += fees; t.ad += r.ad; if (r.adKnown === false) t.adKnown = false;
            r._c = r.revenue - gst - cogs - fees; r._gst = gst; r._cogs = cogs; r._net = r._c - r.ad;
      var a = allocFor(r.day); r._car = a.car; r._st = a.stock;
    });
    t.contrib = t.revenue - t.gst - t.cogs - t.fees; t.net = t.contrib - t.ad;
    t.aov = t.orders ? t.revenue / t.orders : 0; t.cpa = t.orders ? t.ad / t.orders : 0; t.roas = t.ad ? t.revenue / t.ad : 0;
    t.daily = rows; return t;
  }
  function ctx() {
    var n = span(S.from, S.to), pf = shift(S.from, -n), pt = shift(S.from, -1);
    return { t: crunch(windowRows(S.from, S.to)), p: crunch(windowRows(pf, pt)), pf: pf, pt: pt };
  }
  function rangeLabel() { return (S.from === S.to ? dw(S.from) + ' ' + md(S.from) : md(S.from) + ' – ' + md(S.to) + ' · ' + span(S.from, S.to) + ' days') + ' · synced ' + clock() + ' Perth'; }

  /* ---------- charts ---------- */
  var HW = [.2, .1, .06, .04, .04, .08, .2, .5, .9, 1.1, 1.2, 1.1, 1, .95, .9, .9, 1, 1.1, 1.3, 1.5, 1.4, 1.1, .7, .4];
  function hourly(total, count) { var w = HW.slice(0, count), t = w.reduce(function (a, b) { return a + b; }, 0); return w.map(function (x) { return total * x / t; }); }
  function hlabel(h) { return h === 0 ? '12am' : h < 12 ? h + 'am' : h === 12 ? '12pm' : (h - 12) + 'pm'; }
  function sum(a) { return a.reduce(function (x, y) { return x + y; }, 0); }
  var KINDS = {
    rev: { label: 'Revenue', color: 'var(--blue)', fmt: 'm0', val: function (r) { return r.revenue; }, tot: function (t) { return t.revenue; } },
    ad: { label: 'Ad spend', color: 'var(--violet)', fmt: 'm0', neutral: true, val: function (r) { return r.ad; }, tot: function (t) { return t.ad; } },
    net: { label: 'Net profit', color: 'var(--green)', fmt: 'm0', val: function (r) { return r._net; }, tot: function (t) { return t.net; } },
    orders: { label: 'Orders', color: 'var(--blue)', fmt: 'i', val: function (r) { return r.orders; }, tot: function (t) { return t.orders; } },
    bottles: { label: 'Bottles', color: 'var(--amber)', fmt: 'i', val: function (r) { return r.bottles; }, tot: function (t) { return t.bottles; } },
    cpa: { label: 'Cost per order', color: '#ff8a5b', fmt: 'm2', neutral: true, rate: true, val: function (r) { return r.orders ? r.ad / r.orders : 0; }, tot: function (t) { return t.cpa; } },
    roas: { label: 'Return on spend', color: 'var(--green)', fmt: 'x', rate: true, val: function (r) { return r.ad ? r.revenue / r.ad : 0; }, tot: function (t) { return t.roas; } }
  };
  var ORDER = ['rev', 'ad', 'net', 'orders', 'bottles', 'cpa', 'roas'];
  var CUR = null;
  function fmtVal(f, v) { return f === 'm2' ? money(v, 2) : f === 'i' ? String(Math.round(v)) : f === 'x' ? v.toFixed(2) + 'x' : money(v); }
  /* One day by the hour: running total so far against the day before. Ad-based figures need Meta's hourly spend. */
  function hourSeries(kind, c) {
    var H = D.hourly; if (!H || !H.rows) return null;
    var k = KINDS[kind], ah = H.adspend && H.adspend.available ? H.adspend.hours : null;
    if ({ ad: 1, net: 1, cpa: 1, roas: 1 }[kind] && !ah) return null;
    var day = S.to, prevDay = shift(day, -1), last = day === today() ? Math.min(23, Math.floor(nowFrac() * 24 + 1e-6)) : 23;
    function build(date, upto) {
      var by = {}, out = [], cum = { orders: 0, revenue: 0, bottles: 0, minis: 0, ad: 0 };
      H.rows.forEach(function (r) { if (r.day === date) by[r.h] = r; });
      for (var h = 0; h <= upto; h++) {
        var r = by[h] || {};
        cum = { orders: cum.orders + num(r.orders), revenue: cum.revenue + num(r.revenue), bottles: cum.bottles + num(r.bottles), minis: cum.minis + num(r.minis), ad: cum.ad + (ah && ah[date] ? num(ah[date][h]) : 0) };
        out.push({ day: date, orders: cum.orders, revenue: cum.revenue, bottles: cum.bottles, minis: cum.minis, ad: cum.ad, adKnown: true });
      }
      crunch(out); return out;
    }
    var v = build(day, last).map(k.val), pv = build(prevDay, 23).map(k.val);
    return { v: v, pv: pv, labels: pv.map(function (_, h) { return hlabel(h); }), hourly: true, cur: v[v.length - 1], prev: pv[v.length - 1] };
  }
  function bucketRows(rows, size) {
    var out = [];
    var off = rows.length % size; /* full groups counted back from today, so the newest point is never a part-week; the few oldest leftover days are left off the line only */
    for (var i = off; i < rows.length; i += size) {
      var ch = rows.slice(i, i + size), g = { day: ch[0].day, orders: 0, revenue: 0, bottles: 0, minis: 0, ad: 0, _net: 0 };
      ch.forEach(function (r) { g.orders += r.orders; g.revenue += r.revenue; g.bottles += r.bottles; g.minis += r.minis; g.ad += r.ad; g._net += r._net || 0; });
      out.push(g);
    }
    return out;
  }
  function series(kind, c) {
    var k = KINDS[kind], rows = c.t.daily, prow = c.p.daily, s = {};
    var hs = rows.length === 1 && S.gran === 'hour' ? hourSeries(kind, c) : null;
    if (hs) return hs;
    if (rows.length === 1) { /* one day has no shape, so show the last 14 days against the 14 before */
      var a = windowRows(shift(S.to, -13), S.to), b = windowRows(shift(S.to, -27), shift(S.to, -14));
      crunch(a); crunch(b);
      s.v = a.map(k.val); s.pv = b.map(k.val); s.labels = a.map(function (r) { return md(r.day); }); s.trail = true;
    } else {
      var size = rows.length > 400 ? 30 : rows.length > 90 ? 7 : 1;
      if (size > 1) { /* long ranges: one point per week (or per month) so the line stays readable */
        var rb = bucketRows(rows, size), pb = bucketRows(prow, size), MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        s.v = rb.map(k.val); s.pv = pb.map(k.val);
        s.labels = rb.map(function (r) { return size === 30 ? MON[Number(r.day.slice(5, 7)) - 1] + ' ' + r.day.slice(2, 4) : md(r.day); });
      } else {
        s.v = rows.map(k.val); s.pv = prow.map(k.val); s.labels = rows.map(function (r) { return md(r.day); });
      }
    }
    if (!s.pv.some(function (x) { return x; })) s.pv = [];
    s.cur = k.rate ? k.tot(c.t) : sum(rows.map(k.val)); s.prev = k.rate ? k.tot(c.p) : sum(prow.map(k.val));
    return s;
  }
  function nice(x) { var e = Math.pow(10, Math.floor(Math.log(x) / Math.LN10)), f = x / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e; }
  function ylab(v) { var a = Math.abs(v); if (a >= 1000) { var k = a / 1000; return (v < 0 ? '-' : '') + '$' + (k % 1 ? k.toFixed(1) : k) + 'K'; } return (v < 0 ? '-' : '') + '$' + Math.round(a); }
  function axisLab(f, v) {
    if (f === 'x') return v.toFixed(1) + 'x';
    if (f === 'i') return Math.abs(v) >= 1000 ? (v / 1000) + 'K' : String(Math.round(v));
    return ylab(v);
  }
  function mono(p) { /* smooth curve that never overshoots */
    var n = p.length; if (n < 2) return '';
    var dx = [], m = [], t = [], i;
    for (i = 0; i < n - 1; i++) { dx[i] = p[i + 1][0] - p[i][0]; m[i] = (p[i + 1][1] - p[i][1]) / dx[i]; }
    t[0] = m[0]; t[n - 1] = m[n - 2];
    for (i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : 3 * (dx[i - 1] + dx[i]) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]);
    var d = 'M' + p[0][0].toFixed(1) + ',' + p[0][1].toFixed(1);
    for (i = 0; i < n - 1; i++) { var h = dx[i] / 3; d += 'C' + (p[i][0] + h).toFixed(1) + ',' + (p[i][1] + t[i] * h).toFixed(1) + ' ' + (p[i + 1][0] - h).toFixed(1) + ',' + (p[i + 1][1] - t[i + 1] * h).toFixed(1) + ' ' + p[i + 1][0].toFixed(1) + ',' + p[i + 1][1].toFixed(1); }
    return d;
  }
  var CH = {};
  function chartSvg(id, s, f, W, H) {
    var L = W < 500 ? 42 : 50, R = 12, T = 12, B = 28, iw = W - L - R, ih = H - T - B, n = Math.max(s.v.length, s.pv.length, 2);
    var all = s.v.concat(s.pv), hi = Math.max.apply(null, all.concat([0])), lo = Math.min.apply(null, all.concat([0]));
    var step = nice((hi - lo) / 4 || 1); if (f === 'i') step = Math.max(1, Math.round(step));
    hi = Math.ceil(hi / step) * step; lo = Math.floor(lo / step) * step;
    function X(i) { return L + iw * i / (n - 1); }
    function Y(v) { return T + ih - ih * (v - lo) / (hi - lo || 1); }
    var g = '', v;
    for (v = lo; v <= hi + step / 1000; v += step) {
      g += '<line class="gl" x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(v).toFixed(1) + '" y2="' + Y(v).toFixed(1) + '"/><text class="yl" x="' + (L - 8) + '" y="' + (Y(v) + 4).toFixed(1) + '" text-anchor="end">' + axisLab(f, v) + '</text>';
    }
    var every = Math.ceil(n / (W < 500 ? 4 : 7)), xl = '';
    for (var i = 0; i < n; i += every) xl += '<text class="xl" x="' + X(i).toFixed(1) + '" y="' + (H - 7) + '" text-anchor="' + (i === 0 ? 'start' : 'middle') + '">' + esc(s.labels[i] || '') + '</text>';
    var mp = s.v.map(function (y, i) { return [X(i), Y(y)]; }), pp = s.pv.map(function (y, i) { return [X(i), Y(y)]; });
    var line = mono(mp), area = line ? line + 'L' + mp[mp.length - 1][0].toFixed(1) + ',' + Y(lo).toFixed(1) + 'L' + mp[0][0].toFixed(1) + ',' + Y(lo).toFixed(1) + 'Z' : '';
    CH[id] = { s: s, f: f, W: W, H: H, L: L, iw: iw, n: n, X: X, Y: Y };
    return '<div class="cw" data-ch="' + id + '"><svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Chart">' +
      '<defs><linearGradient id="g-' + id + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--c)" stop-opacity=".38"/><stop offset="1" style="stop-color:var(--c)" stop-opacity="0"/></linearGradient></defs>' +
      g + xl +
      (area ? '<path class="area" d="' + area + '" fill="url(#g-' + id + ')"/>' : '') +
      (pp.length > 1 ? '<path class="ln-prev" d="' + mono(pp) + '"/>' : '') +
      (line ? '<path class="ln-main" pathLength="1" d="' + line + '"/>' : '') +
      '<line class="xh" y1="' + T + '" y2="' + (T + ih) + '" x1="0" x2="0"/><circle class="dot" r="4.5" cx="0" cy="0"/>' +
      '<rect class="hit" x="' + L + '" y="' + T + '" width="' + iw + '" height="' + ih + '" fill="transparent"/></svg><div class="tip"></div></div>';
  }
  function bindCharts(root) {
    Array.prototype.forEach.call(root.querySelectorAll('.cw'), function (cw) {
      var d = CH[cw.dataset.ch]; if (!d) return;
      var svg = cw.querySelector('svg'), xh = cw.querySelector('.xh'), dot = cw.querySelector('.dot'), tip = cw.querySelector('.tip');
      function fmt(v) { return d.f === 'm0' && Math.abs(v) < 100 ? money(v, 2) : fmtVal(d.f, v); }
      function move(e) {
        var r = svg.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * d.W;
        var i = Math.max(0, Math.min(d.n - 1, Math.round((x - d.L) / d.iw * (d.n - 1))));
        var has = i < d.s.v.length, px = d.X(i);
        xh.setAttribute('x1', px); xh.setAttribute('x2', px);
        dot.setAttribute('cx', px); dot.setAttribute('cy', has ? d.Y(d.s.v[i]) : -20); dot.style.opacity = has ? '' : 0;
        tip.innerHTML = '<em>' + esc(d.s.labels[i] || '') + '</em>' + (has ? '<b>' + fmt(d.s.v[i]) + '</b>' : '') + (d.s.pv[i] != null ? '<em>Before · ' + fmt(d.s.pv[i]) + '</em>' : '');
        var fr = px / d.W; tip.style.left = (fr * 100) + '%'; tip.style.transform = 'translateX(' + (fr > .68 ? '-105%' : fr < .3 ? '8%' : '-50%') + ')';
        cw.classList.add('on');
      }
      cw.addEventListener('pointermove', move); cw.addEventListener('pointerdown', move);
      cw.addEventListener('pointerleave', function () { cw.classList.remove('on'); });
    });
  }
  var UP = '<svg viewBox="0 0 12 12" fill="none"><path d="M3 9 9 3M4.5 3H9v4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function chip(cur, prev, neutral) {
    if (!prev) return '';
    var d = (cur - prev) / Math.abs(prev) * 100, cls = neutral ? 'nu' : d >= 0 ? '' : 'dn';
    return '<span class="chip ' + cls + '">' + UP + Math.abs(d).toFixed(0) + '%</span>';
  }
  var LEG_MAIN = '<svg viewBox="0 0 22 6"><line x1="1" x2="21" y1="3" y2="3" stroke="var(--c)" stroke-width="2.6" stroke-linecap="round"/></svg>';
  var LEG_PREV = '<svg viewBox="0 0 22 6"><line x1="1" x2="21" y1="3" y2="3" stroke="var(--c)" stroke-opacity=".5" stroke-width="2.6" stroke-linecap="round" stroke-dasharray=".1 6"/></svg>';
  function rangeShort(d) { return dw(d) + ' ' + md(d); }
  function spark(v) {
    if (!v || v.length < 2) return '';
    var n = Math.min(v.length, 16), a = [], i;
    for (i = 0; i < n; i++) a.push(v[Math.round(i * (v.length - 1) / (n - 1))]);
    var lo = Math.min.apply(null, a), hi = Math.max.apply(null, a), rg = (hi - lo) || 1;
    var p = a.map(function (y, i) { return [1 + i * 26 / (n - 1), 13 - (y - lo) / rg * 11]; });
    return '<svg class="spk" viewBox="0 0 28 14" aria-hidden="true"><path d="' + mono(p) + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  function heroHtml(kind) {
    var c = CUR, k = KINDS[kind], s = series(kind, c);
    var W = Math.max(300, Math.min(1040, V.clientWidth || (window.innerWidth - 20))), H = W < 500 ? 250 : Math.max(280, Math.min(340, Math.round(W * .3)));
    var single = c.t.daily.length === 1 && !s.trail;
    var l1 = s.trail ? 'Last 14 days' : single ? rangeShort(S.from) : S.preset === 'all' ? 'All time' : md(S.from) + '–' + md(S.to);
    var l2 = s.trail ? '14 days before' : single ? rangeShort(c.pf) : md(c.pf) + '–' + md(c.pt);
    return '<div class="hl"><span class="ttl">' + k.label + '</span>' + chip(s.cur, s.prev, k.neutral) + '<span class="dim hlv">vs the period before</span></div>' +
      chartSvg('hero', s, k.fmt, W, H) + '<div class="legend"><span>' + LEG_MAIN + l1 + '</span>' + (s.pv.length ? '<span>' + LEG_PREV + l2 + '</span>' : '') + '</div>' +
      (c.t.daily.length === 1 && D.hourly ? '<div class="gran" role="group" aria-label="Graph by"><button data-gran="hour" aria-pressed="' + (S.gran === 'hour') + '">By hour</button><button data-gran="days" aria-pressed="' + (S.gran !== 'hour') + '">14 days</button></div>' : '');
  }
  function drawHero() {
    var h = $('hero'); if (!h || !CUR) return;
    h.style.setProperty('--c', KINDS[S.metric].color); h.classList.add('redraw'); h.innerHTML = heroHtml(S.metric); bindCharts(h);
  }

  /* ---------- count-up numbers ---------- */
  var FM = { m0: function (v) { return money(v); }, m2: function (v) { return money(v, 2); }, i: function (v) { return String(Math.round(v)); }, x: function (v) { return v.toFixed(2) + 'x'; } };
  function countUp(root) {
    if (reduce) return;
    Array.prototype.forEach.call(root.querySelectorAll('[data-count]'), function (el) {
      var to = Number(el.dataset.count), f = FM[el.dataset.fmt] || FM.m0, t0 = performance.now();
      (function step(t) { var p = Math.min(1, (t - t0) / 750), e = 1 - Math.pow(1 - p, 4); el.textContent = f(to * e); if (p < 1) requestAnimationFrame(step); else el.textContent = f(to); })(t0);
    });
  }

  /* ---------- pages ---------- */
  var IC = {
    alloc: '<svg viewBox="0 0 20 20" fill="none"><path d="M10 3v13M10 3 5.5 7.5M10 3l4.5 4.5M3.5 17h13" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    ads: '<svg viewBox="0 0 20 20" fill="none"><path d="M3 8h3.5L13 4v12l-6.5-4H3z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M16 7a4 4 0 0 1 0 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    money: '<svg viewBox="0 0 20 20" fill="none"><rect x="2.5" y="5" width="15" height="10.5" rx="2.6" stroke="currentColor" stroke-width="1.7"/><circle cx="10" cy="10.25" r="2.2" stroke="currentColor" stroke-width="1.7"/></svg>',
    stock: '<svg viewBox="0 0 20 20" fill="none"><path d="M3 6.5 10 3l7 3.5v7L10 17l-7-3.5z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="m3 6.5 7 3.5m0 0 7-3.5M10 10v7" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>'
  };
  var ICON_CAL = '<svg viewBox="0 0 20 20" fill="none"><rect x="3" y="4.5" width="14" height="12" rx="3" stroke="currentColor" stroke-width="1.6"/><path d="M3 8.5h14M7 3v3M13 3v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  var ICON_REPORT = '<svg viewBox="0 0 20 20" fill="none"><rect x="3" y="3" width="14" height="14" rx="3" stroke="currentColor" stroke-width="1.6"/><path d="M7 13v-3M10 13V7M13 13v-2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  var CHEV = '<svg class="chev" viewBox="0 0 16 16" fill="none"><path d="m6 3 5 5-5 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function rangeText() { return { today: 'Today', yday: 'Yesterday', '7': '7 days', '14': '14 days', '30': '30 days', mtd: 'This month', lastmo: 'Last month', all: 'All time' }[S.preset] || (md(S.from) + ' – ' + md(S.to)); }
  function rangePill() { return '<button class="pillbtn" data-act="range">' + ICON_CAL + '<span>' + esc(rangeText()) + '</span></button>'; }
  function greet() { var h = Math.floor(nowFrac() * 24); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }
  function head(title, extra) { return '<div class="phead rise"><h1>' + esc(title) + '</h1><span class="meta">' + esc(rangeLabel()) + '</span>' + (title === 'Settings' ? '' : rangePill()) + (extra || '') + '</div>'; }

  function arow(go, title, sub, val, cls) {
    var inner = '<span class="ai">' + IC[go] + '</span><span class="at"><b>' + title + '</b><em>' + sub + '</em></span><span class="av ' + (cls || '') + '">' + val + '</span>';
    return S.larp ? '<div class="arow static">' + inner + '</div>' : '<button class="arow" data-go="' + go + '">' + inner + CHEV + '</button>';
  }
  function fundNow() {
    var s = D.settings || {}, base = num(s.carBalance), asOf = s.carBalanceAsOf || null, add = 0, t = today();
    if (asOf) {
      groupPayouts(windowRows(shift(asOf, -6), t)).forEach(function (g) { if (g.pay > asOf && g.pay <= t) add += Math.max(0, allocData(g).car); });
    }
    return { bal: base + add, base: base, added: add, asOf: asOf };
  }
  function nextPayout() {
    var sp = D.stripe && D.stripe.available ? D.stripe.payouts.filter(function (p) { return p.status !== 'paid' && p.status !== 'canceled' && p.status !== 'failed'; }) : [];
    if (sp.length) {
      var p = sp.slice().sort(function (a, b) { return a.arrival - b.arrival; })[0];
      var d = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(p.arrival * 1000));
      return { day: d, amount: p.amount, note: 'from Stripe' };
    }
    var t = today(), pays = groupPayouts(windowRows(shift(t, -6), t)), g = pays.filter(function (x) { return x.pay >= t; }).pop() || pays[0];
    return g ? { day: g.pay, amount: g.revenue * (1 - K.fee), note: g.orders + ' orders · estimate' } : null;
  }
  function activityRows(c) {
    var f = fundNow(), np = nextPayout(), h = '<div class="alist">';
    if (np) h += arow('alloc', 'Next payout', dw(np.day) + ' ' + md(np.day) + ' · ' + np.note, money(np.amount, 2));
    h += arow('money', 'Personal fund', (f.asOf && f.added > 0 ? '+' + money(f.added) + ' since ' + md(f.asOf) + ' · ' : '') + pct(f.bal / K.carTarget * 100) + ' of ' + money(K.carTarget), money(f.bal));
    h += arow('money', 'GST fund', 'set aside for tax · ' + md(S.from) + (S.from === S.to ? '' : '–' + md(S.to)), money(c.t.gst));
    h += arow('ads', 'Cost per order', c.t.adKnown ? 'breakeven ' + money(K.breakeven) : 'ad spend not connected', c.t.adKnown && c.t.orders ? money(c.t.cpa, 2) : '—', c.t.adKnown && c.t.orders ? (c.t.cpa < K.breakeven ? 'ok' : 'bad') : '');
    return h + '</div>';
  }
  function payoutsCard() {
    var rows = '', note = 'newest first';
    if (D.stripe && D.stripe.available && D.stripe.payouts.length) {
      var P = { paid: ['Paid', 'ok'], in_transit: ['On the way', ''], pending: ['Pending', ''], failed: ['Failed', 'bad'], canceled: ['Cancelled', 'bad'] };
      rows = D.stripe.payouts.slice().sort(function (a, b) { return b.arrival - a.arrival; }).map(function (p) {
        var d = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(p.arrival * 1000)), st = P[p.status] || [p.status, ''];
        return '<div class="prow"><span class="pd"><b>' + esc(d) + '</b><em>Stripe payout</em></span><span class="pst ' + st[1] + '">' + esc(st[0]) + '</span><span class="av">' + money(p.amount, 2) + '</span></div>';
      }).join('');
    } else {
      var t = today(); note = 'estimated from sales';
      rows = groupPayouts(windowRows(shift(t, -9), t)).slice(0, 6).map(function (p) {
        var landed = p.pay <= t;
        return '<div class="prow"><span class="pd"><b>' + dw(p.pay) + ' ' + md(p.pay) + '</b><em>' + p.orders + ' orders</em></span><span class="pst ' + (landed ? 'ok' : '') + '">' + (landed ? 'Paid' : 'On the way') + '</span><span class="av">' + money(p.revenue * (1 - K.fee), 2) + '</span></div>';
      }).join('');
    }
    if (!rows) rows = '<div class="empty">No payouts yet.</div>';
    return '<section class="card" style="margin-top:14px"><h3>Stripe payouts<span class="r">' + note + '</span></h3><div class="plist2">' + rows + '</div></section>';
  }
  function vOverview() {
    var c = ctx(); CUR = c;
    var kinds = S.larp ? ['rev', 'ad', 'net'] : ORDER, adOnly = { ad: 1, net: 1, cpa: 1, roas: 1 };
    if (kinds.indexOf(S.metric) < 0) S.metric = 'rev';
    var tabs = kinds.map(function (id) {
      var k = KINDS[id], s = series(id, c), hide = adOnly[id] && !c.t.adKnown;
      return '<button data-m="' + id + '" aria-pressed="' + (id === S.metric) + '" style="--c:' + k.color + '"><small>' + k.label + '</small><span class="tv"><b' + (hide ? '' : ' data-count="' + s.cur + '" data-fmt="' + k.fmt + '"') + '>' + (hide ? '—' : fmtVal(k.fmt, s.cur)) + '</b>' + spark(s.v) + '</span></button>';
    }).join('');
    var h = '<section class="hero rise"><div class="mtabs" id="mtabs"><span class="thumb"></span>' + tabs + '</div>' +
      '<div class="herochart redraw" id="hero" style="--c:' + KINDS[S.metric].color + '">' + heroHtml(S.metric) + '</div>' +
      (c.t.adKnown ? '' : '<div class="note warn" style="margin-top:12px"><div><b>Ad spend is not connected.</b>Net profit and cost per order are overstated until Meta is connected or you enter a daily figure in Settings.</div></div>') +
      '<div class="pills">' + rangePill() + (S.larp ? '' : '<button class="pillbtn" data-act="report">' + ICON_REPORT + 'View report</button>') + '</div></section>';
    var sheet = '<section class="sheet rise" style="--i:2"><h2>' + greet() + '! Here\'s your activity</h2>' + activityRows(c) + payoutsCard();
    if (S.larp) return h + sheet + '</section>';
    return h + sheet + '<div class="duo" style="margin-top:14px">' + funnelCard(c.t) + productsCard() + '</div><div class="stack">' + dailyCard(c.t) + '</div></section>';
  }
  function dailyCard(t) {
    var h = '<section class="card flush rise" id="report" style="--i:9"><h3>Daily trade<span class="r">' + (t.daily.length > 1 ? bestLine(t) : '') + '</span></h3><div class="scroll" style="margin-top:12px"><table><thead><tr><th>Day</th><th>Orders</th><th>Revenue</th><th class="hm">Avg order</th><th>Bottles</th><th class="hm">Mini</th><th class="hm">GST</th><th class="hm">Cost</th><th>Contribution</th></tr></thead><tbody>';
    t.daily.slice().reverse().forEach(function (r) {
      h += '<tr><td>' + dw(r.day) + ' ' + md(r.day) + '</td><td>' + r.orders + '</td><td>' + money(r.revenue) + '</td><td class="hm">' + money(r.orders ? r.revenue / r.orders : 0) + '</td><td>' + r.bottles + '</td><td class="dim hm">' + r.minis + '</td><td class="dim hm">' + money(r._gst) + '</td><td class="dim hm">' + money(r._cogs) + '</td><td><b>' + money(r._c) + '</b></td></tr>';
    });
    return h + '</tbody><tfoot><tr><td>' + t.daily.length + (t.daily.length === 1 ? ' day' : ' days') + '</td><td>' + t.orders + '</td><td>' + money(t.revenue) + '</td><td class="hm">' + money(t.aov) + '</td><td>' + t.bottles + '</td><td class="hm">' + t.minis + '</td><td class="hm">' + money(t.gst) + '</td><td class="hm">' + money(t.cogs) + '</td><td>' + money(t.contrib) + '</td></tr></tfoot></table></div></section>';
  }
  function bestLine(t) { var b = t.daily.reduce(function (a, c) { return c.revenue > a.revenue ? c : a; }); return 'Best day ' + md(b.day) + ', ' + money(b.revenue) + ' on ' + b.orders + ' orders'; }
  function metaFunnel() {
    if (!(D.meta && D.meta.available)) return null;
    var f = { lpv: 0, atc: 0, ic: 0 };
    D.meta.ads.forEach(function (a) { f.lpv += num(a.lpv); f.atc += num(a.atc); f.ic += num(a.ic); });
    return f;
  }
  function miCell(k, v, n) { return '<div class="mi"><div class="k">' + k + '</div><div class="v">' + v + '</div>' + (n ? '<div class="n">' + n + '</div>' : '') + '</div>'; }
  function cartMinis() {
    var c = D.summary && D.summary.carts; if (!c) return '';
    return miCell('Carts on the site', num(c.carts), 'the platform count is inflated') + miCell('Payment failures', num(c.fails), num(c.drafts) + ' checkouts started');
  }
  function funnelCard(t) {
    var f = metaFunnel(), head3 = '<section class="card rise" style="--i:10"><h3>Funnel<span class="r">Where people fall out between ad and order</span></h3>';
    if (!f) {
      var cm = cartMinis();
      return head3 + '<div class="empty"><b>Ad platform not connected.</b>The funnel above the cart needs Meta. Cart and checkout counts from the site are below.</div>' + (cm ? '<div class="mini">' + cm + '</div>' : '') + '</section>';
    }
    function r(a, b) { return b ? a / b * 100 : 0; }
    var steps = [['Landing views', f.lpv, 'fb', null], ['Add to cart', f.atc, 'fb f2', r(f.atc, f.lpv)], ['Checkout', f.ic, 'fb f3', r(f.ic, f.atc)], ['Orders', t.orders, 'fb f4', r(t.orders, f.ic)]];
    var max = Math.max(f.lpv, f.atc, f.ic, t.orders, 1), h = head3;
    steps.forEach(function (s, i) {
      h += '<div class="fr"><div class="l">' + s[0] + '</div><div class="fbw"><span>' + s[1] + '</span><div class="bar" style="flex:1"><div class="' + s[2] + '" style="--i:' + i + ';width:' + Math.max(3, s[1] / max * 100) + '%"></div></div></div><div class="c">' + (s[3] == null ? '' : s[3] > 105 ? '<span class="dim">n/a</span>' : '<b>' + pct(s[3]) + '</b> through') + '</div></div>';
      if (i < 3) { var lost = s[1] - steps[i + 1][1]; h += '<div class="fgap">' + (lost > 0 ? lost + ' lost here' : 'Meta tracked fewer than actually landed') + '</div>'; }
    });
    var c2o = r(t.orders, f.atc);
    h += '<div class="mini">' + miCell('Cart → order', f.atc ? (c2o > 105 ? 'n/a' : pct(c2o)) : '—', 'the joint that usually leaks') + miCell('View → cart', f.lpv ? pct(r(f.atc, f.lpv)) : '—', 'interest in the offer') + cartMinis() + '</div>';
    if (t.orders > f.ic && f.ic) h += '<div class="note warn" style="margin-top:12px"><div><b>More orders landed than Meta counted checkouts (' + t.orders + ' vs ' + f.ic + ').</b>Meta only sees what it can attribute. Read the shape, not the step percentages.</div></div>';
    return h + '</section>';
  }
  function productsCard() {
    var list = (D.summary && D.summary.products) || [];
    if (!list.length) return '';
    var h = '<section class="card flush rise" style="--i:11"><h3>What sold<span class="r">Top 15 in this range</span></h3><div class="scroll" style="margin-top:12px"><table style="min-width:360px"><thead><tr><th>Product</th><th>Type</th><th>Units</th></tr></thead><tbody>';
    list.forEach(function (p) { h += '<tr><td class="nm">' + esc(p.name) + '</td><td class="dim">' + (p.product_type === 'miniature' ? '<span class="badge">miniature</span>' : 'bottle') + '</td><td><b>' + num(p.qty) + '</b></td></tr>'; });
    return h + '</tbody></table></div></section>';
  }

  /* ---- allocations ---- */
  // Stripe pays out two business days after the trading day and never on a
  // weekend: Thu/Fri/Sat land Mon/Tue/Wed, Sun and Mon both land Wednesday.
  function payoutDay(iso) { var add = { 4: 4, 5: 4, 6: 4, 0: 3, 1: 2, 2: 2, 3: 2 }[new Date(iso + 'T12:00:00Z').getUTCDay()]; return shift(iso, add); }
  function groupPayouts(daily) {
    var g = {};
    daily.forEach(function (r) {
      var p = payoutDay(r.day); if (!g[p]) g[p] = { pay: p, days: [], revenue: 0, bottles: 0, minis: 0, ads: 0, adsKnown: true, orders: 0 };
      var b = g[p]; b.days.push(r.day); b.revenue += r.revenue; b.bottles += r.bottles; b.minis += r.minis; b.orders += r.orders; b.ads += r.ad;
      if (r.adKnown === false) b.adsKnown = false;
    });
    return Object.keys(g).sort().reverse().map(function (k) { return g[k]; });
  }
  function ln(label, sub, val, cls) { return '<div class="ln ' + cls + '"><div class="lt"><b>' + label + '</b><em>' + esc(sub) + '</em></div><div class="lv">' + val + '</div></div>'; }
  function allocData(g, cfgDate, cfg) {
    var fees = g.revenue * K.fee, lands = g.revenue - fees, est = g.bottles * K.cogsBottle + g.minis * K.cogsMini;
    var act = supplierMap()[g.pay], isAct = act != null, sup = isAct ? num(act) : est;
    var gst = g.days.some(function (d) { return d >= K.gstFrom; }) ? lands / 11 : 0, net = g.revenue - sup - fees - g.ads - gst;
    var a = cfg ? (g.days[0] >= cfgDate ? { car: num(cfg.after.car) / 100, stock: num(cfg.after.stock) / 100 } : { car: num(cfg.before.car) / 100, stock: num(cfg.before.stock) / 100 }) : allocFor(g.days[0]);
    return { fees: fees, lands: lands, est: est, sup: sup, isAct: isAct, gst: gst, net: net, a: a, car: net * a.car, st: net * a.stock, op: net - net * a.car - net * a.stock };
  }
  function splitText(s) { return 'Personal ' + s.car + ' / Stock ' + s.stock + ' / Operating ' + (100 - s.car - s.stock); }
  function vAlloc() {
    var c = ctx(), groups = groupPayouts(c.t.daily), a = allocCfg();
    var h = head('Allocations', '<button type="button" class="btn" id="alloc-edit">Edit splits</button>');
    h += '<div class="note ok rise" style="--i:1;margin:0 0 14px"><div><b>Split now: ' + splitText(a.after) + '.</b>This applies to every trading day from ' + md(a.switchDate) + '. Before that: ' + splitText(a.before) + '. Supplier cost is estimated from the bottle count until you type in what she actually invoiced. Refunds and anything unusual are not in here — they come out of Operating.</div></div>';
    if (!groups.length) h += '<div class="card"><div class="empty">No trade in this range.</div></div>';
    groups.forEach(function (g, i) {
      var x = allocData(g), a2 = x.a, cur = g.days[0] >= a.switchDate;
      var from = g.days.length === 1 ? dw(g.days[0]) + ' ' + md(g.days[0]) : g.days.map(dw).join(', ') + ' ' + md(g.days[0]) + '–' + md(g.days[g.days.length - 1]);
      h += '<div class="pay rise' + (i === 0 ? ' next' : '') + '" data-pay="' + g.pay + '" style="--i:' + Math.min(i + 2, 9) + '"><div class="payhead"><span class="d">' + dw(g.pay) + ' ' + md(g.pay) + '</span><span class="f">from ' + from + ' · ' + g.orders + ' orders</span><span class="amt">' + money(x.lands, 2) + ' lands</span></div>' +
        ln('Revenue', 'before fees', money(g.revenue, 2), '') + ln('Processing fees', (K.fee * 100).toFixed(1) + '% estimate', '−' + money(x.fees, 2), 'out') +
        '<div class="ln out"><div class="lt"><b>Pay the supplier</b><em>' + (x.isAct ? 'her invoice' : g.bottles + ' bottles' + (g.minis ? ' + ' + g.minis + ' miniatures' : '') + ' · estimate') + (x.isAct ? '<span class="tick">actual</span>' : '') + '</em></div>' +
        '<div class="lv"><input type="number" step="0.01" data-sup="' + g.pay + '" value="' + (x.isAct ? x.sup.toFixed(2) : '') + '" placeholder="' + x.est.toFixed(2) + '" aria-label="Actual supplier invoice"></div></div>' +
        ln('Move to the GST account', 'revenue less fees ÷ 11', '−' + money(x.gst, 2), 'out') + ln('Ad spend', g.adsKnown ? 'already paid to Meta' : 'not known for these days', g.adsKnown ? '−' + money(g.ads, 2) : '—', 'out') +
        '<div class="ln net"><div class="lt"><b>Net</b><em>what actually splits</em></div><div class="lv">' + money(x.net, 2) + '</div></div>' +
        '<div class="ln move car"><div class="lt"><b>→ Personal fund</b><em>' + Math.round(a2.car * 100) + '% · ' + (cur ? 'current split' : 'earlier split') + '</em></div><div class="lv">' + money(x.car, 2) + '</div></div>' +
        '<div class="ln move"><div class="lt"><b>→ Stock account</b><em>' + Math.round(a2.stock * 100) + '%</em></div><div class="lv">' + money(x.st, 2) + '</div></div>' +
        '<div class="ln move"><div class="lt"><b>→ Operating</b><em>' + Math.round((1 - a2.car - a2.stock) * 100) + '% · ads, refunds, you</em></div><div class="lv">' + money(x.op, 2) + '</div></div></div>';
    });
    return h;
  }

  function vAds() {
    var c = ctx(), t = c.t, h = head('Ads'), byId = {};
    ((D.summary && D.summary.utm) || []).forEach(function (r) { byId[r.uc] = { orders: num(r.orders), revenue: num(r.revenue) }; });
    if (!(D.meta && D.meta.available)) {
      var why = D.meta && D.meta.reason === 'not_configured' ? 'No Meta token is set on the server. Add META_TOKEN and META_AD_ACCOUNT in the service settings and this fills in automatically.' : 'Meta answered with an error: ' + esc((D.meta && D.meta.message) || 'unknown');
      return h + '<section class="card rise" style="--i:1"><div class="empty"><b>Ad platform not connected.</b>' + why + '</div></section><section class="card flush rise" style="--i:2"><h3>Orders by tag<span class="r">From the site, no ad platform needed</span></h3>' + utmTable(byId) + '</section>';
    }
    var live = D.meta.ads.slice().sort(function (a, b) { return num(b.spend) - num(a.spend); }), sp = 0, mo = 0, uo = 0, ur = 0, rows = '';
    live.forEach(function (a) {
      var u = byId[a.id] || { orders: 0, revenue: 0 }, tc = u.orders ? num(a.spend) / u.orders : null;
      sp += num(a.spend); mo += num(a.purchases); uo += u.orders; ur += u.revenue;
      rows += '<tr><td class="nm">' + esc(a.name || a.id) + '<div class="s">' + esc(a.adset || '') + '</div></td><td>' + money(num(a.spend), 2) + '</td><td class="dim hm">' + pct(num(a.ctr)) + '</td><td class="dim hm">' + money(num(a.cpm), 2) + '</td><td class="dim hm">' + (num(a.purchases) || '—') + '</td><td class="dim hm">' + (num(a.purchases) ? money(num(a.spend) / num(a.purchases), 2) : '—') + '</td><td><b>' + (u.orders || '—') + '</b></td><td class="hm">' + (u.revenue ? money(u.revenue) : '—') + '</td><td>' + (tc == null ? '<span class="dim">—</span>' : '<span class="badge ' + (tc < K.breakeven ? 'ok' : 'bad') + '">' + money(tc, 2) + '</span>') + '</td></tr>';
    });
    h += '<section class="card flush rise" style="--i:1"><h3>Per ad<span class="r">What Meta claims, next to what the site confirms</span></h3><div class="scroll" style="margin-top:12px"><table><thead><tr><th>Ad</th><th>Spend</th><th class="hm">CTR</th><th class="hm">CPM</th><th class="hm">Meta orders</th><th class="hm">Meta cost</th><th>Confirmed</th><th class="hm">Confirmed revenue</th><th>True cost</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="9" class="dim" style="text-align:center;padding:22px">No ad delivered in this range.</td></tr>') +
      '</tbody><tfoot><tr><td>' + live.length + ' ads</td><td>' + money(sp, 2) + '</td><td class="hm"></td><td class="hm"></td><td class="hm">' + mo + '</td><td class="hm">' + (mo ? money(sp / mo, 2) : '—') + '</td><td>' + uo + '</td><td class="hm">' + money(ur) + '</td><td>' + (uo ? money(sp / uo, 2) : '—') + '</td></tr></tfoot></table></div>';
    var direct = byId['(direct)'];
    if (direct) {
      var gap = (direct.orders + uo) ? direct.orders / (direct.orders + uo) * 100 : 0;
      h += '<div style="padding:0 18px 18px"><div class="note ' + (gap > 55 ? 'bad' : gap > 35 ? 'warn' : 'ok') + '"><div><b>' + direct.orders + ' orders (' + pct(gap) + ') came in with no tag — ' + money(direct.revenue) + '.</b>Those orders are real, but nothing can say which ad earned them, so every figure above understates its ad. ' + (gap > 55 ? 'Worse than usual — check the tracking parameters on any recently edited ad.' : 'Around the normal level.') + '</div></div></div>';
    }
    return h + '</section><section class="card flush rise" style="--i:2"><h3>Orders by tag</h3>' + utmTable(byId) + '</section>';
  }
  function utmTable(byId) {
    var keys = Object.keys(byId).sort(function (a, b) { return byId[b].revenue - byId[a].revenue; });
    var h = '<div class="scroll" style="margin-top:12px"><table style="min-width:0"><thead><tr><th>Tag</th><th>Orders</th><th>Revenue</th></tr></thead><tbody>';
    keys.forEach(function (k) { h += '<tr><td class="nm">' + (k === '(direct)' ? '<span class="badge warn">untagged</span>' : '<code>' + esc(k) + '</code>') + '</td><td>' + byId[k].orders + '</td><td>' + money(byId[k].revenue) + '</td></tr>'; });
    return h + '</tbody></table></div>';
  }

  function vMoney() {
    var c = ctx(), t = c.t, base = 0, carW = 0, stW = 0, f = fundNow();
    t.daily.forEach(function (r) { var x = Math.max(0, r._c); base += x; carW += x * r._car; stW += x * r._st; });
    var carR = base ? carW / base : allocFor(today()).car, stR = base ? stW / base : allocFor(today()).stock, pos = Math.max(0, t.net), car = pos * carR, stock = pos * stR, oper = pos - car - stock;
    var bal = f.bal, perDay = t.days ? car / t.days : 0, left = Math.max(0, K.carTarget - bal), days = perDay > 0 ? Math.ceil(left / perDay) : null, landing = days != null ? shift(today(), days) : null;
    function rl(a, b, v, key) { return '<div class="rl' + (key ? ' key' : '') + '"><div class="t">' + a + '<em>' + b + '</em></div><div class="a">' + money(v) + '</div></div>'; }
    var h = head('Money');
    h += '<section class="card rise" style="--i:1"><h3>Split for this range<span class="r">' + Math.round(carR * 100) + ' / ' + Math.round(stR * 100) + ' / ' + Math.round((1 - carR - stR) * 100) + '</span></h3><div class="two"><div><div class="rowlist">' +
      rl('Net', 'after everything', t.net) + rl('Personal fund', 'to your account', car, true) + rl('Stock', 'to the stock account', stock) + rl('Operating', 'ads, refunds, you', oper) + rl('GST held', 'not yours', t.gst) + '</div>' +
      (t.adKnown ? '' : '<div class="note bad" style="margin-top:11px"><div><b>Ad spend is missing.</b>Net and the split above are overstated until it is connected or entered.</div></div>') + '</div>' +
      '<div><div class="lab">PERSONAL FUND</div><div class="meter"><i style="width:' + Math.min(100, bal / K.carTarget * 100).toFixed(1) + '%"></i></div><div class="mrow"><span>' + money(bal) + '</span><span>' + pct(bal / K.carTarget * 100) + ' of ' + money(K.carTarget) + '</span></div>' +
      '<div class="mini">' + miCell('Per day', perDay > 0 ? money(perDay) : '—', "at this range's rate") + miCell('Still needed', money(left), days != null ? days + ' days at this rate' : 'set a balance in Settings') + '</div>' +
      (f.asOf ? '<div class="foot" style="margin-top:10px">Started from ' + money(f.base) + ' on ' + md(f.asOf) + ', plus ' + money(f.added) + ' from payouts since.</div>' : '') +
      (landing && bal > 0 ? '<div class="note ok"><div><b>Target reached around ' + dw(landing) + ' ' + md(landing) + ' ' + landing.slice(0, 4) + '.</b>Straight line from this range only — it assumes nothing changes.</div></div>' : '') + '</div></div></section>';
    if (D.stripe && D.stripe.available && D.stripe.payouts.length) {
      h += '<section class="card flush rise" style="--i:2"><h3>Recent payouts</h3><div class="scroll" style="margin-top:12px"><table style="min-width:0"><thead><tr><th>Arrived</th><th>Amount</th><th>Status</th></tr></thead><tbody>';
      D.stripe.payouts.forEach(function (p) {
        var d = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(p.arrival * 1000));
        h += '<tr><td>' + esc(d) + '</td><td><b>' + money(p.amount, 2) + '</b></td><td class="dim">' + esc(p.status) + '</td></tr>';
      });
      h += '</tbody></table></div></section>';
    } else h += '<section class="card rise" style="--i:2"><h3>Recent payouts</h3><div class="empty"><b>Payment provider not connected.</b>Add STRIPE_KEY in the service settings to see money landing.</div></section>';
    return h;
  }

  function vStock() {
    var c = ctx(), t = c.t, units = stockUnits(), perDay = t.days ? t.bottles / t.days : 0, cover = perDay > 0 ? units / perDay : null, sd = span(K.shutStart, K.shutEnd), until = span(today(), K.shutStart) - 1;
    var cls, msg;
    if (cover == null) { cls = 'warn'; msg = '<b>No bottles sold in this range.</b>Pick a range with trade in it to read the burn rate.'; }
    else if (cover >= sd + 3) { cls = 'ok'; msg = '<b>' + units + ' units covers the closure with ' + (cover - sd).toFixed(1) + ' days spare.</b>Comfortable at this burn rate — recheck after every budget rise.'; }
    else if (cover >= sd) { cls = 'warn'; msg = '<b>' + units + ' units covers the closure by ' + (cover - sd).toFixed(1) + ' days. That is not a buffer.</b>Any growth and you run dry before the supplier reopens.'; }
    else { cls = 'bad'; msg = '<b>' + units + ' units runs out ' + (sd - cover).toFixed(1) + ' days before the supplier reopens.</b>Increase the order, or plan the message change now.'; }
    return head('Stock') + '<section class="card rise" style="--i:1"><h3>Cover<span class="r">' + units + ' units on order</span></h3><div class="mini" style="margin-top:0">' +
      miCell('Bottles a day', perDay.toFixed(1), 'across this range') + miCell('Cover', cover != null ? cover.toFixed(1) + ' days' : '—', 'at that burn rate') + miCell('Closure', sd + ' days', '25 Sept – 8 Oct, no fulfilment') + miCell('Until it starts', until > 0 ? until + ' days' : 'under way', 'order lands ~22 Sept') +
      '</div><div class="note ' + cls + '"><div>' + msg + '</div></div></section>';
  }

  function conn(name, ok, note) { return '<div class="rl"><div class="t">' + name + '<em>' + note + '</em></div><div><span class="badge ' + (ok ? 'ok' : 'warn') + '">' + (ok ? 'Connected' : 'Not set') + '</span></div></div>'; }
  function vSettings() {
    var s = D.settings || {}, f = fundNow(), metaOk = D.meta && D.meta.available, stripeOk = D.stripe && D.stripe.available;
    return head('Settings') +
      '<section class="card rise" style="--i:1"><h3>Larp mode</h3><div class="foot" style="margin:0 0 4px">Shows only revenue, ad spend and net profit. Hides orders, bottles, costs, funnel, products and every other page.</div>' +
      '<div class="field"><button class="sw" id="larpsw2" role="switch" aria-checked="' + S.larp + '"><span class="swl">Larp mode</span><span class="track"><span class="knob"></span></span></button></div></section>' +
      '<section class="card rise" style="--i:2"><h3>Figures you keep</h3>' +
      '<div class="field" style="margin-top:0"><label for="f-car">Personal fund balance</label><input type="number" id="f-car" step="0.01" value="' + (s.carBalance != null ? f.bal.toFixed(2) : '') + '"></div>' +
      '<div class="foot">What is in the account right now. After you save it, the fund adds your share of every payout on its own.</div>' +
      '<div class="field"><label for="f-units">Units on order</label><input type="number" id="f-units" step="1" value="' + stockUnits() + '"></div>' +
      '<div class="field"><label for="f-ads">Daily ad spend by hand</label><input type="number" id="f-ads" step="0.01" value="' + (s.manualAdSpend != null ? s.manualAdSpend : '') + '"></div>' +
      '<div class="foot">Used only while the ad platform is not connected. It is multiplied by the number of days in the range.</div><div class="field"><button class="btn p" id="save">Save</button><span id="saved" class="dim"></span></div></section>' +
      '<section class="card rise" style="--i:3"><h3>Password<span class="r">Changing it signs out your other devices</span></h3>' +
      '<div class="field" style="margin-top:0"><label for="pw-cur">Current password</label><input type="password" id="pw-cur" autocomplete="current-password"></div>' +
      '<div class="field"><label for="pw-new">New password</label><input type="password" id="pw-new" autocomplete="new-password" placeholder="8 characters or more"></div>' +
      '<div class="field"><label for="pw-two">Repeat it</label><input type="password" id="pw-two" autocomplete="new-password"></div>' +
      '<div class="field"><button class="btn p" id="pwsave">Change password</button><span id="pwmsg" class="dim"></span></div></section>' +
      '<section class="card rise" style="--i:4"><h3>Connections</h3><div class="rowlist">' + conn('Database', !!D.summary, 'Orders, products, carts and tags') +
      conn('Ad platform', !!metaOk, metaOk ? 'Spend, reach and the funnel above the cart' : 'Set META_TOKEN and META_AD_ACCOUNT in the service environment') +
      conn('Payments', !!stripeOk, stripeOk ? 'Money landing in the bank' : 'Set STRIPE_KEY in the service environment') + '</div></section>' +
      '<section class="card rise" style="--i:5"><h3>Session</h3><div class="foot" style="margin:0 0 10px">Signing in lasts 180 days and renews every time you open the dashboard.</div><div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn" id="refreshnow">Refresh now</button><button class="btn" id="signout2">Sign out</button></div></section>';
  }

  /* ---------- render + wiring ---------- */
  var V = $('view');
  function render(rise) {
    if (S.larp && ['alloc', 'ads', 'money', 'stock'].indexOf(S.view) > -1) S.view = 'overview';
    if (S.larp && ['rev', 'ad', 'net'].indexOf(S.metric) < 0) S.metric = 'rev';
    V.classList.toggle('still', rise === false);
    if (!D.loaded) V.innerHTML = '<div class="card"><div class="skel"></div><div class="skel" style="width:60%;margin-top:12px"></div></div>';
    else if (!D.summary) V.innerHTML = head('Overview') + '<div class="card"><div class="empty"><b>Can\'t reach the database.</b>' + esc((D.err.summary && D.err.summary.message) || 'Try Refresh in a moment.') + '</div></div>';
    else V.innerHTML = ({ overview: vOverview, alloc: vAlloc, ads: vAds, money: vMoney, stock: vStock, settings: vSettings })[S.view]();
    Array.prototype.forEach.call($('dock').querySelectorAll('button'), function (b) { if (b.dataset.v === S.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    place($('dock'), '.lens', $('dock').querySelector('[aria-current=page]'));
    if (D.loaded && D.summary) { bindCharts(V); bindPage(); if (rise !== false) countUp(V); }
  }
  function place(host, sel, btn) {
    var el = host.querySelector(sel); if (!el || !btn || !btn.offsetWidth) return;
    el.style.width = btn.offsetWidth + 'px'; el.style.transform = 'translateX(' + btn.offsetLeft + 'px)';
  }
  function marks() {
    Array.prototype.forEach.call($('presets').querySelectorAll('button'), function (b) { b.setAttribute('aria-pressed', b.dataset.p === S.preset ? 'true' : 'false'); });
  }
  function arm() {
    if (timer) { clearInterval(timer); timer = null; }
    if (S.preset === 'today') timer = setInterval(function () { if (document.visibilityState === 'visible') { if (S.to !== today()) setRange('today'); load(); } }, 300000);
  }
  function setRange(p) {
    var t = today(); S.preset = p;
    if (p === 'today') S.from = S.to = t; else if (p === 'yday') S.from = S.to = shift(t, -1);
    else if (p === '7' || p === '14' || p === '30') { S.to = t; S.from = shift(t, -(parseInt(p, 10) - 1)); }
    else if (p === 'mtd') { S.to = t; S.from = t.slice(0, 8) + '01'; }
    else if (p === 'all') { S.to = t; S.from = D.first && D.first <= t ? D.first : shift(t, -365); }
    else if (p === 'lastmo') { var f = t.slice(0, 8) + '01'; S.to = shift(f, -1); S.from = S.to.slice(0, 8) + '01'; }
    $('from').value = S.from; $('to').value = S.to; marks(); arm();
  }
  function setLarp(on) {
    S.larp = on; document.body.classList.toggle('larp', on);
    ['larpsw', 'larpsw2'].forEach(function (id) { var e = $(id); if (e) e.setAttribute('aria-checked', on); });
    try { localStorage.setItem('daybook-larp', on ? '1' : '0'); } catch (e) {}
    render(); setTimeout(function () { place($('dock'), '.lens', $('dock').querySelector('[aria-current=page]')); }, 0);
  }
  function putSettings(body) { return api('/api/settings', { method: 'PUT', body: JSON.stringify(body) }).then(function (v) { D.settings = v || D.settings; return v; }); }

  function placeTabs() {
    var t = $('mtabs'); if (!t) return; var a = t.querySelector('[aria-pressed=true]'); place(t, '.thumb', a);
    if (a && t.scrollTo) { try { t.scrollTo({ left: Math.max(0, a.offsetLeft - 16), behavior: reduce ? 'auto' : 'smooth' }); } catch (e) {} }
  }
  function bindPage() {
    placeTabs();
    var hero = $('hero');
    if (hero) hero.addEventListener('click', function (e) { var g = e.target.closest('[data-gran]'); if (!g) return; tap(); S.gran = g.dataset.gran; drawHero(); });
    Array.prototype.forEach.call(V.querySelectorAll('#mtabs button'), function (b) {
      b.addEventListener('click', function () {
        tap(); S.metric = b.dataset.m;
        Array.prototype.forEach.call($('mtabs').querySelectorAll('button'), function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
        placeTabs(); drawHero();
      });
    });
    Array.prototype.forEach.call(V.querySelectorAll('[data-act=range]'), function (b) { b.addEventListener('click', function () { tap(); openRange(); }); });
    var rp = V.querySelector('[data-act=report]');
    if (rp) rp.addEventListener('click', function () { tap(); var r = $('report'); if (r) r.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }); });
    Array.prototype.forEach.call(V.querySelectorAll('[data-go]'), function (b) { b.addEventListener('click', function () { tap(); S.view = b.dataset.go; render(); window.scrollTo({ top: 0 }); }); });
    var eb = $('alloc-edit'); if (eb) eb.addEventListener('click', function () { tap(); openModal(); });
    Array.prototype.forEach.call(V.querySelectorAll('input[data-sup]'), function (inp) {
      inp.addEventListener('change', function () {
        var map = Object.assign({}, supplierMap()), key = inp.dataset.sup;
        if (inp.value === '') delete map[key]; else map[key] = Number(inp.value);
        D.settings.supplierActual = map; tap(); render(false);
        api('/api/settings', { method: 'PUT', body: JSON.stringify({ supplierActual: map }) }).then(function (v) { if (v) D.settings = v; }).catch(function () {});
      });
    });
    var l2 = $('larpsw2'); if (l2) l2.addEventListener('click', function () { tap(); setLarp(!S.larp); });
    var sv = $('save'); if (sv) sv.addEventListener('click', function () {
      tap();
      var body = {}, f = fundNow(), car = $('f-car').value, units = $('f-units').value, ads = $('f-ads').value;
      if (car !== '' && Math.abs(Number(car) - f.bal) > 0.004) { body.carBalance = Number(car); body.carBalanceAsOf = today(); }
      if (units !== '' && Number(units) !== stockUnits()) body.stockUnits = Number(units);
      if (ads !== '') body.manualAdSpend = Number(ads);
      var m = $('saved'); m.textContent = 'Saving…';
      putSettings(body).then(function () { render(false); var s2 = $('saved'); if (s2) { s2.textContent = 'Saved to all your devices.'; setTimeout(function () { var s3 = $('saved'); if (s3) s3.textContent = ''; }, 2500); } })
        .catch(function () { m.textContent = 'Could not save.'; });
    });
    var pw = $('pwsave'); if (pw) pw.addEventListener('click', function () {
      tap(); var m = $('pwmsg'), cur = $('pw-cur').value, nw = $('pw-new').value, tw = $('pw-two').value;
      if (!cur) { m.textContent = 'Type your current password.'; return; }
      if (nw.length < 8) { m.textContent = 'New password needs 8 characters or more.'; return; }
      if (nw !== tw) { m.textContent = 'The two new passwords do not match.'; return; }
      m.textContent = 'Saving…';
      api('/api/password', { method: 'POST', body: JSON.stringify({ current: cur, next: nw }) })
        .then(function () { $('pw-cur').value = $('pw-new').value = $('pw-two').value = ''; m.textContent = 'Password changed.'; setTimeout(function () { m.textContent = ''; }, 3000); })
        .catch(function (e) { m.textContent = (e && e.error) || 'Could not change it.'; });
    });
    var rn = $('refreshnow'); if (rn) rn.addEventListener('click', function () { tap(); load(); });
    var so = $('signout2'); if (so) so.addEventListener('click', function () { tap(); fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).then(showGate); });
  }

  /* ----- allocation modal ----- */
  var lastFocus = null;
  function amRead() {
    return { switchDate: $('am-date').value, before: { car: Number($('am-bcar').value) || 0, stock: Number($('am-bst').value) || 0 }, after: { car: Number($('am-acar').value) || 0, stock: Number($('am-ast').value) || 0 } };
  }
  function amSums() {
    [['am-bcar', 'am-bst', 'am-bop'], ['am-acar', 'am-ast', 'am-aop']].forEach(function (g) {
      var op = 100 - (Number($(g[0]).value) || 0) - (Number($(g[1]).value) || 0), el = $(g[2]); el.textContent = op + '%'; el.className = 'amop' + (op < 0 ? ' bad' : '');
    });
    /* Show what the newest payout would do under the numbers typed in, so a change is visible before saving. */
    var pv = $('am-prev'), t = today(), g = groupPayouts(windowRows(shift(t, -9), t))[0];
    if (!g) { pv.textContent = ''; return; }
    var a = amRead(), x = allocData(g, a.switchDate, a);
    pv.innerHTML = 'Your latest payout (' + dw(g.pay) + ' ' + md(g.pay) + ', net ' + money(x.net, 2) + ') would move <b>' + money(x.car, 2) + '</b> to your personal fund, <b>' + money(x.st, 2) + '</b> to stock and <b>' + money(x.op, 2) + '</b> to operating.';
  }
  function openModal() {
    var a = allocCfg(); lastFocus = document.activeElement;
    $('am-date').value = a.switchDate; $('am-bcar').value = a.before.car; $('am-bst').value = a.before.stock; $('am-acar').value = a.after.car; $('am-ast').value = a.after.stock;
    $('am-msg').textContent = ''; amSums(); var m = $('modal'); m.classList.remove('out'); m.hidden = false; document.body.style.overflow = 'hidden';
    setTimeout(function () { $('am-acar').focus(); }, 30);
  }
  function closeModal() {
    var m = $('modal'); if (m.hidden) return; m.classList.add('out'); document.body.style.overflow = '';
    setTimeout(function () { m.hidden = true; m.classList.remove('out'); if (lastFocus && lastFocus.focus) lastFocus.focus(); }, reduce ? 0 : 150);
  }
  function saveAlloc() {
    var a = amRead(), bad = null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.switchDate)) bad = 'Pick a switch date.';
    else if (a.before.car + a.before.stock > 100) bad = 'The earlier split adds up to more than 100%.';
    else if (a.after.car + a.after.stock > 100) bad = 'The new split adds up to more than 100%.';
    if (bad) { $('am-msg').textContent = bad; return; }
    $('am-msg').textContent = 'Saving…'; $('am-save').disabled = true;
    putSettings({ alloc: a }).then(function () {
      $('am-save').disabled = false; tap(); closeModal(); render(false);
      Array.prototype.forEach.call(V.querySelectorAll('.pay'), function (p) { p.classList.remove('flash'); void p.offsetWidth; p.classList.add('flash'); });
    }).catch(function (e) { $('am-save').disabled = false; $('am-msg').textContent = (e && e.error) || 'Could not save it.'; });
  }
  ['am-bcar', 'am-bst', 'am-acar', 'am-ast', 'am-date'].forEach(function (id) { $(id).addEventListener('input', amSums); $(id).addEventListener('change', amSums); });
  $('am-save').addEventListener('click', saveAlloc); $('am-cancel').addEventListener('click', function () { tap(); closeModal(); });
  $('modal').addEventListener('click', function (e) { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeModal(); closeRange(); } });

  /* ----- date range pop-up ----- */
  function openRange() { marks(); var m = $('rangemodal'); lastFocus = document.activeElement; m.classList.remove('out'); m.hidden = false; document.body.style.overflow = 'hidden'; }
  function closeRange() {
    var m = $('rangemodal'); if (m.hidden) return; m.classList.add('out'); document.body.style.overflow = '';
    setTimeout(function () { m.hidden = true; m.classList.remove('out'); }, reduce ? 0 : 150);
  }
  $('rangedone').addEventListener('click', function () { tap(); closeRange(); });
  $('rangemodal').addEventListener('click', function (e) { if (e.target.id === 'rangemodal') closeRange(); });

  /* ----- chrome ----- */
  $('presets').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; tap(); setRange(b.dataset.p); closeRange(); load(); });
  function custom() {
    var re = /^\d{4}-\d{2}-\d{2}$/; S.from = re.test($('from').value) ? $('from').value : today(); S.to = re.test($('to').value) ? $('to').value : today();
    if (S.from > S.to) { var x = S.from; S.from = S.to; S.to = x; $('from').value = S.from; $('to').value = S.to; }
    S.preset = 'custom'; marks(); arm(); load();
  }
  $('from').addEventListener('change', custom); $('to').addEventListener('change', custom);
  $('dock').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; tap(); S.view = b.dataset.v; render(); window.scrollTo({ top: 0 }); });
  document.addEventListener('pointermove', function (e) { var g = e.target.closest && e.target.closest('.glass'); if (!g) return; var r = g.getBoundingClientRect(); g.style.setProperty('--mx', (e.clientX - r.left) + 'px'); g.style.setProperty('--my', (e.clientY - r.top) + 'px'); });
  var rsT = null, lastW = window.innerWidth;
  window.addEventListener('resize', function () {
    clearTimeout(rsT);
    rsT = setTimeout(function () {
      if (!$('app').hidden && window.innerWidth !== lastW) { lastW = window.innerWidth; render(false); }
      place($('dock'), '.lens', $('dock').querySelector('[aria-current=page]'));
    }, 150);
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && S.preset === 'today' && !$('app').hidden) { if (S.to !== today()) setRange('today'); load(); }
  });

  /* ----- pull down at the top of the page to refresh ----- */
  (function () {
    var ptr = $('ptr'), y0 = null, x0 = 0, pull = 0, TH = 64, active = false, ico = ptr.querySelector('svg');
    function atTop() { return (window.pageYOffset || document.documentElement.scrollTop || 0) <= 0 && document.body.style.overflow !== 'hidden' && !$('app').hidden; }
    function set(p) { pull = p; ptr.style.transform = 'translate(-50%,' + (p - 46) + 'px)'; ptr.style.opacity = Math.min(1, p / 40); ptr.classList.toggle('ready', p >= TH); ico.style.transform = 'rotate(' + (p * 4) + 'deg)'; }
    document.addEventListener('touchstart', function (e) { active = false; if (e.touches.length !== 1 || !atTop()) { y0 = null; return; } y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; }, { passive: true });
    document.addEventListener('touchmove', function (e) {
      if (y0 == null) return;
      var dy = e.touches[0].clientY - y0, dx = e.touches[0].clientX - x0;
      if (!active) {
        if (dy > 10 && dy > Math.abs(dx) * 1.5 && atTop()) active = true;
        else { if (dy < -6 || Math.abs(dx) > 14) y0 = null; return; }
      }
      ptr.classList.remove('settle'); set(Math.min(90, dy * 0.5));
    }, { passive: true });
    function end() {
      if (y0 == null) return;
      var go = active && pull >= TH; y0 = null; active = false; ptr.classList.add('settle');
      if (!go) { set(0); return; }
      tap(); ptr.classList.add('busy'); set(TH); load();
      var t0 = Date.now(), iv = setInterval(function () {
        if (busy && Date.now() - t0 < 30000) return;
        clearInterval(iv); setTimeout(function () { ptr.classList.remove('busy'); set(0); }, Math.max(0, 700 - (Date.now() - t0)));
      }, 120);
    }
    document.addEventListener('touchend', end, { passive: true }); document.addEventListener('touchcancel', end, { passive: true });
  })();

  function boot() {
    var on = false; try { on = localStorage.getItem('daybook-larp') === '1'; } catch (er) {}
    S.larp = on; document.body.classList.toggle('larp', on);
    api('/api/first').then(function (f) { D.first = f && f.first; }).catch(function () {});
    setRange(S.preset); render(); load();
    requestAnimationFrame(function () { marks(); place($('dock'), '.lens', $('dock').querySelector('[aria-current=page]')); });
  }
  /* Sign in with a plain button and the Enter key as well as the form, because some preview windows block form submits. */
  function doLogin() {
    $('gateerr').textContent = '';
    fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('pw').value }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) { if (!x.ok) { $('gateerr').textContent = x.j.error || 'Sign in failed.'; return; } $('pw').value = ''; showApp(); boot(); })
      .catch(function () { $('gateerr').textContent = 'Network problem. Try again.'; });
  }
  $('enter').addEventListener('click', function () { tap(); doLogin(); });
  $('pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doLogin(); } });
  $('gateform').addEventListener('submit', function (e) { e.preventDefault(); doLogin(); });

  fetch('/api/me', { credentials: 'same-origin' }).then(function (r) { return r.json(); })
    .then(function (j) { if (j.authed) { showApp(); boot(); } else showGate(); })
    .catch(showGate);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
  }
})();
