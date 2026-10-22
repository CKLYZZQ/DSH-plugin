/**
 * Official pricing-page parsing for the Host half of `dsh-billing`.
 *
 * Everything here is pure and dependency-free: no `ctx`, no network, no DOM,
 * so the same functions run unchanged under Node's test runner.
 *
 * The page is Docusaurus-rendered HTML. Rather than binding to markup, the
 * parser works on a tag-to-text projection in which `</td>`/`</th>` become
 * tabs, `</tr>` becomes a newline and `<br>` becomes a space (a price label is
 * split across lines by a `<br>` inside one cell, so it must stay one cell).
 * A price row is then recognised structurally — it carries a `时段` cell — and
 * classified by its label, which keeps unrelated rows such as `输出长度` from
 * being mistaken for the output price row.
 *
 * @module dsh-billing-capsule/pricing
 */

/** Host defaults; the `config` block of `cordis.patch.yml` overrides any key. */
export const DEFAULT_CONFIG = Object.freeze({
  priceSourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  refreshHours: 12,
  requestTimeoutMs: 8000,
  loopbackOnly: true,
  holidays: [],
  models: {},
});

/**
 * Peak windows in Asia/Shanghai. Every other instant is idle, and the official
 * page states idle is exactly half of peak.
 */
export const PEAK_WINDOWS = Object.freeze([
  Object.freeze({ days: Object.freeze([1, 2, 3, 4, 5]), start: '09:00', end: '12:00' }),
  Object.freeze({ days: Object.freeze([1, 2, 3, 4, 5]), start: '14:00', end: '18:00' }),
]);

/** Currency and token unit the official table is expressed in. */
export const CURRENCY = 'CNY';
export const TOKEN_UNIT = 1000000;

const ENTITIES = new Map([
  ['&nbsp;', ' '],
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&apos;', "'"],
  ['&#39;', "'"],
]);

/** Maximum plausible price per million tokens; anything above is a parse error. */
const MAX_PRICE = 10000;

const MODEL_ID = /^[a-z][a-z0-9._-]*$/;

const PRICE_BUCKETS = ['cacheHitInput', 'cacheMissInput', 'output'];

/**
 * Project an HTML document down to the line/cell text the parser reads.
 * @param html - raw response body.
 * @returns one line per table row, cells separated by tabs.
 */
export function stripHtml(html) {
  if (typeof html !== 'string') return '';
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<(?:td|th)\b[^>]*>/gi, '\t')
    .replace(/<\/(?:td|th)\s*>/gi, '\t')
    .replace(/<\/tr\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&[a-z]+;/gi, (entity) => ENTITIES.get(entity.toLowerCase()) ?? entity);
}

/** Split one projected line into non-empty cells. */
function cells(line) {
  return line
    .split('\t')
    .map((cell) => cell.replace(/\s+/g, ' ').trim())
    .filter((cell) => cell !== '');
}

/** Read a `12.3元` style amount; null when the cell is not an amount. */
function parseAmount(cell) {
  if (typeof cell !== 'string') return null;
  if (!/[0-9]/.test(cell)) return null;
  // A price cell may carry a currency suffix; a label cell never parses here
  // because the caller only offers cells that follow a `时段` marker.
  const value = Number.parseFloat(cell.replace(/[^0-9.]/g, ''));
  return Number.isFinite(value) ? value : null;
}

/** Model ids declared by the header row whose first cell is `模型`. */
function readModelIds(lines) {
  for (const line of lines) {
    const row = cells(line);
    if (row.length < 2) continue;
    if (row[0] !== '模型') continue;
    const ids = row
      .slice(1)
      .map((cell) => cell.replace(/\([^)]*\)/g, '').replace(/（[^）]*）/g, '').trim())
      .filter((cell) => MODEL_ID.test(cell));
    if (ids.length > 0) return ids;
  }
  return null;
}

/**
 * Read the `时段`-marked price cells of one row.
 * @param row - the row's cells.
 * @param modelCount - how many models the header declared.
 * @returns idle/peak arrays in header order, absent when the row is not a price row.
 */
function readRowWindows(row, modelCount) {
  const result = {};
  for (let index = 0; index < row.length; index += 1) {
    const cell = row[index];
    const kind = cell.includes('高峰') ? 'peak' : cell.includes('空闲') ? 'idle' : null;
    if (kind === null) continue;
    const values = [];
    for (let cursor = index + 1; cursor < row.length && values.length < modelCount; cursor += 1) {
      const value = parseAmount(row[cursor]);
      if (value === null) break;
      values.push(value);
    }
    if (values.length === modelCount) result[kind] = values;
    index += values.length;
  }
  return Object.keys(result).length === 0 ? null : result;
}

