/**
 * Host half of `dsh-billing`.
 *
 * The Client half renders the billing pill and does all pricing arithmetic; it
 * only needs an up-to-date price table. Because a third-party plugin cannot add
 * a `ctx.remote` namespace (the application's Remote capability set is fixed at
 * build time by `dsh-api-remotes`), the table travels over a same-origin HTTP
 * route on the harness web server — the same seam other third-party plugins use
 * for their local endpoints.
 *
 * The route is the only optional part: without `webServer`, or when the fetch
 * or the parse fails, this half stays inert and records the reason. The Client
 * half then prices against its own bundled baseline, which was taken from the
 * official page and is labelled with its source and date.
 *
 * @module dsh-billing-capsule
 */

import { DEFAULT_CONFIG, parsePricingTable, stripHtml } from './pricing.js';

/** Route prefix this plugin owns; unique across the composition. */
const ROUTE_PREFIX = '/dsh-billing';

/** No mandatory service: `webServer` is looked up optionally. */
export const inject = [];

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** A loopback request is the only kind we answer when `loopbackOnly` is on. */
function isLoopback(address) {
  if (typeof address !== 'string') return false;
  return LOOPBACK.has(address) || address.startsWith('127.');
}

/** Minimal Node response writer; touches only long-standing `ServerResponse` fields. */
function respond(res, status, body) {
  let text;
  try {
    text = JSON.stringify(body ?? null);
  } catch {
    text = '{"ok":false,"reason":"unserializable"}';
  }
  if (typeof res?.setHeader !== 'function' || typeof res?.end !== 'function') return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-length', Buffer.byteLength(text));
  res.end(text);
}

/** Bound one fetch and normalise every failure into an Error with a message. */
async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 8000));
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'dsh-billing/0.1.0 (local plugin; pricing refresh)',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/** A plain object, never a prototype-bearing surprise, for the override map. */
function normalizeOverrides(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (typeof id === 'string' && id !== '' && entry !== null && typeof entry === 'object') out[id] = entry;
  }
  return out;
}

/**
 * Host plugin body: refresh the price table and serve it to the Client half.
 * @param ctx - plugin fiber context.
 * @param config - this row's `config` from `cordis.patch.yml`.
 */
export function apply(ctx, config) {
  const settings = { ...DEFAULT_CONFIG, ...(config !== null && typeof config === 'object' ? config : {}) };
  const overrides = normalizeOverrides(settings.models);
  const holidays = Array.isArray(settings.holidays) ? settings.holidays.filter((day) => typeof day === 'string') : [];

  /** Last successful parse; `reason` records why the newest attempt failed. */
  const state = { table: null, fetchedAt: 0, reason: 'not-fetched-yet' };

  const refresh = async () => {
    try {
      const html = await fetchText(settings.priceSourceUrl, settings.requestTimeoutMs);
      const parsed = parsePricingTable(stripHtml(html));
      if (!parsed.ok) {
        state.reason = `parse-failed:${parsed.reason}`;
        return;
      }
      state.table = parsed;
      state.fetchedAt = Date.now();
      state.reason = null;
    } catch (error) {
      state.reason = `fetch-failed:${error?.message ?? String(error)}`;
    }
  };

  const payload = () => {
    if (state.table === null) {
      return {
        ok: false,
        reason: state.reason ?? 'no-table',
        source: settings.priceSourceUrl,
        overrides,
      };
    }
    return {
      ok: true,
      fetchedAt: state.fetchedAt === 0 ? null : new Date(state.fetchedAt).toISOString(),
      source: settings.priceSourceUrl,
      currency: state.table.currency,
      unit: state.table.unit,
      peakWindows: state.table.peakWindows,
      models: state.table.models,
      overrides,
      note: state.reason === null ? null : `last refresh failed: ${state.reason}`,
    };
  };

  const handler = (req, res) => {
    if (settings.loopbackOnly === true && !isLoopback(req?.socket?.remoteAddress)) {
      respond(res, 403, { ok: false, reason: 'non-loopback' });
      return;
    }
    const method = req?.method ?? 'GET';
    const path = String(req?.url ?? '/').split('?')[0];
    if (method === 'GET' && (path === `${ROUTE_PREFIX}/prices.json` || path === `${ROUTE_PREFIX}/`)) {
      respond(res, 200, payload());
      return;
    }
    if (method === 'POST' && path === `${ROUTE_PREFIX}/refresh`) {
      refresh().then(() => respond(res, 200, payload()));
      return;
    }
    respond(res, 404, { ok: false, reason: 'not-found' });
  };

  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
  if (webServer !== undefined && typeof webServer.register === 'function') {
    ctx.effect(
      () => webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
      'dsh-billing: prices route',
    );
  }

  const refreshHours = Number(settings.refreshHours);
  if (Number.isFinite(refreshHours) && refreshHours > 0) {
    ctx.effect(() => {
      const id = setInterval(() => {
        refresh().catch(() => {});
      }, refreshHours * 3600 * 1000);
      return () => clearInterval(id);
    }, 'dsh-billing: refresh timer');
  }

  refresh().catch(() => {});
}
