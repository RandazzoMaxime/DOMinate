#!/usr/bin/env node

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rasterize } from './pdf-to-png.mjs';
import { diffPngs } from './diff.mjs';
import { auditPdf } from './audit.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'benchmark');
const ASSETS = resolve(ROOT, 'docs', 'assets');
const ITERATIONS = Math.max(3, Number.parseInt(process.env.BENCH_ITERATIONS || '7', 10));
const VIEWPORT = { width: 1123, height: 794 };
const EXPECTATIONS = {
  expectedLinks: [
    'https://github.com/RandazzoMaxime/DOMinate',
    'https://github.com/RandazzoMaxime/DOMinate/blob/main/USAGE.md',
    'https://github.com/RandazzoMaxime/DOMinate',
  ],
  expectedTextFragments: [
    'DOMinate',
    'HTML in.',
    'Real PDF out.',
    'Selectable by design',
    'Vector where it matters',
    'Documents that work',
    'runtime dependencies',
  ],
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.woff2': 'font/woff2', '.pdf': 'application/pdf',
};

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}

function stats(values) {
  return {
    medianMs: Number(percentile(values, 0.5).toFixed(1)),
    p95Ms: Number(percentile(values, 0.95).toFixed(1)),
    minMs: Number(Math.min(...values).toFixed(1)),
    samplesMs: values.map(value => Number(value.toFixed(1))),
  };
}

async function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const full = resolve(ROOT, `.${pathname === '/' ? '/demo/run.html' : pathname}`);
      if (!full.startsWith(ROOT)) return res.writeHead(403).end();
      if (!(await stat(full)).isFile()) throw new Error('Not a file');
      res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(await readFile(full));
    } catch (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(error.message);
    }
  });
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
  return { server, port: server.address().port };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await mkdir(ASSETS, { recursive: true });
  const html = await readFile(resolve(ROOT, 'docs', 'showcase.html'), 'utf8');
  const { server, port } = await startServer();
  const browser = await chromium.launch({ args: ['--disable-lcd-text'] });

  try {
    const showcase = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await showcase.goto(`http://127.0.0.1:${port}/docs/showcase.html`, { waitUntil: 'networkidle' });
    await showcase.evaluate(() => document.fonts.ready);
    await showcase.screenshot({ path: resolve(ASSETS, 'showcase-html.png') });

    const runner = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await runner.goto(`http://127.0.0.1:${port}/demo/run.html`, { waitUntil: 'networkidle' });
    await runner.evaluate(() => import('/src/index.js'));

    async function generate() {
      return runner.evaluate(async ({ htmlString, viewport }) => {
        const { htmlToPdf } = await import('/src/index.js');
        const started = performance.now();
        const bytes = await htmlToPdf(htmlString, { viewport });
        const elapsed = performance.now() - started;
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return { elapsed, base64: btoa(binary) };
      }, { htmlString: html, viewport: VIEWPORT });
    }

    const cold = await generate();
    await generate();
    const times = [];
    let bytes = Buffer.from(cold.base64, 'base64');
    for (let i = 0; i < ITERATIONS; i++) {
      const result = await generate();
      times.push(result.elapsed);
      bytes = Buffer.from(result.base64, 'base64');
    }

    const pdfPath = resolve(OUT, 'dominate-showcase.pdf');
    await writeFile(pdfPath, bytes);
    await rasterize(pdfPath, resolve(ASSETS, 'showcase-pdf.png'), { dpi: 96 });
    const diff = await diffPngs(
      resolve(ASSETS, 'showcase-html.png'),
      resolve(ASSETS, 'showcase-pdf.png'),
      resolve(OUT, 'dominate-showcase.diff.png'),
    );
    const audit = await auditPdf(pdfPath, EXPECTATIONS);
    if (audit.links !== EXPECTATIONS.expectedLinks.length || !audit.textOk || !audit.fontsOk) {
      throw new Error(`PDF audit failed: ${JSON.stringify(audit)}`);
    }

    const results = {
      generatedAt: new Date().toISOString(),
      fixture: 'docs/showcase.html',
      viewport: VIEWPORT,
      iterations: ITERATIONS,
      environment: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        captureChromium: browser.version(),
      },
      dominate: {
        coldMs: Number(cold.elapsed.toFixed(1)),
        ...stats(times),
        pdfBytes: bytes.byteLength,
        pixelDiffPercent: Number(diff.percent.toFixed(3)),
        links: `${audit.links}/${EXPECTATIONS.expectedLinks.length}`,
        text: audit.textOk ? 'ok' : 'fail',
        fonts: audit.fontsOk ? 'ok' : 'missing',
      },
      methodology: 'HTML screenshot and DOMinate PDF rasterized at 96 DPI; one cold call, one warm-up, then seven steady-state samples by default.',
    };
    await writeFile(resolve(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
    console.log(JSON.stringify(results, null, 2));
  } finally {
    await browser.close();
    await new Promise(resolveClosed => server.close(resolveClosed));
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