/**
 * The price-label cell of a row, when the row opens a logical price line.
 *
 * The official page names these cells `百万tokens输入（缓存命中）`,
 * `百万tokens输入（缓存未命中）` and `百万tokens输出`; requiring `tokens`
 * keeps the unrelated `输出长度` row out.
 */
function priceLabel(row) {
  return row.find((cell) => cell.includes('tokens') && (cell.includes('输入') || cell.includes('输出')));
}

/** Classify a `时段`-bearing row by its label. */
function bucketOf(label) {
  if (label.includes('缓存命中') && !label.includes('未命中')) return 'cacheHitInput';
  if (label.includes('缓存未命中') || label.includes('未命中')) return 'cacheMissInput';
  if (label.includes('输出')) return 'output';
  return null;
}

/** One model entry is usable only when all six prices are complete and sane. */
function validEntry(entry) {
  if (entry === null || typeof entry !== 'object') return false;
  return PRICE_BUCKETS.every((bucket) => {
    const value = entry[bucket];
    if (value === null || typeof value !== 'object') return false;
    return ['peak', 'idle'].every((kind) => {
      const price = value[kind];
      return typeof price === 'number' && Number.isFinite(price) && price > 0 && price <= MAX_PRICE;
    });
  });
}

/**
 * Parse the projected text of the official pricing page.
 * @param text - output of {@link stripHtml}.
 * @returns `{ ok: true, currency, unit, peakWindows, models }` or
 *   `{ ok: false, reason }`; a partial table is never returned.
 */
export function parsePricingTable(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, reason: 'empty-document' };
  }
  const lines = text.split('\n');
  const modelIds = readModelIds(lines);
  if (modelIds === null) return { ok: false, reason: 'no-model-header' };

  const rows = lines.map(cells).filter((row) => row.length > 0);
  const collected = new Map();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const label = priceLabel(row);
    if (label === undefined) continue;
    const bucket = bucketOf(label);
    if (bucket === null || collected.has(bucket)) continue;
    const windows = readRowWindows(row, modelIds.length) ?? {};
    // The official page splits one logical price row across two table rows:
    // `空闲时段` rides the labelled row, and `高峰时段` rides the next one,
    // whose leading cells are empty. Merge forward until both windows are known.
    for (let lookahead = 1; lookahead <= 2; lookahead += 1) {
      if (windows.peak !== undefined && windows.idle !== undefined) break;
      const next = rows[index + lookahead];
      if (next === undefined || priceLabel(next) !== undefined) break;
      const more = readRowWindows(next, modelIds.length);
      if (more === null) continue;
      if (windows.idle === undefined && more.idle !== undefined) windows.idle = more.idle;
      if (windows.peak === undefined && more.peak !== undefined) windows.peak = more.peak;
    }
    if (Array.isArray(windows.peak) && Array.isArray(windows.idle)) collected.set(bucket, windows);
  }

  const missing = PRICE_BUCKETS.filter((bucket) => !collected.has(bucket));
  if (missing.length > 0) return { ok: false, reason: `missing-price-row:${missing.join(',')}` };

  const models = {};
  for (let index = 0; index < modelIds.length; index += 1) {
    const entry = {
      cacheHitInput: { peak: collected.get('cacheHitInput').peak[index], idle: collected.get('cacheHitInput').idle[index] },
      cacheMissInput: { peak: collected.get('cacheMissInput').peak[index], idle: collected.get('cacheMissInput').idle[index] },
      output: { peak: collected.get('output').peak[index], idle: collected.get('output').idle[index] },
    };
    if (validEntry(entry)) models[modelIds[index]] = entry;
  }
  if (Object.keys(models).length === 0) return { ok: false, reason: 'no-valid-model' };

  return { ok: true, currency: CURRENCY, unit: TOKEN_UNIT, peakWindows: PEAK_WINDOWS, models };
}

/**
 * Convenience wrapper: strip then parse.
 * @param html - raw response body.
 * @returns the same result as {@link parsePricingTable}.
 */
export function parsePricingHtml(html) {
  return parsePricingTable(stripHtml(html));
}
