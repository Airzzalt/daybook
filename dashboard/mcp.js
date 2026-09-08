'use strict';
/*
 * Velour Daybook — MCP server
 * ---------------------------------------------------------------------------
 * Exposes the dashboard's numbers over the Model Context Protocol so Claude and
 * ChatGPT both read the SAME figures, computed with the SAME constants, instead
 * of each re-deriving them from raw SQL.
 *
 * Transport: stateless Streamable HTTP. One endpoint, POST /mcp.
 * Auth:      Authorization: Bearer <MCP_TOKEN>
 * Deps:      none beyond what the dashboard already uses (express, pg).
 *
 * Mount from server.js with:   require('./mcp')(app, pool);
 */

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const TZ = 'Australia/Perth';

/* ------------------------------------------------------------- constants */
/* Corrected 8 Sept 2026. These override every older Velour document.       */
const K = {
  cogsBottleFlat: 39.53,      // AU$ — US$28.46 @ 1.3890
  cogsMini: 9.80,
  usdAud: 1.3890,
  feeRate: 0.04181,           // Stripe blended, ex-GST (4.60% incl GST)
  feeRateCard: 0.01654,
  feeRateBnpl: 0.05499,
  breakevenCpa: 142,
  gstFrom: '2026-08-18',      // GST registered
  gstDivisor: 11,             // provision = GROSS / 11 (not net of fees)
  // COGS per bottle by how many bottles are in the order — supplier's price
  // includes freight, so bigger orders are cheaper per unit.
  cogsCurve: { 1: 53.81, 2: 43.85, 3: 38.17, 4: 34.80, 5: 34.45, 6: 34.21 },
  allocDefault: {
    switchDate: '2026-09-25',                    // ~ when the stock loan clears
    before: { car: 45, stock: 20 },              // operating = 100 - car - stock
    after:  { car: 65, stock: 0 },
  },
};
function cogsForBottles(n) {
  if (!n || n < 1) return 0;
  if (n >= 6) return K.cogsCurve[6];
  return K.cogsCurve[n] || K.cogsBottleFlat;
}

/* ------------------------------------------------------------- utilities */
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LIVE = "COALESCE(o.status,'') NOT IN ('cancelled','refunded')";
const PERTH = (c) => `(${c}::timestamptz AT TIME ZONE '${TZ}')`;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function today() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function span(a) {
  const t = today();
  let from = DATE.test(a && a.from) ? a.from : t;
  let to = DATE.test(a && a.to) ? a.to : t;
  if (from > to) [from, to] = [to, from];
  return { from, to };
}
async function settings(pool) {
  const r = await pool.query(`SELECT value FROM dash_settings WHERE key='dashboard'`);
  return (r.rows[0] && r.rows[0].value) || {};
}
function allocCfg(s) {
  const a = (s && s.alloc) || {};
  return {
    switchDate: DATE.test(a.switchDate) ? a.switchDate : K.allocDefault.switchDate,
    before: a.before || K.allocDefault.before,
    after: a.after || K.allocDefault.after,
  };
}
function allocFor(day, cfg) {
  const s = day >= cfg.switchDate ? cfg.after : cfg.before;
  const car = Number(s.car) || 0, stock = Number(s.stock) || 0;
  return { car, stock, operating: 100 - car - stock };
}

/* ------------------------------------------------------------ core query */
/* One trip: per-order bottle/mini counts, so the COGS curve applies per
   order rather than to a daily average (which would understate bundles).   */
