#!/usr/bin/env node
// Download public HTML pages into example/dataset/ (gitignored). Local bench only.

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(ROOT, 'example', 'dataset');

const PAGES = [
  { id: 'wikipedia-html', url: 'https://en.wikipedia.org/wiki/HTML', kind: 'article' },
  { id: 'wikipedia-pdf', url: 'https://en.wikipedia.org/wiki/PDF', kind: 'article' },
  { id: 'wikipedia-css', url: 'https://en.wikipedia.org/wiki/CSS', kind: 'article' },
  { id: 'wikipedia-invoice', url: 'https://en.wikipedia.org/wiki/Invoice', kind: 'article' },
  { id: 'gutenberg-carol', url: 'https://www.gutenberg.org/files/46/46-h/46-h.htm', kind: 'book' },
  { id: 'gutenberg-frank', url: 'https://www.gutenberg.org/files/84/84-h/84-h.htm', kind: 'book' },
  { id: 'rfc793', url: 'https://www.rfc-editor.org/rfc/rfc793.html', kind: 'spec' },
  { id: 'cern-www', url: 'https://info.cern.ch/hypertext/WWW/TheProject.html', kind: 'historic' },
  { id: 'w3-png', url: 'https://www.w3.org/TR/2003/REC-PNG-20031110/', kind: 'spec' },
  { id: 'example-com', url: 'https://example.com/', kind: 'minimal' },
];

const UA = 'DOMinateDataset/1.0 (local benchmark)';

await mkdir(DIR, { recursive: true });
const manifest = [];

for (const page of PAGES) {
  try {
    const res = await fetch(page.url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let html = await res.text();
    const finalUrl = res.url || page.url;
    const base = new URL('.', finalUrl).href;
    if (!/<base\s/i.test(html)) {
      const tag = `<base href="${base}">`;
      html = /<head[^>]*>/i.test(html)
        ? html.replace(/<head[^>]*>/i, m => `${m}${tag}`)
        : `${tag}${html}`;
    }
    const file = `${page.id}.html`;
    await writeFile(resolve(DIR, file), html, 'utf8');
    const bytes = Buffer.byteLength(html);
    console.log(`ok  ${page.id.padEnd(22)} ${(bytes / 1024).toFixed(0).padStart(6)} KiB  ${finalUrl}`);
    manifest.push({
      id: page.id,
      file: `example/dataset/${file}`,
      url: page.url,
      finalUrl,
      kind: page.kind,
      bytes,
    });
  } catch (error) {
    console.log(`FAIL ${page.id}  ${error.message}`);
  }
}

await writeFile(resolve(DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`saved ${manifest.length}/${PAGES.length} → example/dataset/`);
