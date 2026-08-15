#!/usr/bin/env node
// Speed bench for htmlToPdf. Prints a machine-readable line the kernel
// optimiser can parse, plus a human summary.
//
// Metric: worst warm-median of the local example pages (landing + invoice).
// Falls back to docs/showcase.html when example/ is absent.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ITERATIONS = Math.max(3, Number.parseInt(process.env.BENCH_ITERATIONS || '5', 10));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.eot': 'application/vnd.ms-fontobject',
  '.pdf': 'application/pdf',
};

const EXAMPLES = [
  {
    name: 'landing',
    rel: 'example/templatemo_550_diagoona/index.html',
    viewport: { width: 1280, height: 800 },
  },
  {
    name: 'invoice',
    rel: 'example/Ivonne - Template/hotel-booking-invoice.html',
    viewport: { width: 794, height: 1200 },
  },
];

const FALLBACK = {
  name: 'showcase',
  rel: 'docs/showcase.html',
  viewport: { width: 1123, height: 794 },
};

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}

function withBase(html, baseUrl) {
  if (!baseUrl) return html;
  const href = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const tag = `<base href="${href}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, m => `${m}${tag}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, m => `${m}<head>${tag}</head>`);
  return `${tag}${html}`;
}

async function exists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const full = resolve(ROOT, `.${pathname === '/' ? '/demo/run.html' : pathname}`);
      if (!full.startsWith(ROOT)) return res.writeHead(403).end();
      if (!(await stat(full)).isFile()) throw new Error('Not a file');
      res.writeHead(200, {
        'Content-Type': MIME[extname(full)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
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
  const selected = [];
  for (const ex of EXAMPLES) {
    if (await exists(resolve(ROOT, ex.rel))) selected.push(ex);
  }
  if (!selected.length) selected.push(FALLBACK);

  const { server, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ args: ['--disable-lcd-text'] });

  try {
    const runner = await browser.newPage({ viewport: { width: 1280, height: 1123 }, deviceScaleFactor: 1 });
    await runner.goto(`${origin}/demo/run.html`, { waitUntil: 'networkidle' });
    await runner.evaluate(() => import('/src/index.js'));

    const fixtures = [];
    for (const ex of selected) {
      const htmlPath = resolve(ROOT, ex.rel);
      const raw = await readFile(htmlPath, 'utf8');
      const dir = dirname(ex.rel).replace(/\\/g, '/');
      const html = withBase(raw, `${origin}/${dir}/`);

      async function generate() {
        return runner.evaluate(async ({ htmlString, viewport }) => {
          const { htmlToPdf } = await import('/src/index.js');
          const started = performance.now();
          const bytes = await htmlToPdf(htmlString, { viewport });
          const elapsed = performance.now() - started;
          return { elapsed, bytes: bytes.byteLength };
        }, { htmlString: html, viewport: ex.viewport });
      }

      const cold = await generate();
      await generate();
      const times = [];
      let lastBytes = cold.bytes;
      for (let i = 0; i < ITERATIONS; i++) {
        const result = await generate();
        times.push(result.elapsed);
        lastBytes = result.bytes;
      }
      fixtures.push({
        name: ex.name,
        path: ex.rel,
        viewport: ex.viewport,
        coldMs: Number(cold.elapsed.toFixed(1)),
        warmMedianMs: Number(percentile(times, 0.5).toFixed(1)),
        warmP95Ms: Number(percentile(times, 0.95).toFixed(1)),
        minMs: Number(Math.min(...times).toFixed(1)),
        samplesMs: times.map(v => Number(v.toFixed(1))),
        pdfBytes: lastBytes,
      });
    }

    const warmMedianMs = Math.max(...fixtures.map(f => f.warmMedianMs));
    const payload = {
      warm_median_ms: warmMedianMs,
      fixtures,
      iterations: ITERATIONS,
    };

    await mkdir(resolve(ROOT, 'benchmark'), { recursive: true });
    await writeFile(resolve(ROOT, 'benchmark', 'speed.json'), `${JSON.stringify(payload, null, 2)}\n`);

    console.log(`[bench] ${JSON.stringify({ warm_median_ms: warmMedianMs })}`);
    console.log(JSON.stringify(payload, null, 2));
  } finally {
    await browser.close();
    await new Promise(resolveClosed => server.close(resolveClosed));
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