async function daysData(pool, from, to) {
  const q = await pool.query(
    `WITH ord AS (
       SELECT o.id, o.revenue_aud AS rev, ${PERTH('o.created_at')}::date AS d
       FROM orders o
       WHERE ${LIVE} AND ${PERTH('o.created_at')}::date BETWEEN $1::date AND $2::date
     ), per_order AS (
       SELECT ord.d, ord.id, MAX(ord.rev) AS rev,
              COALESCE(SUM(oi.quantity) FILTER (
                WHERE p.product_type = 'fragrance' OR p.product_type IS NULL), 0)::int AS bottles,
              COALESCE(SUM(oi.quantity) FILTER (
                WHERE p.product_type = 'miniature'), 0)::int AS minis
       FROM ord
       LEFT JOIN order_items oi ON oi.order_id = ord.id
       LEFT JOIN products p ON p.id = oi.product_id
       GROUP BY ord.d, ord.id
     )
     SELECT d::text AS day, id, rev::float8 AS rev, bottles, minis
     FROM per_order ORDER BY d, id`,
    [from, to]);

  const byDay = new Map();
  for (const o of q.rows) {
    if (!byDay.has(o.day)) {
      byDay.set(o.day, {
        day: o.day, orders: 0, revenue: 0, bottles: 0, minis: 0, cogs: 0,
      });
    }
    const d = byDay.get(o.day);
    d.orders += 1;
    d.revenue += Number(o.rev) || 0;
    d.bottles += o.bottles;
    d.minis += o.minis;
    d.cogs += o.bottles * cogsForBottles(o.bottles) + o.minis * K.cogsMini;
  }
  return [...byDay.values()].map((d) => {
    const fees = d.revenue * K.feeRate;
    const gst = d.day >= K.gstFrom ? d.revenue / K.gstDivisor : 0;
    const net = d.revenue - d.cogs - fees - gst;
    return {
      day: d.day,
      orders: d.orders,
      revenue: r2(d.revenue),
      aov: d.orders ? r2(d.revenue / d.orders) : 0,
      bottles: d.bottles,
      minis: d.minis,
      bottles_per_order: d.orders ? r2(d.bottles / d.orders) : 0,
      cogs: r2(d.cogs),
      stripe_fees: r2(fees),
      gst_provision: r2(gst),
      net_before_adspend: r2(net),
    };
  }).sort((a, b) => a.day < b.day ? -1 : 1);
}

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
async function metaInsights(from, to, level) {
  const token = process.env.META_TOKEN;
  const acct = process.env.META_AD_ACCOUNT;
  if (!token || !acct) return { available: false, reason: 'not_configured' };
  const id = acct.startsWith('act_') ? acct : 'act_' + acct;
  const fields = level === 'adset'
    ? 'adset_id,adset_name,campaign_name,spend,impressions,clicks,ctr,cpm,actions,action_values,frequency'
    : 'ad_id,ad_name,adset_name,spend,impressions,clicks,ctr,cpm,actions,action_values,frequency';
  const url = `https://graph.facebook.com/v21.0/${id}/insights?` + new URLSearchParams({
    level: level === 'adset' ? 'adset' : 'ad',
    fields,
    time_range: JSON.stringify({ since: from, until: to }),
    limit: '400',
    access_token: token,
  });
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
    const j = await res.json();
    if (j.error) return { available: false, reason: 'api_error', message: j.error.message };
    const rows = (j.data || []).map((d) => {
      const spend = Number(d.spend) || 0;
      const purchases = pick(d.actions, ACT.purchase);
      const revenue = pick(d.action_values, ACT.purchase);
      return {
        id: d.ad_id || d.adset_id,
        name: d.ad_name || d.adset_name,
        parent: d.adset_name || d.campaign_name,
        spend: r2(spend),
        impressions: Number(d.impressions) || 0,
        clicks: Number(d.clicks) || 0,
        ctr: r2(d.ctr),
        cpm: r2(d.cpm),
        frequency: r2(d.frequency),
        lpv: pick(d.actions, ACT.lpv),
        atc: pick(d.actions, ACT.atc),
        ic: pick(d.actions, ACT.ic),
        purchases,
        revenue: r2(revenue),
        cpa: purchases ? r2(spend / purchases) : null,
        roas: spend ? r2(revenue / spend) : null,
        over_breakeven: purchases ? (spend / purchases) > K.breakevenCpa : null,
      };
    }).filter((a) => a.spend > 0).sort((a, b) => b.spend - a.spend);
    return { available: true, breakeven_cpa: K.breakevenCpa, rows };
  } catch (e) {
    return { available: false, reason: 'unreachable', message: e.message };
  }
}

