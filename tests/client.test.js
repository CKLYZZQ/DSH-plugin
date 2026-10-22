/**
 * Client-half tests.
 *
 * `client.js` is a browser bundle: it registers a factory with the page's
 * module loader at import time. The test therefore installs a minimal
 * `window.__ModuleLoader__` stub plus a `require` stub, captures the factory,
 * and exercises the pure pricing surface it exposes as `__billing`. No React
 * component is rendered and no DOM is emulated.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec;
    },
  },
};

const requireShim = (name) => {
  if (name === 'react') {
    return {
      createElement: () => null,
      memo: (component) => component,
      useState: () => [null, () => {}],
      useRef: () => ({ current: null }),
      useEffect: () => {},
      useMemo: (factory) => factory(),
    };
  }
  if (name === 'react-dom') return { createPortal: () => null };
  throw new Error(`unexpected require(${JSON.stringify(name)})`);
};

await import('../client.js');
assert.ok(captured !== null, 'the bundle registered itself with the module loader');
const plugin = captured.factory(requireShim);
const B = plugin.__billing;

const MONDAY_PEAK = new Date('2026-10-12T10:00:00+08:00').getTime();
const MONDAY_GAP = new Date('2026-10-12T12:30:00+08:00').getTime();
const MONDAY_AFTERNOON = new Date('2026-10-12T15:00:00+08:00').getTime();
const MONDAY_EARLY = new Date('2026-10-12T08:00:00+08:00').getTime();
const SATURDAY = new Date('2026-10-17T10:00:00+08:00').getTime();
const SUNDAY = new Date('2026-10-11T10:00:00+08:00').getTime();

function turn(number, at, usage) {
  return [number, { turn: number, start: { time: at }, data: new Map([['turn-tail', { tokenUsage: usage }]]) }];
}

test('the client module id equals the package name (the loader requires it)', () => {
  // A renamed package whose bundle keeps the old id never loads: the Host half
  // activates while the dock entry silently never registers.
  assert.equal(captured.id, manifest.name);
});

test('the factory exposes the plugin contract and a test-only surface', () => {
  assert.deepEqual(plugin.inject, ['slots', 'locale']);
  assert.equal(typeof plugin.apply, 'function');
  assert.equal(typeof B.classifyWindow, 'function');
});

test('peak/idle follows Beijing weekday windows, and holidays count as idle', () => {
  assert.equal(B.classifyWindow(MONDAY_PEAK, []), 'peak');
  assert.equal(B.classifyWindow(MONDAY_AFTERNOON, []), 'peak');
  assert.equal(B.classifyWindow(MONDAY_GAP, []), 'idle');
  assert.equal(B.classifyWindow(MONDAY_EARLY, []), 'idle');
  assert.equal(B.classifyWindow(SATURDAY, []), 'idle');
  assert.equal(B.classifyWindow(SUNDAY, []), 'idle');
  assert.equal(B.classifyWindow(MONDAY_PEAK, ['2026-10-12']), 'idle');
});

test('bucket pricing uses the official idle/peak rates and the 1e6 unit', () => {
  const flash = B.BASELINE.models['deepseek-flash'];
  const uncached = { uncachedInputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  const cached = { uncachedInputTokens: 0, cacheReadTokens: 1000000, cacheWriteTokens: 0, outputTokens: 0 };
  const out = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1000000 };
  assert.equal(B.priceBuckets(uncached, flash, 'idle'), 1);
  assert.equal(B.priceBuckets(uncached, flash, 'peak'), 2);
  assert.equal(B.priceBuckets(cached, flash, 'idle'), 0.02);
  assert.equal(B.priceBuckets(out, flash, 'idle'), 4);
  assert.equal(B.priceBuckets(out, flash, 'peak'), 8);
  // Cache writes are not in the official table and must not add cost.
  assert.equal(B.priceBuckets({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1000000, outputTokens: 0 }, flash, 'peak'), 0);
});

test('model lookup honours the documented legacy aliases and refuses unknown ids', () => {
  const models = B.BASELINE.models;
  assert.equal(B.lookupModel(models, 'deepseek-flash'), 'deepseek-flash');
  assert.equal(B.lookupModel(models, 'DEEPSEEK-FLASH'), 'deepseek-flash');
  assert.equal(B.lookupModel(models, 'deepseek-v4-flash'), 'deepseek-flash');
  assert.equal(B.lookupModel(models, 'deepseek-v4-flash-vision-exp'), 'deepseek-flash');
  assert.equal(B.lookupModel(models, 'deepseek-chat'), null);
  assert.equal(B.lookupModel(models, ''), null);
});

test('a malformed Host payload is rejected instead of mispricing', () => {
  assert.equal(B.validatePricesPayload(null), null);
  assert.equal(B.validatePricesPayload({ ok: false, reason: 'x' }), null);
  assert.equal(B.validatePricesPayload({ ok: true, models: {} }), null);
  const good = { cacheHitInput: { peak: 1, idle: 0.5 }, cacheMissInput: { peak: 2, idle: 1 }, output: { peak: 4, idle: 2 } };
  const accepted = B.validatePricesPayload({ ok: true, source: 's', fetchedAt: 't', models: { m: good, broken: { output: { peak: 1 } } } });
  assert.deepEqual(Object.keys(accepted.models), ['m']);
  assert.deepEqual(Object.keys(B.validatePricesPayload({ ok: true, overrides: { o: good } }).overrides), ['o']);
});

test('readTurns tolerates an absent or foreign timeline shape', () => {
  assert.equal(B.readTurns(null), null);
  assert.equal(B.readTurns({}), null);
  assert.equal(B.readTurns({ turns: {} }), null);
  assert.equal(B.readTurns({ turns: new Map() }), null);
  const rows = B.readTurns({ turns: new Map([turn(1, MONDAY_PEAK, { uncachedInputTokens: 5, outputTokens: 1, routes: [{ provider: 'p', model: 'deepseek-flash' }] })]) });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].turn, 1);
  assert.equal(rows[0].at, MONDAY_PEAK);
  assert.deepEqual(rows[0].routes, [{ provider: 'p', model: 'deepseek-flash' }]);
});

test('an exact session prices every loaded turn by its own route', () => {
  const usage = { uncachedInputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  const timeline = { turns: new Map([turn(1, MONDAY_PEAK, { uncachedInputTokens: 1000000, outputTokens: 0, routes: [{ provider: 'deepseek', model: 'deepseek-flash' }] })]) };
  const summary = B.summarize({
    usage,
    selection: { lastUsed: { provider: 'deepseek', model: 'deepseek-flash' } },
    timeline,
    fetched: null,
    holidays: [],
    nowMs: MONDAY_PEAK,
  });
  assert.equal(summary.hasUsage, true);
  assert.equal(summary.exact, true);
  assert.equal(summary.scopeLabel, 'turns');
  assert.equal(summary.amount, 2, 'one million uncached input tokens at the peak rate');
  assert.equal(summary.rateModel, 'deepseek-flash');
  assert.equal(summary.rateKind, 'peak');
  assert.equal(summary.rows.length, 1);
  assert.equal(summary.rows[0].cost, 2);
  assert.equal(summary.rows[0].model, 'deepseek-flash');
});

test('a partially loaded session falls back to the whole-log total and is marked approximate', () => {
  const usage = { uncachedInputTokens: 2000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  const timeline = { turns: new Map([turn(9, MONDAY_PEAK, { uncachedInputTokens: 1000000, outputTokens: 0, routes: [{ provider: 'deepseek', model: 'deepseek-flash' }] })]) };
  const summary = B.summarize({
    usage,
    selection: { lastUsed: { provider: 'deepseek', model: 'deepseek-flash' } },
    timeline,
    fetched: null,
    holidays: [],
    nowMs: MONDAY_PEAK,
  });
  assert.equal(summary.exact, false);
  assert.equal(summary.scopeLabel, 'session');
  assert.equal(summary.total, 2000000);
  assert.equal(summary.amount, 4, 'the whole-log total is priced, not the loaded window alone');
});

test('a model outside the price table yields no invented amount', () => {
  const usage = { uncachedInputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  const summary = B.summarize({
    usage,
    selection: { lastUsed: { provider: 'acme', model: 'mystery-1' } },
    timeline: null,
    fetched: null,
    holidays: [],
    nowMs: MONDAY_PEAK,
  });
  assert.equal(summary.hasUsage, true);
  assert.equal(summary.amount, null);
  assert.equal(summary.rateModel, null);
});

test('an empty session renders nothing', () => {
  assert.equal(B.summarize({ usage: undefined, selection: null, timeline: null, fetched: null, holidays: [], nowMs: MONDAY_PEAK }).hasUsage, false);
  assert.equal(B.summarize({
    usage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    selection: null,
    timeline: null,
    fetched: null,
    holidays: [],
    nowMs: MONDAY_PEAK,
  }).hasUsage, false);
});

test('the Host payload overrides the bundled baseline and drops its invalid entries', () => {
  const usage = { uncachedInputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  const fetched = B.validatePricesPayload({
    ok: true,
    source: 'https://example.test/pricing',
    fetchedAt: '2026-10-12T02:00:00.000Z',
    overrides: { 'deepseek-flash': { cacheHitInput: { peak: 9, idle: 9 }, cacheMissInput: { peak: 3, idle: 3 }, output: { peak: 9, idle: 9 } } },
  });
  const summary = B.summarize({
    usage,
    selection: { lastUsed: { provider: 'deepseek', model: 'deepseek-flash' } },
    timeline: null,
    fetched,
    holidays: [],
    nowMs: MONDAY_PEAK,
  });
  assert.equal(summary.amount, 3, 'the patch override wins over the baseline');
});

test('money formatting keeps a sub-cent amount honest', () => {
  assert.equal(B.money(null, 2), '--');
  assert.equal(B.money(0, 2), '¥0.00');
  assert.equal(B.money(0.001, 2), '<¥0.01');
  assert.equal(B.money(1.239, 2), '¥1.24');
  assert.equal(B.money(0.0123, 4), '¥0.0123');
});

test('timestamps render as local MM-DD HH:mm, not raw ISO', () => {
  const rendered = B.formatWhen('2026-10-22T06:48:37.262Z');
  assert.match(rendered, /^\d{2}-\d{2} \d{2}:\d{2}$/, rendered);
  assert.equal(B.formatWhen(''), '');
  assert.equal(B.formatWhen(undefined), '');
  assert.equal(B.formatWhen('not-a-date'), 'not-a-date');
});
