/**
 * Refresh the parser test fixture from the official pricing page.
 *
 * Run from the package directory:  node tests/fetch-fixture.cjs
 *
 * The fixture is a verbatim copy of the public page, so the parser test proves
 * the real document parses; it is not a hand-written approximation.
 */
const fs = require('node:fs');
const path = require('node:path');

const URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
const target = path.join(__dirname, 'fixture-pricing.html');

async function main() {
  const response = await fetch(URL, { headers: { 'user-agent': 'dsh-billing/0.1.0 (fixture fetch)' } });
  console.log('status', response.status);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  fs.writeFileSync(target, html, 'utf8');
  console.log('bytes', html.length, '->', target);
}

main().catch((error) => {
  console.error('ERR', error && error.message);
  process.exit(1);
});