/* ----------------------------------------------------------------- tools */
const TOOLS = [
  {
    name: 'get_constants',
    description:
      'The corrected Velour unit-economics constants (COGS curve, Stripe fee rates, breakeven CPA, GST method, allocation splits). These override every older Velour document. Call this before doing any profit or breakeven arithmetic.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_days',
    description:
      'Per-day trading figures for a Perth-time date range: orders, revenue, AOV, bottles, miniatures (counted separately), COGS via the per-order bundle curve, Stripe fees, GST provision and net before ad spend. This is the authoritative day-close view.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD (Perth). Defaults to today.' },
        to: { type: 'string', description: 'YYYY-MM-DD (Perth). Defaults to today.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_products',
    description:
      'Units sold and revenue by product for a date range. Bottles and miniatures are returned separately — miniatures are never mixed into bottle counts.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' }, to: { type: 'string' },
        limit: { type: 'integer', description: 'Max rows, default 40.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_funnel',
    description:
      'Site funnel counts for a date range: abandoned carts, checkout drafts, payment attempt failures, plus completed orders. Use payment failures to tell a checkout bug apart from an intent drop.',
    inputSchema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_ads',
    description:
      'Meta ad performance for a date range with CPA, ROAS, frequency and an over_breakeven flag computed against the $142 breakeven CPA. NOTE: Meta over-reports purchases — reconcile against get_days before making a kill or scale call.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' }, to: { type: 'string' },
        level: { type: 'string', enum: ['ad', 'adset'], description: 'Default "ad".' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_allocations',
    description:
      'The cash allocation split (car fund / stock loan / operating) and what each trading day in the range allocates to each bucket, based on net before ad spend.',
    inputSchema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_settings',
    description:
      'Raw stored dashboard settings: car balance, manual ad spend, stock units, per-day actual supplier invoices, manual adjustments and the allocation config.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

async function runTool(pool, name, args) {
  args = args || {};
  switch (name) {
    case 'get_constants':
      return {
        ...K,
        note: 'Corrected 8 Sept 2026. Breakeven CPA $142. GST provision is GROSS/11, not net of fees. COGS is per-order via cogsCurve, not the flat rate.',
      };

    case 'get_days': {
      const { from, to } = span(args);
      const days = await daysData(pool, from, to);
      const t = days.reduce((a, d) => ({
        orders: a.orders + d.orders, revenue: a.revenue + d.revenue,
        bottles: a.bottles + d.bottles, minis: a.minis + d.minis,
        cogs: a.cogs + d.cogs, fees: a.fees + d.stripe_fees,
        gst: a.gst + d.gst_provision, net: a.net + d.net_before_adspend,
      }), { orders: 0, revenue: 0, bottles: 0, minis: 0, cogs: 0, fees: 0, gst: 0, net: 0 });
      return {
        from, to, today: today(), days,
        totals: {
          orders: t.orders, revenue: r2(t.revenue),
          aov: t.orders ? r2(t.revenue / t.orders) : 0,
          bottles: t.bottles, minis: t.minis,
          bottles_per_order: t.orders ? r2(t.bottles / t.orders) : 0,
          cogs: r2(t.cogs), stripe_fees: r2(t.fees),
          gst_provision: r2(t.gst), net_before_adspend: r2(t.net),
        },
        warning: to >= today()
          ? 'Range includes TODAY, which is a partial day. Do not make kill or scale calls from a partial day.'
          : undefined,
      };
    }

    case 'get_products': {
      const { from, to } = span(args);
      const lim = Math.min(Math.max(Number(args.limit) || 40, 1), 200);
      const q = await pool.query(
        `SELECT p.name, COALESCE(p.product_type,'fragrance') AS product_type,
                SUM(oi.quantity)::int AS units,
                ROUND(SUM(oi.quantity * COALESCE(oi.unit_price, 0))::numeric, 2)::float8 AS revenue
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
         JOIN products p ON p.id = oi.product_id
         WHERE ${LIVE} AND ${PERTH('o.created_at')}::date BETWEEN $1::date AND $2::date
         GROUP BY 1,2 ORDER BY units DESC LIMIT $3`, [from, to, lim]);
      return {
        from, to,
        bottles: q.rows.filter((r) => r.product_type !== 'miniature'),
        miniatures: q.rows.filter((r) => r.product_type === 'miniature'),
      };
    }

    case 'get_funnel': {
      const { from, to } = span(args);
      const q = await pool.query(
        `SELECT
          (SELECT COUNT(*)::int FROM orders o WHERE ${LIVE}
             AND ${PERTH('o.created_at')}::date BETWEEN $1::date AND $2::date) AS orders,
          (SELECT COUNT(*)::int FROM abandoned_carts
             WHERE ${PERTH('created_at')}::date BETWEEN $1::date AND $2::date) AS abandoned_carts,
          (SELECT COUNT(*)::int FROM checkout_drafts
             WHERE ${PERTH('created_at')}::date BETWEEN $1::date AND $2::date) AS checkout_drafts,
          (SELECT COUNT(*)::int FROM payment_attempt_failures
             WHERE ${PERTH('created_at')}::date BETWEEN $1::date AND $2::date) AS payment_failures`,
        [from, to]);
      return {
        from, to, ...q.rows[0],
        hint: 'Flat payment_failures alongside a cart collapse rules out a checkout bug — look at intent instead.',
      };
    }

    case 'get_ads': {
      const { from, to } = span(args);
      return { from, to, level: args.level === 'adset' ? 'adset' : 'ad', ...(await metaInsights(from, to, args.level)) };
    }

    case 'get_allocations': {
      const { from, to } = span(args);
      const s = await settings(pool);
      const cfg = allocCfg(s);
      const days = await daysData(pool, from, to);
      const rows = days.map((d) => {
        const a = allocFor(d.day, cfg);
        const net = d.net_before_adspend;
        return {
          day: d.day, net_before_adspend: net,
          car: r2(net * a.car / 100),
          stock_loan: r2(net * a.stock / 100),
          operating: r2(net * a.operating / 100),
          split: a,
        };
      });
      return {
        from, to, config: cfg, days: rows,
        totals: {
          car: r2(rows.reduce((n, r) => n + r.car, 0)),
          stock_loan: r2(rows.reduce((n, r) => n + r.stock_loan, 0)),
          operating: r2(rows.reduce((n, r) => n + r.operating, 0)),
        },
        car_balance: s.carBalance != null ? s.carBalance : null,
      };
    }

    case 'get_settings':
      return await settings(pool);

    default:
      throw Object.assign(new Error('Unknown tool: ' + name), { code: -32601 });
  }
}

/* ------------------------------------------------------------ transport */
module.exports = function mountMcp(app, pool) {
  const TOKEN = process.env.MCP_TOKEN || '';

  function authed(req) {
    if (!TOKEN) return false;                       // no token set = endpoint closed
    const h = req.get('authorization') || '';
    const m = /^Bearer\s+(.+)$/i.exec(h.trim());
    return !!m && m[1] === TOKEN;
  }
  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  // Discovery: some clients probe with GET before POST.
  app.get('/mcp', (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
    res.json({ name: 'velour-daybook', version: '1.0.0', transport: 'streamable-http', tools: TOOLS.map((t) => t.name) });
  });

  app.post('/mcp', async (req, res) => {
    if (!authed(req)) {
      res.set('WWW-Authenticate', 'Bearer');
      return res.status(401).json(err(null, -32001, 'Unauthorized'));
    }
    const msg = req.body;
    if (Array.isArray(msg)) return res.status(400).json(err(null, -32600, 'Batches not supported'));
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return res.status(400).json(err((msg && msg.id) ?? null, -32600, 'Invalid request'));
    }
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    try {
      switch (method) {
        case 'initialize': {
          const want = params && params.protocolVersion;
          return res.json(ok(id, {
            protocolVersion: PROTOCOL_VERSIONS.includes(want) ? want : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'velour-daybook', version: '1.0.0' },
            instructions:
              'Velour Perfumes trading data. Always call get_constants before profit or breakeven arithmetic — ' +
              'the constants here override older Velour documents. Miniatures are always reported separately from ' +
              'bottles. Never make a kill or scale call from a partial (today) day. Meta over-reports purchases; ' +
              'reconcile get_ads against get_days.',
          }));
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return res.status(202).end();

        case 'ping':
          return res.json(ok(id, {}));

        case 'tools/list':
          return res.json(ok(id, { tools: TOOLS }));

        case 'tools/call': {
          const name = params && params.name;
          try {
            const out = await runTool(pool, name, params && params.arguments);
            return res.json(ok(id, {
              content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
              structuredContent: out,
              isError: false,
            }));
          } catch (e) {
            return res.json(ok(id, {
              content: [{ type: 'text', text: 'Tool failed: ' + e.message }],
              isError: true,
            }));
          }
        }

        case 'resources/list':  return res.json(ok(id, { resources: [] }));
        case 'prompts/list':    return res.json(ok(id, { prompts: [] }));

        default:
          if (isNotification) return res.status(202).end();
          return res.json(err(id, -32601, 'Method not found: ' + method));
      }
    } catch (e) {
      return res.status(500).json(err(id ?? null, -32603, e.message));
    }
  });
};
