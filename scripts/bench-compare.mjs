#!/usr/bin/env node
// Competitive convert bench: DOMinate vs html2canvas+jsPDF vs Chromium page.pdf.
// Reports warm time AND worst-page pixel-diff vs the live HTML screenshot
// (same protocol as scripts/loop.mjs). Writes JSON + bar/curve SVGs.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rasterizeAll } from './pdf-to-png.mjs';
import { diffPngs } from './diff.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = resolve(ROOT, 'docs', 'assets');
const OUT = resolve(ROOT, 'benchmark');
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
  '.pdf': 'application/pdf',
};

const H2C = '/example/Ivonne%20-%20Template/assets/js/html2canvas.min.js';
const JSPDF = '/example/Ivonne%20-%20Template/assets/js/jspdf.min.js';

const ENGINES = [
  { key: 'dominate', label: 'DOMinate', color: '#55e59a' },
  { key: 'html2canvas', label: 'html2canvas + jsPDF', color: '#e07a5f' },
  { key: 'playwright', label: 'Chromium page.pdf', color: '#4edbff' },
];

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}

function stats(values) {
  return {
    medianMs: Number(percentile(values, 0.5).toFixed(1)),
    p95Ms: Number(percentile(values, 0.95).toFixed(1)),
    minMs: Number(Math.min(...values).toFixed(1)),
  };
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

function withBase(html, baseUrl) {
  const href = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const tag = `<base href="${href}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, m => `${m}${tag}`);
  return tag + html;
}

function niceMax(maxV, stepHint) {
  if (maxV <= 0) return stepHint;
  const raw = maxV * 1.15;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) {
    const step = m * mag;
    if (step * 2 >= raw) return Math.ceil(raw / step) * step || stepHint;
  }
  return Math.ceil(raw / mag) * mag;
}

function barSvg(series, { title, unit, digits = 0, stepHint = 100 }) {
  const W = 920, H = 420, padL = 70, padR = 24, padT = 48, padB = 70;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const groupW = innerW / series.length;
  const barW = groupW / (ENGINES.length + 1);
  const maxV = Math.max(...series.flatMap(s => ENGINES.map(e => s.engines[e.key] || 0)), 0.01);
  const nice = niceMax(maxV, stepHint);
  const y = v => padT + innerH - (v / nice) * innerH;

  let bars = '';
  series.forEach((s, gi) => {
    const gx = padL + gi * groupW;
    ENGINES.forEach((e, ei) => {
      const v = s.engines[e.key] || 0;
      const x = gx + (ei + 0.5) * barW;
      const top = y(v);
      const h = Math.max(0, padT + innerH - top);
      bars += `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${(barW * 0.85).toFixed(1)}" height="${h.toFixed(1)}" fill="${e.color}" rx="3"/>`;
      bars += `<text x="${(x + barW * 0.42).toFixed(1)}" y="${(top - 6).toFixed(1)}" text-anchor="middle" font-size="11" fill="#d7e6ed">${v.toFixed(digits)}${unit === '%' && digits ? '' : ''}</text>`;
    });
    bars += `<text x="${(gx + groupW / 2).toFixed(1)}" y="${H - 36}" text-anchor="middle" font-size="13" fill="#f8fbfd">${s.name}</text>`;
  });

  const ticks = 5;
  let grid = '';
  for (let i = 0; i <= ticks; i++) {
    const v = (nice / ticks) * i;
    const yy = y(v);
    grid += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" stroke="#1d6179" stroke-opacity=".35"/>`;
    grid += `<text x="${padL - 8}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#a7b9c6">${v.toFixed(digits)}</text>`;
  }

  const legend = ENGINES.map((e, i) => {
    const x = padL + i * 210;
    return `<rect x="${x}" y="16" width="12" height="12" fill="${e.color}" rx="2"/><text x="${x + 18}" y="26" font-size="12" fill="#d7e6ed">${e.label}</text>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="100%" height="100%" fill="#06111b"/>
  <text x="${padL}" y="14" font-size="15" font-weight="700" fill="#f8fbfd">${title}</text>
  ${legend}
  ${grid}
  ${bars}
  <text x="${padL - 52}" y="${padT + innerH / 2}" fill="#a7b9c6" font-size="11" transform="rotate(-90 ${padL - 52} ${padT + innerH / 2})">${unit}</text>
</svg>
`;
}

function curveSvg(points, keys, { title, unit, digits = 0, stepHint = 100, xLabel = 'A4 pages dispatched' }) {
  const W = 920, H = 420, padL = 70, padR = 24, padT = 48, padB = 60;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const xs = points.map(p => p.pages);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const maxV = Math.max(...points.flatMap(p => keys.map(k => p[k] || 0)), 0.01);
  const nice = niceMax(maxV, stepHint);
  const x = v => padL + ((v - minX) / (maxX - minX || 1)) * innerW;
  const y = v => padT + innerH - (v / nice) * innerH;

  let grid = '';
  for (let i = 0; i <= 5; i++) {
    const v = (nice / 5) * i;
    const yy = y(v);
    grid += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" stroke="#1d6179" stroke-opacity=".35"/>`;
    grid += `<text x="${padL - 8}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#a7b9c6">${v.toFixed(digits)}</text>`;
  }
  for (const p of points) {
    grid += `<text x="${x(p.pages).toFixed(1)}" y="${H - 28}" text-anchor="middle" font-size="13" fill="#f8fbfd">${p.pages}p</text>`;
  }

  const lines = ENGINES.map(e => {
    const key = keys.find(k => k === e.key || k === `${e.key}Diff`);
    if (!key) return '';
    const d = points.map((p, i) => `${i ? 'L' : 'M'} ${x(p.pages).toFixed(1)} ${y(p[key] || 0).toFixed(1)}`).join(' ');
    const dots = points.map(p => `<circle cx="${x(p.pages).toFixed(1)}" cy="${y(p[key] || 0).toFixed(1)}" r="4.5" fill="${e.color}"/>`).join('');
    return `<path d="${d}" fill="none" stroke="${e.color}" stroke-width="2.4"/>${dots}`;
  }).join('');

  const legend = ENGINES.map((e, i) => {
    const lx = padL + i * 210;
    return `<rect x="${lx}" y="16" width="12" height="12" fill="${e.color}" rx="2"/><text x="${lx + 18}" y="26" font-size="12" fill="#d7e6ed">${e.label}</text>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="100%" height="100%" fill="#06111b"/>
  <text x="${padL}" y="14" font-size="15" font-weight="700" fill="#f8fbfd">${title}</text>
  ${legend}
  ${grid}
  ${lines}
  <text x="${padL - 52}" y="${padT + innerH / 2}" fill="#a7b9c6" font-size="11" transform="rotate(-90 ${padL - 52} ${padT + innerH / 2})">${unit}</text>
  <text x="${padL + innerW / 2}" y="${H - 10}" text-anchor="middle" font-size="12" fill="#a7b9c6">${xLabel}</text>
</svg>
`;
}

async function timeSamples(fn) {
  await fn();
  const times = [];
  let last = null;
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    last = await fn();
    times.push(performance.now() - t0);
  }
  return { ...stats(times), last };
}

async function worstPageDiff(shot, pdfBytes, viewport, tag) {
  const pdfPath = resolve(OUT, `_cmp-${tag}.pdf`);
  await writeFile(pdfPath, pdfBytes);
  const all = await rasterizeAll(pdfPath, { dpi: 96 });
  let worst = { percent: 0, page: 1, pages: [] };
  for (const page of all.pages) {
    const pdfPng = resolve(OUT, `_cmp-${tag}-p${page.index}.png`);
    const htmlPng = resolve(OUT, `_cmp-${tag}-h${page.index}.png`);
    const diffPng = resolve(OUT, `_cmp-${tag}-d${page.index}.png`);
    await writeFile(pdfPng, page.png);
    const y = (page.index - 1) * viewport.height;
    await shot.screenshot({
      path: htmlPng,
      fullPage: true,
      clip: { x: 0, y, width: viewport.width, height: viewport.height },
    });
    const diff = await diffPngs(htmlPng, pdfPng, diffPng);
    const row = { page: page.index, percent: Number(diff.percent.toFixed(3)), diffPx: diff.diffPx, totalPx: diff.totalPx };
    worst.pages.push(row);
    if (diff.percent > worst.percent) {
      worst.percent = Number(diff.percent.toFixed(3));
      worst.page = page.index;
    }
  }
  return { pageCount: all.pageCount, worstPercent: worst.percent, worstPage: worst.page, pages: worst.pages };
}

async function main() {
  await mkdir(ASSETS, { recursive: true });
  await mkdir(OUT, { recursive: true });
  const { server, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ args: ['--disable-lcd-text'] });

  const invoiceRel = 'example/Ivonne - Template/hotel-booking-invoice.html';
  const reportRel = 'example/dominate-sow.html';

  try {
    const runner = await browser.newPage({ viewport: { width: 900, height: 1200 }, deviceScaleFactor: 1 });
    await runner.goto(`${origin}/demo/run.html`, { waitUntil: 'networkidle' });
    await runner.evaluate(() => import('/src/index.js'));

    async function dominatePdf(rel, viewport) {
      const raw = await readFile(resolve(ROOT, rel), 'utf8');
      const dir = dirname(rel).replace(/\\/g, '/');
      const html = withBase(raw, `${origin}/${dir}/`);
      const base64 = await runner.evaluate(async ({ htmlString, viewport, baseUrl }) => {
        const { htmlToPdf } = await import('/src/index.js');
        const bytes = await htmlToPdf(htmlString, { viewport, baseUrl });
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return btoa(binary);
      }, { htmlString: html, viewport, baseUrl: `${origin}/${dir}/` });
      return Buffer.from(base64, 'base64');
    }

    async function openFixture(rel, viewport, keepSections) {
      const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
      await page.goto(`${origin}/${rel.replace(/\\/g, '/')}`, { waitUntil: 'networkidle' });
      if (keepSections != null) {
        await page.evaluate((n) => {
          for (let i = n + 1; i <= 4; i++) {
            const el = document.getElementById('sec-' + i);
            if (el) el.style.display = 'none';
          }
          document.querySelectorAll('.page-break').forEach((el, idx) => {
            if (idx >= n - 1) el.remove();
          });
        }, keepSections);
      }
      await page.evaluate(() => import('/src/index.js'));
      if (!process.env.BENCH_FAST) {
        await page.addScriptTag({ url: `${origin}${H2C}` });
        await page.addScriptTag({ url: `${origin}${JSPDF}` });
      }
      await page.evaluate(() => document.fonts.ready);
      await new Promise(r => setTimeout(r, 80));
      return page;
    }

    async function html2canvasPdf(page, viewport) {
      const base64 = await page.evaluate(async ({ vw, vh }) => {
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
      }, { vw: viewport.width, vh: viewport.height });
      return Buffer.from(base64, 'base64');
    }

    async function playwrightPdf(page, viewport) {
      return page.pdf({
        width: `${viewport.width}px`,
        height: `${viewport.height}px`,
        printBackground: true,
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
      });
    }

    async function measure(rel, viewport, keepSections, tag) {
      const page = await openFixture(rel, viewport, keepSections);
      const dTime = await timeSamples(() => dominatePdf(rel, viewport));
      const pTime = await timeSamples(() => playwrightPdf(page, viewport));
      const hTime = process.env.BENCH_FAST
        ? { medianMs: 0, last: null }
        : await timeSamples(() => html2canvasPdf(page, viewport));

      const dPdf = dTime.last;
      const pPdf = pTime.last;
      const hPdf = hTime.last;

      const dDiff = await worstPageDiff(page, dPdf, viewport, `${tag}-dom`);
      const pDiff = await worstPageDiff(page, pPdf, viewport, `${tag}-pw`);
      const hDiff = hPdf
        ? await worstPageDiff(page, hPdf, viewport, `${tag}-h2c`)
        : { worstPercent: 0, pageCount: 0, worstPage: 0, pages: [] };
      await page.close();

      return {
        time: {
          dominate: dTime.medianMs,
          html2canvas: hTime.medianMs,
          playwright: pTime.medianMs,
        },
        diff: {
          dominate: dDiff.worstPercent,
          html2canvas: hDiff.worstPercent,
          playwright: pDiff.worstPercent,
        },
        detail: { dominate: dDiff, html2canvas: hDiff, playwright: pDiff },
      };
    }

    const invoiceVp = { width: 794, height: 1200 };
    const reportVp = { width: 794, height: 1123 };

    const invoice = await measure(invoiceRel, invoiceVp, null, 'inv');
    const sow = await measure(reportRel, reportVp, 4, 'sow');

    const curve = [];
    const skipCurve = Boolean(process.env.BENCH_FAST);
    for (let pages = 1; !skipCurve && pages <= 4; pages++) {
      const raw = await readFile(resolve(ROOT, reportRel), 'utf8');
      const hidden = raw.replace(
        '</head>',
        `<style>${[1, 2, 3, 4].filter(i => i > pages).map(i => `#sec-${i}{display:none!important}`).join('')}</style></head>`,
      );
      await writeFile(resolve(ROOT, 'example', `._sow-${pages}.html`), hidden);
      const m = await measure(`example/._sow-${pages}.html`, reportVp, pages, `sow${pages}`);
      curve.push({
        pages,
        dominate: m.time.dominate,
        html2canvas: m.time.html2canvas,
        playwright: m.time.playwright,
        dominateDiff: m.diff.dominate,
        html2canvasDiff: m.diff.html2canvas,
        playwrightDiff: m.diff.playwright,
      });
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      iterations: ITERATIONS,
      protocol: 'HTML screenshot vs PDF raster at 96 DPI, pixelmatch threshold 0.1; worst page retained.',
      notes: {
        dominate: 'Vector PDF, selectable text, in-browser htmlToPdf',
        html2canvas: 'Raster screenshot sliced into jsPDF pages (no selectable text)',
        playwright: 'Headless Chromium page.pdf — not a drop-in browser library',
      },
      bar: [
        { name: 'Invoice (1 page)', engines: invoice.time, diff: invoice.diff, detail: invoice.detail },
        { name: 'SOW (4 pages)', engines: sow.time, diff: sow.diff, detail: sow.detail },
      ],
      curve,
    };

    await writeFile(resolve(OUT, 'compare.json'), `${JSON.stringify(payload, null, 2)}\n`);
    await writeFile(resolve(ASSETS, 'bench-bar.svg'), barSvg(payload.bar, {
      title: 'Warm convert time (ms) — lower is better', unit: 'milliseconds', digits: 0, stepHint: 20,
    }));
    await writeFile(resolve(ASSETS, 'bench-diff.svg'), barSvg(
      payload.bar.map(s => ({ name: s.name, engines: s.diff })),
      { title: 'Worst-page pixel-diff vs HTML (%) — lower is better', unit: 'percent', digits: 2, stepHint: 2 },
    ));
    await writeFile(resolve(ASSETS, 'bench-curve.svg'), curveSvg(curve, ['dominate', 'html2canvas', 'playwright'], {
      title: 'Warm convert time vs page count — SOW fixture', unit: 'milliseconds', digits: 0, stepHint: 20,
    }));
    await writeFile(resolve(ASSETS, 'bench-curve-diff.svg'), curveSvg(curve, ['dominateDiff', 'html2canvasDiff', 'playwrightDiff'], {
      title: 'Worst-page pixel-diff vs HTML (%) — SOW fixture', unit: 'percent', digits: 2, stepHint: 2,
    }));
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
