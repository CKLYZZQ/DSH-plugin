/**
 * Parser tests for the Host half.
 *
 * `fixture-pricing.html` is a verbatim copy of the official page captured by
 * `tests/fetch-fixture.cjs`, so these assertions pin the real document shape
 * the parser must keep handling. Re-running the fetch script is what updates
 * the fixture (and the expected numbers) after an official price change.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PEAK_WINDOWS, parsePricingHtml, parsePricingTable, stripHtml } from '../pricing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(path.join(here, 'fixture-pricing.html'), 'utf8');

test('the real page parses into a complete, well-formed table', () => {
  const parsed = parsePricingHtml(fixture);
  assert.equal(parsed.ok, true, `expected a parseable table, got ${JSON.stringify(parsed)}`);
  assert.equal(parsed.currency, 'CNY');
  assert.equal(parsed.unit, 1000000);
  assert.deepEqual(parsed.peakWindows, PEAK_WINDOWS);
  assert.ok(Object.keys(parsed.models).length >= 1, 'at least one model');
});

test('the real page yields the documented per-model prices', () => {
  const parsed = parsePricingHtml(fixture);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.models['deepseek-flash'], {
    cacheHitInput: { peak: 0.04, idle: 0.02 },
    cacheMissInput: { peak: 2, idle: 1 },
    output: { peak: 8, idle: 4 },
  });
  assert.deepEqual(parsed.models['deepseek-v4-pro'], {
    cacheHitInput: { peak: 0.3, idle: 0.15 },
    cacheMissInput: { peak: 9, idle: 4.5 },
    output: { peak: 27, idle: 13.5 },
  });
});

test('a price row is recognised structurally, so the output-length row is ignored', () => {
  const text = stripHtml(fixture);
  // The page carries a `输出长度 | 最大 384K` row; it must not become the output price.
  const parsed = parsePricingTable(text);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.models['deepseek-flash'].output.peak < 1000, 'output price is a price, not a token cap');
});

test('unrelated and empty documents fail closed instead of returning a partial table', () => {
  assert.equal(parsePricingTable('').ok, false);
  assert.equal(parsePricingTable('   ').ok, false);
  assert.equal(parsePricingTable(null).ok, false);
  assert.deepEqual(parsePricingTable('<p>hello</p>'), { ok: false, reason: 'no-model-header' });
  const headerOnly = '模型\tdeepseek-flash\t\t\n基础价格\t\n';
  assert.equal(parsePricingTable(headerOnly).ok, false);
});

test('a table whose prices are missing a window is rejected whole', () => {
  const text = [
    '模型\tdeepseek-flash',
    '百万tokens输入（缓存命中）\t空闲时段\t0.02元',
    '百万tokens输入（缓存未命中）\t空闲时段\t1元\t高峰时段\t2元',
  ].join('\n');
  const parsed = parsePricingTable(text);
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /missing-price-row/);
});

test('stripHtml turns cells into tabs and keeps a br-split label in one cell', () => {
  const projected = stripHtml('<table><tr><td>百万tokens输入<br>（缓存命中）</td><td>0.02元</td></tr></table>');
  const rowLine = projected.split('\n').find((line) => line.includes('百万tokens输入'));
  assert.ok(rowLine !== undefined, 'the labelled row survives as one line');
  const rowCells = rowLine.split('\t').map((cell) => cell.trim()).filter((cell) => cell !== '');
  assert.deepEqual(rowCells, ['百万tokens输入 （缓存命中）', '0.02元']);
  assert.equal(stripHtml('<td>&amp;&nbsp;&lt;</td>'), '\t& <\t');
});

test('sanity check: the current price table maps one million idle input tokens to its unit price', () => {
  const parsed = parsePricingHtml(fixture);
  const flash = parsed.models['deepseek-flash'];
  const tokens = 1000000;
  assert.equal((tokens * flash.cacheMissInput.idle) / parsed.unit, 1);
  assert.equal((tokens * flash.cacheMissInput.peak) / parsed.unit, 2);
});
