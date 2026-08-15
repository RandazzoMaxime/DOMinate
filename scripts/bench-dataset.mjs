#!/usr/bin/env node
// Local-only dataset bench. HTML stays in example/ (gitignored).
// Every fixture is timed on the same engines as scripts/bench-compare.mjs.

import { chromium } from 'playwright';
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pdfPageCount } from './pdf-to-png.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'benchmark');
const A4 = { width: 794, height: 1123 };
const ITER_SMALL = Math.max(3, Number.parseInt(process.env.BENCH_ITERATIONS || '5', 10));
const ITER_LARGE = 3;

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
};

const LIB = {
  html2canvas: '/node_modules/html2canvas/dist/html2canvas.min.js',
  jspdf: '/node_modules/jspdf/dist/jspdf.umd.min.js',
  htmlToImage: '/node_modules/html-to-image/dist/html-to-image.js',
  html2pdf: '/node_modules/html2pdf.js/dist/html2pdf.bundle.min.js',
};

const ENGINES = [
  { key: 'dominate', label: 'DOMinate' },
  { key: 'html2canvas', label: 'html2canvas + jsPDF' },
  { key: 'html2pdf', label: 'html2pdf.js' },
  { key: 'htmltoimage', label: 'html-to-image + jsPDF' },
  { key: 'jspdfhtml', label: 'jsPDF.html()' },
  { key: 'playwright', label: 'Playwright page.pdf' },
  { key: 'puppeteer', label: 'Puppeteer page.pdf' },
];

const EXISTING = [
  {
    id: 'landing',
    rel: 'example/templatemo_550_diagoona/index.html',
    viewport: { width: 1280, height: 800 },
    kind: 'existing-landing',
    source: 'local template (already used in README)',
  },
  {
    id: 'invoice',
    rel: 'example/Ivonne - Template/hotel-booking-invoice.html',
    viewport: { width: 794, height: 1200 },
    kind: 'existing-invoice',
    source: 'local template (already used in README)',
  },
  {
    id: 'sow',
    rel: 'example/dominate-sow.html',
    viewport: A4,
    kind: 'existing-sow',
    source: 'local 4-page SOW fixture',
  },
];

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
  await new Promise(ready => server.listen(0, '127.0.0.1', ready));
  return { server, port: server.address().port };
}

