/** Temporary structural dump used while tuning the parser. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePricingTable, stripHtml } from '../pricing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, 'fixture-pricing.html'), 'utf8');
const text = stripHtml(html);
const lines = text.split('\n');
lines.forEach((line, index) => {
  if (/模型|时段|tokens|tokens输入|输出/.test(line) && line.trim() !== '') {
    console.log(String(index).padStart(4), JSON.stringify(line.slice(0, 220)));
  }
});
console.log('--- parse result ---');
console.log(JSON.stringify(parsePricingTable(text), null, 2).slice(0, 1200));
