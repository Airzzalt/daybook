(function () {
  'use strict';

  var COGS_BOTTLE = 37.50, COGS_MINI = 9.80, FEE_RATE = 0.051;
  var GST_FROM = '2026-08-18', BREAKEVEN_CPA = 132, CAR_TARGET = 35000;
  var SHUTDOWN_START = '2026-09-25', SHUTDOWN_END = '2026-10-08';
  var ALLOC_SWITCH = '2026-09-08';
  var TZ = 'Australia/Perth';

  var S = { from: '', to: '', preset: 'today', view: 'overview' };
  var D = { summary: null, meta: null, stripe: null, settings: {}, err: {} };
  var busy = false, timer = null;

  function $(id) { return document.getElementById(id); }
  function el(t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function n(v) { var x = Number(v); return isFinite(x) ? x : 0; }
  function money(v, d) { d = d == null ? 0 : d; return '$' + (v < 0 ? '-' : '') + Math.abs(v).toLocaleString('en-AU', { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function pct(v) { return (isFinite(v) ? v.toFixed(1) : '0.0') + '%'; }
  function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  function clock() { return new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()); }
  function shift(iso, d) { var x = new Date(iso + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); }
  function span(a, b) { return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5) + 1; }
  function md(iso) { var d = new Date(iso + 'T12:00:00Z'); return d.getUTCDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]; }
  function dw(iso) { return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(iso + 'T12:00:00Z').getUTCDay()]; }

  /* ------------------------------------------------------------- session */
  function api(path, opts) {
    return fetch(path, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, opts || {}))
      .then(function (r) {
        if (r.status === 401) { showGate(); throw { code: 'auth' }; }
        return r.json().then(function (j) { if (!r.ok) throw j; return j; });
      });
  }
  function showGate() { $('gate').hidden = false; $('app').hidden = true; }
  function showApp() { $('gate').hidden = true; $('app').hidden = false; }

  $('gateform').addEventListener('submit', function (e) {
    e.preventDefault();
    $('gateerr').textContent = '';
    fetch('/api/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('pw').value })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (!x.ok) { $('gateerr').textContent = x.j.error || 'Sign in failed.'; return; }
        $('pw').value = ''; showApp(); boot();
      })
      .catch(function () { $('gateerr').textContent = 'Network problem. Try again.'; });
  });
  $('signout').addEventListener('click', function () {
    fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).then(showGate);
  });

  /* --------------------------------------------------------------- range */
  function setRange(p) {
    var t = today(); S.preset = p;
    if (p === 'today') S.from = S.to = t;
    else if (p === 'yday') S.from = S.to = shift(t, -1);
    else if (p === '7' || p === '14' || p === '30') { S.to = t; S.from = shift(t, -(parseInt(p, 10) - 1)); }
    else if (p === 'mtd') { S.to = t; S.from = t.slice(0, 8) + '01'; }
    else if (p === 'lastmo') { var f = t.slice(0, 8) + '01'; S.to = shift(f, -1); S.from = S.to.slice(0, 8) + '01'; }
    $('from').value = S.from; $('to').value = S.to;
    marks(); arm();
  }
  function marks() {
    Array.prototype.forEach.call($('presets').children, function (b) {
      b.setAttribute('aria-pressed', b.dataset.p === S.preset ? 'true' : 'false');
    });
  }
  function custom() {
    var re = /^\d{4}-\d{2}-\d{2}$/;
    S.from = re.test($('from').value) ? $('from').value : today();
    S.to = re.test($('to').value) ? $('to').value : today();
    if (S.from > S.to) { var x = S.from; S.from = S.to; S.to = x; $('from').value = S.from; $('to').value = S.to; }
    S.preset = 'custom'; marks(); arm();
  }
  function arm() {
    if (timer) { clearInterval(timer); timer = null; }
    if (S.preset === 'today') timer = setInterval(function () {
      if (document.visibilityState === 'visible') { if (S.to !== today()) setRange('today'); load(); }
    }, 300000);
  }

  /* ---------------------------------------------------------------- load */
  function load() {
    if (busy) return; busy = true;
    $('refresh').disabled = true; $('refresh').textContent = 'Loading';
    var q = '?from=' + S.from + '&to=' + S.to;
    Promise.allSettled([api('/api/summary' + q), api('/api/meta' + q), api('/api/stripe'), api('/api/settings'), api('/api/adspend' + q)])
      .then(function (r) {
        busy = false; $('refresh').disabled = false; $('refresh').textContent = 'Refresh';
        D.summary = r[0].status === 'fulfilled' ? r[0].value : null; D.err.summary = r[0].reason;
        D.meta = r[1].status === 'fulfilled' ? r[1].value : null; D.err.meta = r[1].reason;
        D.stripe = r[2].status === 'fulfilled' ? r[2].value : null;
        D.settings = r[3].status === 'fulfilled' ? (r[3].value || {}) : {};
        D.adspend = r[4].status === 'fulfilled' ? r[4].value : null;
        $('led-db').className = 'led ' + (D.summary ? 'ok' : 'bad');
        $('led-meta').className = 'led ' + (D.meta && D.meta.available ? 'ok' : '');
        $('led-stripe').className = 'led ' + (D.stripe && D.stripe.available ? 'ok' : '');
        render();
      });
  }

  /* --------------------------------------------------------------- maths */
  function crunch() {
    if (!D.summary) return null;
    var daily = D.summary.daily.slice();
    var t = { orders: 0, revenue: 0, bottles: 0, minis: 0, gst: 0, cogs: 0, fees: 0, days: daily.length };
    daily.forEach(function (r) {
      var rev = n(r.revenue), b = n(r.bottles), m = n(r.minis);
      var gst = r.day >= GST_FROM ? rev / 11 : 0;
      var cogs = b * COGS_BOTTLE + m * COGS_MINI, fees = rev * FEE_RATE;
      t.orders += n(r.orders); t.revenue += rev; t.bottles += b; t.minis += m;
      t.gst += gst; t.cogs += cogs; t.fees += fees;
      r._c = rev - gst - cogs - fees;
      r._car = r.day >= ALLOC_SWITCH ? 0.65 : 0.45;
      r._st = r.day >= ALLOC_SWITCH ? 0 : 0.20;
    });
    t.contrib = t.revenue - t.gst - t.cogs - t.fees;
    t.aov = t.orders ? t.revenue / t.orders : 0;
    t.daily = daily;
    t.adSpend = metaSpend();
    t.adKnown = t.adSpend != null;
    if (t.adSpend == null) t.adSpend = 0;
    t.net = t.contrib - t.adSpend;
    t.cpa = t.orders ? t.adSpend / t.orders : 0;
    t.roas = t.adSpend ? t.revenue / t.adSpend : 0;
    return t;
  }
  function metaSpend() {
    if (D.meta && D.meta.available) return D.meta.ads.reduce(function (s, a) { return s + n(a.spend); }, 0);
    if (D.settings && D.settings.manualAdSpend != null) {
      var days = D.summary ? span(D.summary.from, D.summary.to) : 1;
      return n(D.settings.manualAdSpend) * days;
    }
    return null;
  }
  function metaFunnel() {
    if (!(D.meta && D.meta.available)) return null;
    var f = { lpv: 0, atc: 0, ic: 0, pur: 0 };
    D.meta.ads.forEach(function (a) { f.lpv += n(a.lpv); f.atc += n(a.atc); f.ic += n(a.ic); f.pur += n(a.purchases); });
    return f;
  }

  /* -------------------------------------------------------------- render */
  function render() {
    ['overview', 'alloc', 'ads', 'money', 'stock', 'settings'].forEach(function (v) { $('v-' + v).hidden = v !== S.view; });
    Array.prototype.forEach.call($('nav').querySelectorAll('a'), function (a) {
      if (a.dataset.v === S.view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    var t = crunch();
    if (S.view === 'overview') overview(t);
    else if (S.view === 'alloc') allocView(t);
    else if (S.view === 'ads') ads(t);
    else if (S.view === 'money') moneyView(t);
    else if (S.view === 'stock') stockView(t);
    else settings();
  }

  /* ---- allocations ----------------------------------------------------- */
  // Stripe pays out two business days after the trading day, and never on a
  // weekend: Thu/Fri/Sat land Mon/Tue/Wed, Sun and Mon both land Wednesday.
  function payoutDay(iso) {
    var add = { 4: 4, 5: 4, 6: 4, 0: 3, 1: 2, 2: 2, 3: 2 }[new Date(iso + 'T12:00:00Z').getUTCDay()];
    return shift(iso, add);
  }
  function daySpend(iso) {
    if (D.adspend && D.adspend.available && D.adspend.days[iso] != null) return n(D.adspend.days[iso]);
    if (D.settings && D.settings.manualAdSpend != null) return n(D.settings.manualAdSpend);
    return null;
  }
  function groupPayouts(daily) {
    var g = {};
    daily.forEach(function (r) {
      var p = payoutDay(r.day);
      if (!g[p]) g[p] = { pay: p, days: [], revenue: 0, bottles: 0, minis: 0, ads: 0, adsKnown: true, orders: 0 };
      var b = g[p];
      b.days.push(r.day); b.revenue += n(r.revenue); b.bottles += n(r.bottles); b.minis += n(r.minis); b.orders += n(r.orders);
      var s = daySpend(r.day);
      if (s == null) b.adsKnown = false; else b.ads += s;
    });
    return Object.keys(g).sort().reverse().map(function (k) { return g[k]; });
  }

  function allocView(t) {
    var host = $('v-alloc');
    if (!t) return dbDown(host);
    var groups = groupPayouts(t.daily);
    var actual = (D.settings && D.settings.supplierActual) || {};
    var h = head('Allocations', rangeLabel());
    h += '<div class="note ok" style="margin-bottom:14px"><div><b>What to move when each payout lands.</b>' +
      'Supplier cost is estimated from the bottle count until you type in what she actually invoiced. ' +
      'Refunds and anything unusual are not in here — they come out of Operating.</div></div>';
    if (!groups.length) h += '<div class="card"><div class="empty">No trade in this range.</div></div>';

    groups.forEach(function (g, i) {
      var fees = g.revenue * FEE_RATE;
      var lands = g.revenue - fees;
      var est = g.bottles * COGS_BOTTLE + g.minis * COGS_MINI;
      var sup = actual[g.pay] != null ? n(actual[g.pay]) : est;
      var isActual = actual[g.pay] != null;
      var gst = g.days.some(function (d) { return d >= GST_FROM; }) ? lands / 11 : 0;
      var net = g.revenue - sup - fees - g.ads - gst;
      var carRate = g.days[0] >= ALLOC_SWITCH ? 0.65 : 0.45;
      var stRate = g.days[0] >= ALLOC_SWITCH ? 0 : 0.20;
      var car = net * carRate, st = net * stRate, op = net - car - st;
      var from = g.days.length === 1 ? dw(g.days[0]) + ' ' + md(g.days[0])
        : g.days.map(function (d) { return dw(d); }).join(', ') + ' ' + md(g.days[0]) + '–' + md(g.days[g.days.length - 1]);

      h += '<div class="pay' + (i === 0 ? ' next' : '') + '">' +
        '<div class="payhead"><span class="d">' + dw(g.pay) + ' ' + md(g.pay) + '</span>' +
        '<span class="f">from ' + from + ' · ' + g.orders + ' orders</span>' +
        '<span class="amt">' + money(lands, 2) + ' lands</span></div>' +

        line('Revenue', 'before fees', money(g.revenue, 2), '') +
        line('Processing fees', '5.1% estimate', '−' + money(fees, 2), 'out') +

        '<div class="ln out"><div class="lt"><b>Pay the supplier</b><em>' +
        (isActual ? 'her invoice' : g.bottles + ' bottles' + (g.minis ? ' + ' + g.minis + ' miniatures' : '') + ' · estimate') +
        (isActual ? '<span class="tick">actual</span>' : '') + '</em></div>' +
        '<div class="lv"><input type="number" step="0.01" data-sup="' + g.pay + '" value="' + (isActual ? sup.toFixed(2) : '') +
        '" placeholder="' + est.toFixed(2) + '" aria-label="Actual supplier invoice"></div></div>' +

        line('Move to the GST account', 'revenue less fees ÷ 11', '−' + money(gst, 2), 'out') +
        line('Ad spend', g.adsKnown ? 'already paid to Meta' : 'not known for these days', g.adsKnown ? '−' + money(g.ads, 2) : '—', 'out') +

        '<div class="ln net"><div class="lt"><b>Net</b><em>what actually splits</em></div><div class="lv">' + money(net, 2) + '</div></div>' +
        '<div class="ln move car"><div class="lt"><b>→ Car account</b><em>' + Math.round(carRate * 100) + '%</em></div><div class="lv">' + money(car, 2) + '</div></div>' +
        '<div class="ln move"><div class="lt"><b>→ Stock account</b><em>' + Math.round(stRate * 100) + '%</em></div><div class="lv">' + money(st, 2) + '</div></div>' +
        '<div class="ln move"><div class="lt"><b>→ Operating</b><em>' + Math.round((1 - carRate - stRate) * 100) + '% · ads, refunds, you</em></div><div class="lv">' + money(op, 2) + '</div></div>' +
        '</div>';
    });
    host.innerHTML = h;

    Array.prototype.forEach.call(host.querySelectorAll('input[data-sup]'), function (inp) {
      inp.addEventListener('change', function () {
        var map = Object.assign({}, (D.settings && D.settings.supplierActual) || {});
        if (inp.value === '') delete map[inp.dataset.sup]; else map[inp.dataset.sup] = Number(inp.value);
        D.settings.supplierActual = map;
        allocView(crunch());
        api('/api/settings', { method: 'PUT', body: JSON.stringify({ supplierActual: map }) }).catch(function () {});
      });
    });
  }
  function line(label, sub, val, cls) {
    return '<div class="ln ' + cls + '"><div class="lt"><b>' + label + '</b><em>' + esc(sub) + '</em></div><div class="lv">' + val + '</div></div>';
  }
  function head(title, meta) {
    return '<div class="phead"><h2>' + esc(title) + '</h2><span class="meta">' + esc(meta) + '</span></div>';
  }
  function rangeLabel() {
    if (!D.summary) return '';
    var s = S.from === S.to ? dw(S.from) + ' ' + md(S.from) : md(S.from) + ' – ' + md(S.to) + ' · ' + span(S.from, S.to) + ' days';
    return s + ' · synced ' + clock() + ' Perth';
  }
  function dbDown(host) {
    host.innerHTML = head('Overview', '') +
      '<div class="card"><div class="empty"><b>Can\'t reach the database.</b>' +
      esc((D.err.summary && D.err.summary.message) || 'Try Refresh in a moment.') + '</div></div>';
  }

  /* ---- overview ---- */
  function overview(t) {
    var host = $('v-overview');
    if (!t) return dbDown(host);
    var h = head('Overview', rangeLabel());
    var per = t.days || 1;
    function kpi(k, v, sub, cls, key) {
      return '<div class="kpi' + (key ? ' key' : '') + '"><div class="k">' + k + '</div><div class="v' + (cls ? ' ' + cls : '') + '">' + v +
        '</div>' + (sub ? '<div class="n">' + sub + '</div>' : '') + '</div>';
    }
    h += '<div class="kpis">' +
      kpi('Orders', t.orders, t.days > 1 ? (t.orders / per).toFixed(1) + ' a day' : '') +
      kpi('Revenue', money(t.revenue), t.days > 1 ? money(t.revenue / per) + ' a day' : '') +
      kpi('Average order', money(t.aov, 2), (t.bottles / (t.orders || 1)).toFixed(2) + ' bottles an order') +
      kpi('Bottles', t.bottles, t.minis + ' miniatures, costed apart') +
      '</div><div class="kpis">' +
      kpi('Ad spend', t.adKnown ? money(t.adSpend) : '—', t.adKnown ? (D.meta && D.meta.available ? 'from Meta' : 'entered by hand') : 'not connected') +
      kpi('Net', t.adKnown ? money(t.net) : '—', t.adKnown ? 'after GST, cost, fees, ads' : 'needs ad spend', t.net >= 0 ? 'ok' : 'bad', true) +
      kpi('Cost per order', t.adKnown && t.orders ? money(t.cpa, 2) : '—', 'breakeven ' + money(BREAKEVEN_CPA), t.adKnown && t.cpa > 0 ? (t.cpa < BREAKEVEN_CPA ? 'ok' : 'bad') : '') +
      kpi('Return on spend', t.adKnown && t.adSpend ? t.roas.toFixed(2) + 'x' : '—', 'revenue ÷ ad spend') +
      '</div>';

    h += '<div class="card"><h3>Daily trade' + (t.daily.length > 1 ? '<span class="r">' + bestLine(t) + '</span>' : '') + '</h3>' +
      chart(t.daily) + dailyTable(t) + '</div>';
    h += '<div class="duo"><div class="card"><h3>Funnel<span class="r">Where people fall out between ad and order</span></h3><div class="pad">' + funnel(t) + '</div></div>';
    h += (D.summary.products && D.summary.products.length ? productsCard() : '') + '</div>';
    host.innerHTML = '<div class="inner">' + h + '</div>';
  }
  function bestLine(t) {
    var b = t.daily.reduce(function (a, c) { return n(c.revenue) > n(a.revenue) ? c : a; });
    return 'Best day ' + md(b.day) + ', ' + money(n(b.revenue)) + ' on ' + n(b.orders) + ' orders';
  }
  function chart(daily) {
    if (daily.length < 2) return '<div class="empty">One day selected — widen the range to see the trend.</div>';
    var narrow = window.innerWidth < 700;
    var W = narrow ? 440 : 900, H = narrow ? 330 : 220;
    var L = narrow ? 44 : 54, R = 10, T = 12, B = narrow ? 40 : 34;
    var iw = W - L - R, ih = H - T - B;
    var fs = narrow ? 12 : 10.5, fs2 = narrow ? 10.5 : 9.5;
    var max = Math.max.apply(null, daily.map(function (r) { return n(r.revenue); })); if (max <= 0) max = 1;
    var st = Math.pow(10, Math.floor(Math.log(max) / Math.LN10));
    var tick = Math.ceil(max / 4 / st) * st, top = tick * 4;
    var bw = iw / daily.length, cw = Math.max(3, Math.min(narrow ? 26 : 38, bw * 0.58));
    var every = Math.ceil(daily.length / (narrow ? 5 : 11));
    var s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Daily revenue and contribution">';
    for (var i = 0; i <= 4; i++) {
      var y = T + ih - ih * i / 4;
      s += '<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (W - R) + '" y2="' + y.toFixed(1) + '" stroke="var(--grid)" stroke-width="1"/>';
      s += '<text x="' + (L - 9) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end" font-size="' + fs + '" fill="var(--text-3)">' +
        (tick * i >= 1000 ? '$' + Math.round(tick * i / 1000) + 'k' : '$' + Math.round(tick * i)) + '</text>';
    }
    daily.forEach(function (r, i) {
      var v = n(r.revenue), hh = ih * v / top, x = L + bw * i + (bw - cw) / 2, y = T + ih - hh;
      s += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + cw.toFixed(1) + '" height="' + Math.max(0, hh).toFixed(1) +
        '" rx="3" fill="var(--brand)" opacity="' + (i === daily.length - 1 ? '1' : '0.5') + '"><title>' +
        md(r.day) + ' — ' + money(v) + ', ' + n(r.orders) + ' orders</title></rect>';
    });
    var pts = daily.map(function (r, i) { return (L + bw * i + bw / 2).toFixed(1) + ',' + (T + ih - ih * Math.max(0, r._c) / top).toFixed(1); });
    s += '<polyline points="' + pts.join(' ') + '" fill="none" stroke="#0C7C4A" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>';
    var last = pts[pts.length - 1].split(',');
    s += '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="4" fill="#0C7C4A"/>';
    daily.forEach(function (r, i) {
      if (i % every !== 0 && i !== daily.length - 1) return;
      var x = (L + bw * i + bw / 2).toFixed(1);
      s += '<text x="' + x + '" y="' + (H - (narrow ? 22 : 14)) + '" text-anchor="middle" font-size="' + fs + '" fill="var(--text-3)">' + md(r.day) + '</text>';
      s += '<text x="' + x + '" y="' + (H - (narrow ? 8 : 3)) + '" text-anchor="middle" font-size="' + fs2 + '" fill="var(--text-3)" opacity=".65">' + dw(r.day) + '</text>';
    });
    s += '</svg>';
    return '<div class="pad" style="padding-bottom:0">' + s + '</div>' +
      '<div class="legend"><span><i style="background:var(--brand)"></i>Revenue</span><span><i style="background:#0C7C4A"></i>Contribution before ads</span></div>';
  }
  function dailyTable(t) {
    var h = '<div class="scroll"><table><thead><tr><th>Day</th><th>Orders</th><th>Revenue</th><th>Avg order</th><th>Bottles</th><th>Mini</th><th>GST</th><th>Cost</th><th>Contribution</th></tr></thead><tbody>';
    t.daily.slice().reverse().forEach(function (r) {
      var rev = n(r.revenue), o = n(r.orders);
      var gst = r.day >= GST_FROM ? rev / 11 : 0, cogs = n(r.bottles) * COGS_BOTTLE + n(r.minis) * COGS_MINI;
      h += '<tr><td>' + dw(r.day) + ' ' + md(r.day) + '</td><td>' + o + '</td><td>' + money(rev) + '</td><td>' + money(o ? rev / o : 0) +
        '</td><td>' + n(r.bottles) + '</td><td class="dim">' + n(r.minis) + '</td><td class="dim">' + money(gst) +
        '</td><td class="dim">' + money(cogs) + '</td><td><b>' + money(r._c) + '</b></td></tr>';
    });
    h += '</tbody><tfoot><tr><td>' + t.daily.length + ' days</td><td>' + t.orders + '</td><td>' + money(t.revenue) + '</td><td>' + money(t.aov) +
      '</td><td>' + t.bottles + '</td><td>' + t.minis + '</td><td>' + money(t.gst) + '</td><td>' + money(t.cogs) + '</td><td>' + money(t.contrib) + '</td></tr></tfoot></table></div>';
    return h;
  }
  function funnel(t) {
    var f = metaFunnel();
    if (!f) return '<div class="empty"><b>Ad platform not connected.</b>The funnel above the cart needs Meta. Cart and checkout counts from the site are below.</div>' + cartStats();
    var o = t.orders, max = Math.max(f.lpv, f.atc, f.ic, o, 1);
    var steps = [['Landing views', f.lpv, 'fbar', null], ['Add to cart', f.atc, 'fbar f2', f.lpv ? f.atc / f.lpv * 100 : 0],
    ['Checkout', f.ic, 'fbar f3', f.atc ? f.ic / f.atc * 100 : 0], ['Orders', o, 'fbar f4', f.ic ? o / f.ic * 100 : 0]];
    var h = '<div class="funnel">';
    steps.forEach(function (s, i) {
      h += '<div class="fr"><div class="l">' + s[0] + '</div><div><div class="' + s[2] + '" style="width:' + Math.max(3, s[1] / max * 100) + '%">' + s[1] + '</div></div>' +
        '<div class="c">' + (s[3] == null ? '—' : s[3] > 105 ? '<span class="dim">more than Meta saw</span>' : '<b>' + pct(s[3]) + '</b> through') + '</div></div>';
      if (i < 3) {
        var lost = s[1] - steps[i + 1][1];
        h += '<div class="fgap"><div></div><div>' + (lost > 0 ? lost + ' lost here' : 'Meta tracked fewer than actually landed') + '</div></div>';
      }
    });
    h += '</div>';
    var c2o = f.atc ? o / f.atc * 100 : null;
    h += '<div class="mini" style="margin-top:14px">' +
      mi('Cart → order', c2o == null ? '—' : c2o > 105 ? 'n/a' : pct(c2o), c2o != null && c2o > 105 ? 'more orders than Meta saw carts' : 'the joint that usually leaks') +
      mi('View → cart', f.lpv ? pct(f.atc / f.lpv * 100) : '—', 'interest in the offer') + cartMinis() + '</div>';
    if (o > f.ic) h += '<div class="note warn" style="margin-top:12px"><div><b>More orders landed than Meta counted checkouts (' + o + ' vs ' + f.ic + ').</b>Meta only sees what it can attribute and most orders arrive untagged. Read the shape, not the step percentages.</div></div>';
    if (f.atc > f.lpv && f.atc > 0) h += '<div class="note warn" style="margin-top:8px"><div><b>Meta reports more carts than landing views.</b>That is impossible — cross-device and view-through counting. Trust the site cart count, and treat per-ad return on spend as inflated.</div></div>';
    return h;
  }
  function mi(k, v, s) { return '<div class="mi"><div class="k">' + k + '</div><div class="v">' + v + '</div>' + (s ? '<div class="n">' + s + '</div>' : '') + '</div>'; }
  function cartMinis() {
    var c = D.summary && D.summary.carts; if (!c) return '';
    return mi('Carts on the site', n(c.carts), 'the platform count is inflated') + mi('Payment failures', n(c.fails), n(c.drafts) + ' checkouts started');
  }
  function cartStats() { var s = cartMinis(); return s ? '<div class="mini" style="margin-top:12px">' + s + '</div>' : ''; }
  function productsCard() {
    var h = '<div class="card"><h3>What sold<span class="r">Top 15 in this range</span></h3><div class="scroll"><table style="min-width:400px"><thead><tr><th>Product</th><th>Type</th><th>Units</th></tr></thead><tbody>';
    D.summary.products.forEach(function (p) {
      h += '<tr><td class="n">' + esc(p.name) + '</td><td class="dim">' + (p.product_type === 'miniature' ? '<span class="badge">miniature</span>' : 'bottle') + '</td><td><b>' + n(p.qty) + '</b></td></tr>';
    });
    return h + '</tbody></table></div></div>';
  }

  /* ---- ads ---- */
  function ads(t) {
    var host = $('v-ads');
    if (!t) return dbDown(host);
    var h = head('Ads', rangeLabel());
    var byId = {}; (D.summary.utm || []).forEach(function (r) { byId[r.uc] = { orders: n(r.orders), revenue: n(r.revenue) }; });

    if (!(D.meta && D.meta.available)) {
      var why = D.meta && D.meta.reason === 'not_configured'
        ? 'No Meta token is set on the server. Add META_TOKEN and META_AD_ACCOUNT in the service settings and this fills in automatically.'
        : 'Meta answered with an error: ' + esc((D.meta && D.meta.message) || 'unknown');
      h += '<div class="card"><div class="empty"><b>Ad platform not connected.</b>' + why + '</div></div>';
      h += '<div class="card"><h3>Orders by tag<span class="r">From the site, no ad platform needed</span></h3>' + utmTable(byId) + '</div>';
      host.innerHTML = h; return;
    }

    var live = D.meta.ads.slice().sort(function (a, b) { return n(b.spend) - n(a.spend); });
    var sp = 0, mo = 0, uo = 0, ur = 0;
    var rows = '';
    live.forEach(function (a) {
      var u = byId[a.id] || { orders: 0, revenue: 0 };
      sp += n(a.spend); mo += n(a.purchases); uo += u.orders; ur += u.revenue;
      var tc = u.orders ? n(a.spend) / u.orders : null;
      rows += '<tr><td class="n">' + esc(a.name || a.id) + '<div class="s">' + esc(a.adset || '') + '</div></td>' +
        '<td>' + money(n(a.spend), 2) + '</td><td class="dim">' + pct(n(a.ctr)) + '</td><td class="dim">' + money(n(a.cpm), 2) + '</td>' +
        '<td class="dim">' + (n(a.purchases) || '—') + '</td>' +
        '<td class="dim">' + (n(a.purchases) ? money(n(a.spend) / n(a.purchases), 2) : '—') + '</td>' +
        '<td><b>' + (u.orders || '—') + '</b></td><td>' + (u.revenue ? money(u.revenue) : '—') + '</td>' +
        '<td>' + (tc == null ? '<span class="dim">—</span>' : '<span class="badge ' + (tc < BREAKEVEN_CPA ? 'ok' : 'bad') + '">' + money(tc, 2) + '</span>') + '</td></tr>';
    });
    h += '<div class="card"><h3>Per ad<span class="r">What Meta claims, next to what the site confirms</span></h3><div class="scroll"><table>' +
      '<thead><tr><th>Ad</th><th>Spend</th><th>CTR</th><th>CPM</th><th>Meta orders</th><th>Meta cost</th><th>Confirmed</th><th>Confirmed revenue</th><th>True cost</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="9" class="dim" style="text-align:center;padding:22px">No ad delivered in this range.</td></tr>') +
      '</tbody><tfoot><tr><td>' + live.length + ' ads</td><td>' + money(sp, 2) + '</td><td></td><td></td><td>' + mo + '</td><td>' +
      (mo ? money(sp / mo, 2) : '—') + '</td><td>' + uo + '</td><td>' + money(ur) + '</td><td>' + (uo ? money(sp / uo, 2) : '—') + '</td></tr></tfoot></table></div>';

    var direct = byId['(direct)'];
    if (direct) {
      var gap = (direct.orders + uo) ? direct.orders / (direct.orders + uo) * 100 : 0;
      h += '<div class="pad"><div class="note ' + (gap > 55 ? 'bad' : gap > 35 ? 'warn' : 'ok') + '"><div><b>' + direct.orders + ' orders (' + pct(gap) + ') came in with no tag — ' + money(direct.revenue) + '.</b>' +
        'Those orders are real, but nothing can say which ad earned them, so every figure above understates its ad. ' +
        (gap > 55 ? 'Worse than usual — check the tracking parameters on any recently edited ad.' : 'Around the normal level.') + '</div></div></div>';
    }
    h += '</div>';
    h += '<div class="card"><h3>Orders by tag</h3>' + utmTable(byId) + '</div>';
    host.innerHTML = h;
  }
  function utmTable(byId) {
    var keys = Object.keys(byId).sort(function (a, b) { return byId[b].revenue - byId[a].revenue; });
    var h = '<div class="scroll"><table style="min-width:400px"><thead><tr><th>Tag</th><th>Orders</th><th>Revenue</th></tr></thead><tbody>';
    keys.forEach(function (k) {
      h += '<tr><td class="n">' + (k === '(direct)' ? '<span class="badge warn">untagged</span>' : '<code style="font-size:11.5px">' + esc(k) + '</code>') +
        '</td><td>' + byId[k].orders + '</td><td>' + money(byId[k].revenue) + '</td></tr>';
    });
    return h + '</tbody></table></div>';
  }

  /* ---- money ---- */
  function moneyView(t) {
    var host = $('v-money');
    if (!t) return dbDown(host);
    var carW = 0, stW = 0, base = 0;
    t.daily.forEach(function (r) { var c = Math.max(0, r._c); base += c; carW += c * r._car; stW += c * r._st; });
    var carRate = base ? carW / base : 0.45, stRate = base ? stW / base : 0.20;
    var car = Math.max(0, t.net) * carRate, stock = Math.max(0, t.net) * stRate, oper = Math.max(0, t.net) - car - stock;
    var bal = n(D.settings.carBalance);
    var perDay = t.days ? car / t.days : 0;
    var left = Math.max(0, CAR_TARGET - bal);
    var days = perDay > 0 ? Math.ceil(left / perDay) : null;
    var landing = days != null ? shift(today(), days) : null;

    var h = head('Money', rangeLabel());
    h += '<div class="card"><h3>Split for this range<span class="r">' +
      Math.round(carRate * 100) + ' / ' + Math.round(stRate * 100) + ' / ' + Math.round((1 - carRate - stRate) * 100) + '</span></h3><div class="pad"><div class="two">';
    h += '<div><div class="rowlist">' +
      rl('Net', 'after everything', t.net) + rl('Car', 'to the car account', car, true) +
      rl('Stock', 'to the stock account', stock) + rl('Operating', 'ads, refunds, you', oper) +
      rl('GST held', 'not yours', t.gst) + '</div>' +
      (t.adKnown ? '' : '<div class="note bad" style="margin-top:11px"><div><b>Ad spend is missing.</b>Net and the split above are overstated until it is connected or entered.</div></div>') + '</div>';

    h += '<div><div class="lab">Target fund</div><div class="meter"><i style="width:' + Math.min(100, bal / CAR_TARGET * 100).toFixed(1) + '%"></i></div>' +
      '<div class="mrow"><span>' + money(bal) + '</span><span>' + pct(bal / CAR_TARGET * 100) + ' of ' + money(CAR_TARGET) + '</span></div>' +
      '<div class="mini" style="margin-top:12px">' + mi('Per day', perDay > 0 ? money(perDay) : '—', "at this range's rate") +
      mi('Still needed', money(left), days != null ? days + ' days at this rate' : 'set a balance in Settings') + '</div>' +
      (landing && bal > 0 ? '<div class="note ok" style="margin-top:12px"><div><b>Target reached around ' + dw(landing) + ' ' + md(landing) + ' ' + landing.slice(0, 4) + '.</b>Straight line from this range only — it assumes nothing changes, which nothing ever does.</div></div>' : '') +
      '</div></div></div></div>';

    if (D.stripe && D.stripe.available && D.stripe.payouts.length) {
      h += '<div class="card"><h3>Recent payouts</h3><div class="scroll"><table style="min-width:340px"><thead><tr><th>Arrived</th><th>Amount</th><th>Status</th></tr></thead><tbody>';
      D.stripe.payouts.forEach(function (p) {
        var d = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(p.arrival * 1000));
        h += '<tr><td>' + esc(d) + '</td><td><b>' + money(p.amount, 2) + '</b></td><td class="dim">' + esc(p.status) + '</td></tr>';
      });
      h += '</tbody></table></div></div>';
    } else {
      h += '<div class="card"><h3>Recent payouts</h3><div class="empty"><b>Payment provider not connected.</b>Add STRIPE_KEY in the service settings to see money landing.</div></div>';
    }
    host.innerHTML = h;
  }
  function rl(t1, s, v, key) {
    return '<div class="rl' + (key ? ' key' : '') + '"><div class="t">' + t1 + '<em>' + s + '</em></div><div class="a">' + money(v) + '</div></div>';
  }

  /* ---- stock ---- */
  function stockView(t) {
    var host = $('v-stock');
    if (!t) return dbDown(host);
    var units = D.settings.stockUnits != null ? n(D.settings.stockUnits) : 400;
    var perDay = t.days ? t.bottles / t.days : 0;
    var cover = perDay > 0 ? units / perDay : null;
    var sd = span(SHUTDOWN_START, SHUTDOWN_END);
    var until = span(today(), SHUTDOWN_START) - 1;

    var h = head('Stock', rangeLabel());
    h += '<div class="card"><h3>Cover<span class="r">' + units + ' units on order</span></h3><div class="pad"><div class="mini">' +
      mi('Bottles a day', perDay.toFixed(1), 'across this range') +
      mi('Cover', cover != null ? cover.toFixed(1) + ' days' : '—', 'at that burn rate') +
      mi('Closure', sd + ' days', '25 Sept – 8 Oct, no fulfilment') +
      mi('Until it starts', until > 0 ? until + ' days' : 'under way', 'order lands ~22 Sept') + '</div>';
    var cls, msg;
    if (cover == null) { cls = 'warn'; msg = '<b>No bottles sold in this range.</b>Pick a range with trade in it to read the burn rate.'; }
    else if (cover >= sd + 3) { cls = 'ok'; msg = '<b>' + units + ' units covers the closure with ' + (cover - sd).toFixed(1) + ' days spare.</b>Comfortable at this burn rate — and it stops being comfortable the moment you scale. Recheck after every budget rise.'; }
    else if (cover >= sd) { cls = 'warn'; msg = '<b>' + units + ' units covers the closure by ' + (cover - sd).toFixed(1) + ' days. That is not a buffer.</b>Flat volume just clears it. Any growth and you run dry before the supplier reopens.'; }
    else { cls = 'bad'; msg = '<b>' + units + ' units runs out ' + (sd - cover).toFixed(1) + ' days before the supplier reopens.</b>At this burn rate the order does not cover the closure. Either increase it, or plan the message change now rather than mid-closure.'; }
    h += '<div class="note ' + cls + '" style="margin-top:14px"><div>' + msg + '</div></div></div></div>';
    host.innerHTML = h;
  }

  /* ---- settings ---- */
  function settings() {
    var s = D.settings || {};
    var connected = D.meta && D.meta.available;
    var h = head('Settings', '');
    h += '<div class="card"><h3>Figures you keep</h3><div class="pad">' +
      '<div class="field"><label for="f-car" style="width:190px">Target account balance</label><input type="number" id="f-car" step="0.01" value="' + (s.carBalance != null ? s.carBalance : '') + '"></div>' +
      '<div class="field"><label for="f-units" style="width:190px">Units on order</label><input type="number" id="f-units" step="1" value="' + (s.stockUnits != null ? s.stockUnits : 400) + '"></div>' +
      '<div class="field"><label for="f-ads" style="width:190px">Daily ad spend by hand</label><input type="number" id="f-ads" step="0.01" value="' + (s.manualAdSpend != null ? s.manualAdSpend : '') + '"></div>' +
      '<div class="foot">Used only while the ad platform is not connected. It is multiplied by the number of days in the range.</div>' +
      '<div class="field"><button class="btn p" id="save">Save</button><span id="saved" class="dim"></span></div>' +
      '</div></div>';
    h += '<div class="card"><h3>Password<span class="r">Changing it signs out your other devices</span></h3><div class="pad">' +
      '<div class="field" style="margin-top:0"><label for="pw-cur" style="width:190px">Current password</label>' +
      '<input type="password" id="pw-cur" autocomplete="current-password"></div>' +
      '<div class="field"><label for="pw-new" style="width:190px">New password</label>' +
      '<input type="password" id="pw-new" autocomplete="new-password" placeholder="8 characters or more"></div>' +
      '<div class="field"><label for="pw-two" style="width:190px">Repeat it</label>' +
      '<input type="password" id="pw-two" autocomplete="new-password"></div>' +
      '<div class="field"><button class="btn p" id="pwsave">Change password</button><span id="pwmsg" class="dim"></span></div>' +
      '</div></div>';
    h += '<div class="card"><h3>Session</h3><div class="pad"><div class="foot" style="margin:0 0 10px">' +
      'Signing in lasts 180 days and renews every time you open the dashboard, so you should not have to type the password again on a device you use.' +
      '</div><div class="field" style="margin-top:0">' +
      '<button class="btn" id="signout2">Sign out</button></div></div></div>';
    h += '<div class="card"><h3>Connections</h3><div class="pad"><div class="rowlist">' +
      conn('Database', true, 'Orders, products, carts and tags') +
      conn('Ad platform', connected, connected ? 'Spend, reach and the funnel above the cart' : 'Set META_TOKEN and META_AD_ACCOUNT in the service environment') +
      conn('Payments', !!(D.stripe && D.stripe.available), (D.stripe && D.stripe.available) ? 'Money landing in the bank' : 'Set STRIPE_KEY in the service environment') +
      '</div></div></div>';
    h += '<div class="card"><h3>How the numbers are built</h3><div class="pad"><div class="foot">' +
      'Cancelled and refunded orders are excluded everywhere. Miniatures are counted and costed separately and never enter a bottle figure. ' +
      'Cost $' + COGS_BOTTLE.toFixed(2) + ' a bottle, $' + COGS_MINI.toFixed(2) + ' a miniature. Processing fees 5.1% of revenue. Tax is revenue ÷ 11, applied only from 18 Aug 2026. ' +
      'Net is revenue less tax, cost, fees and ad spend. Breakeven cost per order is ' + money(BREAKEVEN_CPA) + '. ' +
      'The split runs 45 / 20 / 35 up to 7 Sept and 65 / 0 / 35 from 8 Sept, applied per day inside the range. ' +
      'Ad spend is a range total, so it is not divided across individual days — the daily table stops at contribution before ads.' +
      '</div></div></div>';
    $('v-settings').innerHTML = h;
    $('save').addEventListener('click', function () {
      var body = {};
      if ($('f-car').value !== '') body.carBalance = Number($('f-car').value);
      if ($('f-units').value !== '') body.stockUnits = Number($('f-units').value);
      if ($('f-ads').value !== '') body.manualAdSpend = Number($('f-ads').value);
      $('saved').textContent = 'Saving…';
      api('/api/settings', { method: 'PUT', body: JSON.stringify(body) }).then(function (v) {
        D.settings = v || {}; $('saved').textContent = 'Saved to all your devices.';
        setTimeout(function () { $('saved').textContent = ''; }, 2500);
      }).catch(function () { $('saved').textContent = 'Could not save.'; });
    });
    $('signout2').addEventListener('click', function () {
      fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).then(showGate);
    });
    $('pwsave').addEventListener('click', function () {
      var cur = $('pw-cur').value, nw = $('pw-new').value, tw = $('pw-two').value;
      var msg = $('pwmsg');
      msg.style.color = '';
      if (!cur) { msg.textContent = 'Type your current password.'; return; }
      if (nw.length < 8) { msg.textContent = 'New password needs 8 characters or more.'; return; }
      if (nw !== tw) { msg.textContent = 'The two new passwords do not match.'; return; }
      msg.textContent = 'Saving…';
      api('/api/password', { method: 'POST', body: JSON.stringify({ current: cur, next: nw }) })
        .then(function () {
          $('pw-cur').value = $('pw-new').value = $('pw-two').value = '';
          msg.textContent = 'Password changed.';
          setTimeout(function () { msg.textContent = ''; }, 3000);
        })
        .catch(function (e) { msg.textContent = (e && e.error) || 'Could not change it.'; });
    });
  }
  function conn(name, ok, note) {
    return '<div class="rl"><div class="t">' + name + '<em>' + note + '</em></div><div><span class="badge ' + (ok ? 'ok' : 'warn') + '">' + (ok ? 'Connected' : 'Not set') + '</span></div></div>';
  }

  /* ----------------------------------------------------------------- wire */
  $('presets').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return; setRange(b.dataset.p); load();
  });
  $('from').addEventListener('change', function () { custom(); load(); });
  $('to').addEventListener('change', function () { custom(); load(); });
  $('refresh').addEventListener('click', function () { load(); });
  $('nav').addEventListener('click', function (e) {
    var a = e.target.closest('a'); if (!a) return;
    e.preventDefault(); S.view = a.dataset.v; render();
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && S.preset === 'today' && !$('app').hidden) {
      if (S.to !== today()) setRange('today');
      load();
    }
  });

  function boot() { setRange('today'); load(); }

  ['v-overview', 'v-ads', 'v-money', 'v-stock', 'v-settings'].forEach(function (id) {
    $(id).innerHTML = '<div class="card"><div class="skel"></div><div class="skel" style="width:60%"></div></div>';
  });

  fetch('/api/me', { credentials: 'same-origin' }).then(function (r) { return r.json(); })
    .then(function (j) { if (j.authed) { showApp(); boot(); } else showGate(); })
    .catch(showGate);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
  }
})();