function withBase(html, baseUrl) {
  if (!baseUrl || /<base\s/i.test(html)) return html;
  const href = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const tag = `<base href="${href}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, m => `${m}${tag}`);
  return `${tag}${html}`;
}

async function loadFixtures() {
  const fixtures = [];
  for (const row of EXISTING) {
    try {
      await stat(resolve(ROOT, row.rel));
      fixtures.push(row);
    } catch {
      console.error(`skip missing ${row.id}: ${row.rel}`);
    }
  }
  try {
    const manifest = JSON.parse(await readFile(resolve(ROOT, 'example/dataset/manifest.json'), 'utf8'));
    for (const row of manifest) {
      fixtures.push({
        id: row.id,
        rel: row.file,
        viewport: A4,
        kind: row.kind,
        source: row.url,
        bytes: row.bytes,
      });
    }
  } catch {
    console.error('example/dataset/manifest.json missing — run: node scripts/fetch-dataset.mjs');
  }
  return fixtures;
}

async function countPages(buf) {
  if (!buf || !buf.length) return 0;
  try {
    return await pdfPageCount(buf);
  } catch {
    return 0;
  }
}

async function summarize(buf, elapsedList) {
  const magic = buf && buf.subarray(0, 5).toString('latin1') === '%PDF-';
  return {
    ms: Number(percentile(elapsedList, 0.5).toFixed(1)),
    minMs: Number(Math.min(...elapsedList).toFixed(1)),
    pages: await countPages(buf),
    pdfKiB: buf ? Number((buf.length / 1024).toFixed(1)) : 0,
    ok: Boolean(magic),
  };
}

async function main() {
  const fixtures = await loadFixtures();
  if (fixtures.length < 10) {
    console.error(`need ≥10 fixtures, have ${fixtures.length}. Run node scripts/fetch-dataset.mjs`);
    process.exitCode = 1;
    return;
  }

  await mkdir(OUT, { recursive: true });
  const { server, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;
  let browser = await chromium.launch({ args: ['--disable-lcd-text'] });
  let pptr = await puppeteer.launch({
    executablePath: chromium.executablePath(),
    headless: true,
    args: ['--disable-lcd-text'],
  });

  let runner;
  async function ensureRunner() {
    if (!browser.isConnected()) {
      browser = await chromium.launch({ args: ['--disable-lcd-text'] });
    }
    if (!runner || runner.isClosed()) {
      runner = await browser.newPage({ viewport: { width: 1400, height: 1200 }, deviceScaleFactor: 1 });
      await runner.goto(`${origin}/demo/run.html`, { waitUntil: 'domcontentloaded' });
      await runner.evaluate(() => import('/src/index.js'));
    }
  }

  async function loadLibs(target) {
    await target.addScriptTag({ url: `${origin}${LIB.html2canvas}` });
    await target.addScriptTag({ url: `${origin}${LIB.jspdf}` });
    await target.addScriptTag({ url: `${origin}${LIB.htmlToImage}` });
    await target.evaluate(() => {
      window.__h2c = window.html2canvas;
      window.__jspdf = window.jspdf;
    });
    await target.addScriptTag({ url: `${origin}${LIB.html2pdf}` });
    await target.evaluate(() => {
      window.html2pdfLib = window.html2pdf;
      window.html2canvas = window.__h2c;
      window.jspdf = window.__jspdf;
    });
    await target.evaluate(() => document.fonts?.ready).catch(() => {});
  }

  async function openShot(fx) {
    if (!browser.isConnected()) {
      browser = await chromium.launch({ args: ['--disable-lcd-text'] });
    }
    const shot = await browser.newPage({ viewport: fx.viewport, deviceScaleFactor: 1 });
    await shot.goto(`${origin}/${fx.rel.replace(/\\/g, '/')}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await loadLibs(shot);
    return shot;
  }

  async function openPptr(fx) {
    if (!pptr.connected) {
      await pptr.close().catch(() => {});
      pptr = await puppeteer.launch({
        executablePath: chromium.executablePath(),
        headless: true,
        args: ['--disable-lcd-text'],
      });
    }
    const shot = await pptr.newPage();
    await shot.setViewport(fx.viewport);
    await shot.goto(`${origin}/${fx.rel.replace(/\\/g, '/')}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await shot.evaluate(() => document.fonts?.ready).catch(() => {});
    return shot;
  }

  const rows = [];
  try {
    await ensureRunner();

    for (const fx of fixtures) {
    try {
      await ensureRunner();
      const raw = await readFile(resolve(ROOT, fx.rel), 'utf8');
      const dir = dirname(fx.rel).replace(/\\/g, '/');
      const html = withBase(raw, `${origin}/${dir}/`);
      const large = (fx.bytes || Buffer.byteLength(raw)) > 280_000 || fx.kind === 'book' || fx.kind === 'spec';
      const iters = large ? ITER_LARGE : ITER_SMALL;
      const limit = large ? 120_000 : 45_000;
      const engines = {};

      async function dominateOnce() {
        return runner.evaluate(async ({ htmlString, viewport, baseUrl }) => {
          const { htmlToPdf } = await import('/src/index.js');
          const t0 = performance.now();
          const bytes = await htmlToPdf(htmlString, { viewport, baseUrl });
          const elapsed = performance.now() - t0;
          let binary = '';
          for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
          }
          return { elapsed, base64: btoa(binary) };
        }, { htmlString: html, viewport: fx.viewport, baseUrl: `${origin}/${dir}/` });
      }

      let page = await openShot(fx);
      let pptrPage = await openPptr(fx);
      try {

        const printOpts = fx.id === 'landing'
          ? {
            width: `${fx.viewport.width}px`,
            height: `${fx.viewport.height}px`,
            printBackground: true,
            margin: { top: '0', right: '0', bottom: '0', left: '0' },
          }
          : { format: 'A4', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } };

        const runners = {
          dominate: async () => {
            const t0 = performance.now();
            const out = await dominateOnce();
            return { elapsed: out.elapsed, bytes: Buffer.from(out.base64, 'base64'), wall: performance.now() - t0 };
          },
          html2canvas: async () => {
            const t0 = performance.now();
            const b64 = await page.evaluate(async ({ vw, vh }) => {
              const canvas = await html2canvas(document.documentElement, {
                scale: 1, useCORS: true, windowWidth: vw, windowHeight: vh, logging: false,
              });
              const JsPDF = window.jspdf?.jsPDF || window.jsPDF;
              const pdf = new JsPDF({ unit: 'px', format: [vw, vh], orientation: vh >= vw ? 'portrait' : 'landscape' });
              let y = 0;
              let first = true;
              while (y < canvas.height - 1) {
                if (!first) pdf.addPage([vw, vh], vh >= vw ? 'portrait' : 'landscape');
                first = false;
                const slice = document.createElement('canvas');
                slice.width = vw;
                slice.height = Math.min(vh, canvas.height - y);
                slice.getContext('2d').drawImage(canvas, 0, y, vw, slice.height, 0, 0, vw, slice.height);
                pdf.addImage(slice.toDataURL('image/jpeg', 0.85), 'JPEG', 0, 0, vw, slice.height);
                y += vh;
              }
              return pdf.output('datauristring').split(',')[1];
            }, { vw: fx.viewport.width, vh: fx.viewport.height });
            return { elapsed: performance.now() - t0, bytes: Buffer.from(b64, 'base64') };
          },
          html2pdf: async () => {
            const t0 = performance.now();
            const b64 = await page.evaluate(async ({ vw, vh }) => {
              const worker = window.html2pdfLib || window.html2pdf;
              const datauri = await worker().set({
                margin: 0,
                image: { type: 'jpeg', quality: 0.85 },
                html2canvas: { scale: 1, useCORS: true, logging: false, windowWidth: vw, windowHeight: vh },
                jsPDF: { unit: 'px', format: [vw, vh], orientation: vh >= vw ? 'portrait' : 'landscape' },
                pagebreak: { mode: ['css', 'legacy'] },
              }).from(document.documentElement).outputPdf('datauristring');
              return String(datauri).split(',').pop();
            }, { vw: fx.viewport.width, vh: fx.viewport.height });
            return { elapsed: performance.now() - t0, bytes: Buffer.from(b64, 'base64') };
          },
          htmltoimage: async () => {
            const t0 = performance.now();
            const b64 = await page.evaluate(async ({ vw, vh }) => {
              const el = document.documentElement;
              const dataUrl = await window.htmlToImage.toJpeg(el, {
                quality: 0.85,
                pixelRatio: 1,
                backgroundColor: '#ffffff',
                width: el.scrollWidth,
                height: el.scrollHeight,
              });
              const img = new Image();
              img.src = dataUrl;
              await img.decode();
              const JsPDF = window.jspdf.jsPDF;
              const pdf = new JsPDF({ unit: 'px', format: [vw, vh], orientation: vh >= vw ? 'portrait' : 'landscape' });
              let y = 0;
              let first = true;
              while (y < img.height - 1) {
                if (!first) pdf.addPage([vw, vh], vh >= vw ? 'portrait' : 'landscape');
                first = false;
                const slice = document.createElement('canvas');
                slice.width = vw;
                slice.height = Math.min(vh, img.height - y);
                slice.getContext('2d').drawImage(img, 0, y, vw, slice.height, 0, 0, vw, slice.height);
                pdf.addImage(slice.toDataURL('image/jpeg', 0.85), 'JPEG', 0, 0, vw, slice.height);
                y += vh;
              }
              return pdf.output('datauristring').split(',')[1];
            }, { vw: fx.viewport.width, vh: fx.viewport.height });
            return { elapsed: performance.now() - t0, bytes: Buffer.from(b64, 'base64') };
          },
          jspdfhtml: async () => {
            const t0 = performance.now();
            const b64 = await page.evaluate(async ({ vw, vh }) => {
              const { jsPDF } = window.jspdf;
              const pdf = new jsPDF({
                unit: 'px',
                format: [vw, vh],
                orientation: vh >= vw ? 'portrait' : 'landscape',
              });
              await pdf.html(document.documentElement, {
                margin: 0,
                autoPaging: 'slice',
                html2canvas: { scale: 1, useCORS: true, logging: false, windowWidth: vw },
                width: vw,
                windowWidth: vw,
                x: 0,
                y: 0,
              });
              return pdf.output('datauristring').split(',')[1];
            }, { vw: fx.viewport.width, vh: fx.viewport.height });
            return { elapsed: performance.now() - t0, bytes: Buffer.from(b64, 'base64') };
          },
          playwright: async () => {
            const t0 = performance.now();
            const bytes = await page.pdf(printOpts);
            return { elapsed: performance.now() - t0, bytes: Buffer.from(bytes) };
          },
          puppeteer: async () => {
            const t0 = performance.now();
            const bytes = await pptrPage.pdf(printOpts);
            return { elapsed: performance.now() - t0, bytes: Buffer.from(bytes) };
          },
        };

        for (const engine of ENGINES) {
          process.stderr.write(`  ${fx.id} ${engine.key}…\n`);
          try {
            if (page.isClosed()) page = await openShot(fx);
            if (pptrPage.isClosed()) pptrPage = await openPptr(fx);
            await ensureRunner();
            await withTimeout(runners[engine.key](), limit, engine.key);
            const times = [];
            let last = null;
            for (let i = 0; i < iters; i++) {
              last = await withTimeout(runners[engine.key](), limit, engine.key);
              times.push(last.elapsed);
            }
            engines[engine.key] = await summarize(last.bytes, times);
          } catch (error) {
            engines[engine.key] = { ms: null, minMs: null, pages: 0, pdfKiB: 0, ok: false, error: error.message };
            console.error(`  ${fx.id} ${engine.key} FAIL ${error.message}`);
            await page.close().catch(() => {});
            await pptrPage.close().catch(() => {});
            page = await openShot(fx);
            pptrPage = await openPptr(fx);
          }
        }
      } finally {
        await page.close().catch(() => {});
        await pptrPage.close().catch(() => {});
      }

      const row = {
        id: fx.id,
        kind: fx.kind,
        source: fx.source,
        htmlKiB: Number((Buffer.byteLength(raw) / 1024).toFixed(1)),
        iterations: iters,
        engines,
      };
      rows.push(row);

      const cell = (key) => {
        const e = engines[key];
        if (!e) return 'n/a'.padStart(8);
        if (!e.ok) return 'FAIL'.padStart(8);
        return `${e.ms.toFixed(0)}ms`.padStart(8);
      };
      const pages = engines.dominate?.pages || 0;
      console.log(
        `${fx.id.padEnd(22)}${String(pages).padStart(4)}p `
        + `dom ${cell('dominate')}  h2c ${cell('html2canvas')}  h2p ${cell('html2pdf')}  `
        + `hti ${cell('htmltoimage')}  jsh ${cell('jspdfhtml')}  `
        + `pw ${cell('playwright')}  pptr ${cell('puppeteer')}`,
      );
    } catch (error) {
      console.error(`  ${fx.id} fixture FAIL ${error.message}`);
      rows.push({
        id: fx.id,
        kind: fx.kind,
        source: fx.source,
        error: error.message,
        engines: Object.fromEntries(ENGINES.map(e => [e.key, { ok: false, error: error.message, ms: null, pages: 0, pdfKiB: 0 }])),
      });
    }
    }
  } finally {
    await browser.close();
    await pptr.close();
    await new Promise(done => server.close(done));
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    note: 'Local web-HTML dataset vs the same engines as bench-compare. Source HTML is not published.',
    engines: ENGINES,
    fixtures: rows,
  };
  await writeFile(resolve(OUT, 'dataset.json'), `${JSON.stringify(payload, null, 2)}\n`);

  const okDom = rows.filter(r => r.engines.dominate?.ok);
  const long = okDom.filter(r => (r.engines.dominate.pages || 0) >= 40);
  console.log('');
  console.log(`${okDom.length}/${rows.length} fixtures converted by DOMinate.`);
  console.log(`≥40-page docs: ${long.map(r => `${r.id} ${r.engines.dominate.pages}p ${r.engines.dominate.ms}ms`).join(', ') || 'none'}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
