#!/usr/bin/env node
// Competitive convert bench: DOMinate vs html2canvas+jsPDF vs Chromium page.pdf.
// Writes JSON + two SVG graphs (bar + curve). HTML fixtures stay local.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function barSvg(series) {
  // series: [{ name, engines: { dominate, html2canvas, playwright } }]
  const engines = [
    { key: 'dominate', label: 'DOMinate', color: '#55e59a' },
    { key: 'html2canvas', label: 'html2canvas + jsPDF', color: '#e07a5f' },
    { key: 'playwright', label: 'Chromium page.pdf', color: '#4edbff' },
  ];
  const W = 920, H = 420, padL = 70, padR = 24, padT = 48, padB = 70;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const groupW = innerW / series.length;
  const barW = groupW / (engines.length + 1);
  const maxV = Math.max(...series.flatMap(s => engines.map(e => s.engines[e.key] || 0)), 1);
  const nice = Math.ceil(maxV / 100) * 100;
  const y = v => padT + innerH - (v / nice) * innerH;

  let bars = '';
  series.forEach((s, gi) => {
    const gx = padL + gi * groupW;
    engines.forEach((e, ei) => {
      const v = s.engines[e.key] || 0;
      const x = gx + (ei + 0.5) * barW;
      const top = y(v);
      const h = padT + innerH - top;
      bars += `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${(barW * 0.85).toFixed(1)}" height="${h.toFixed(1)}" fill="${e.color}" rx="3"/>`;
      bars += `<text x="${(x + barW * 0.42).toFixed(1)}" y="${(top - 6).toFixed(1)}" text-anchor="middle" font-size="11" fill="#d7e6ed">${v.toFixed(0)}</text>`;
    });
    bars += `<text x="${(gx + groupW / 2).toFixed(1)}" y="${H - 36}" text-anchor="middle" font-size="13" fill="#f8fbfd">${s.name}</text>`;
  });

  const ticks = 5;
  let grid = '';
  for (let i = 0; i <= ticks; i++) {
    const v = (nice / ticks) * i;
    const yy = y(v);
    grid += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" stroke="#1d6179" stroke-opacity=".35"/>`;
    grid += `<text x="${padL - 8}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#a7b9c6">${v.toFixed(0)}</text>`;
  }

  const legend = engines.map((e, i) => {
    const x = padL + i * 210;
    return `<rect x="${x}" y="16" width="12" height="12" fill="${e.color}" rx="2"/><text x="${x + 18}" y="26" font-size="12" fill="#d7e6ed">${e.label}</text>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="100%" height="100%" fill="#06111b"/>
  <text x="${padL}" y="14" font-size="15" font-weight="700" fill="#f8fbfd">Warm convert time (ms) — lower is better</text>
  ${legend}
  ${grid}
  ${bars}
  <text x="${padL - 52}" y="${padT + innerH / 2}" fill="#a7b9c6" font-size="11" transform="rotate(-90 ${padL - 52} ${padT + innerH / 2})">milliseconds</text>
</svg>
`;
}

function curveSvg(points) {
  // points: [{ pages, dominate, html2canvas, playwright }]
  const engines = [
    { key: 'dominate', label: 'DOMinate', color: '#55e59a' },
    { key: 'html2canvas', label: 'html2canvas + jsPDF', color: '#e07a5f' },
    { key: 'playwright', label: 'Chromium page.pdf', color: '#4edbff' },
  ];
  const W = 920, H = 420, padL = 70, padR = 24, padT = 48, padB = 60;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const xs = points.map(p => p.pages);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const maxV = Math.max(...points.flatMap(p => engines.map(e => p[e.key] || 0)), 1);
  const nice = Math.ceil(maxV / 100) * 100;
  const x = v => padL + ((v - minX) / (maxX - minX || 1)) * innerW;
  const y = v => padT + innerH - (v / nice) * innerH;

  let grid = '';
  for (let i = 0; i <= 5; i++) {
    const v = (nice / 5) * i;
    const yy = y(v);
    grid += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" stroke="#1d6179" stroke-opacity=".35"/>`;
    grid += `<text x="${padL - 8}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#a7b9c6">${v.toFixed(0)}</text>`;
  }
  for (const p of points) {
    grid += `<text x="${x(p.pages).toFixed(1)}" y="${H - 28}" text-anchor="middle" font-size="13" fill="#f8fbfd">${p.pages}p</text>`;
  }

  const lines = engines.map(e => {
    const d = points.map((p, i) => `${i ? 'L' : 'M'} ${x(p.pages).toFixed(1)} ${y(p[e.key] || 0).toFixed(1)}`).join(' ');
    const dots = points.map(p => `<circle cx="${x(p.pages).toFixed(1)}" cy="${y(p[e.key] || 0).toFixed(1)}" r="4.5" fill="${e.color}"/>`).join('');
    return `<path d="${d}" fill="none" stroke="${e.color}" stroke-width="2.4"/>${dots}`;
  }).join('');

  const legend = engines.map((e, i) => {
    const lx = padL + i * 210;
    return `<rect x="${lx}" y="16" width="12" height="12" fill="${e.color}" rx="2"/><text x="${lx + 18}" y="26" font-size="12" fill="#d7e6ed">${e.label}</text>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="100%" height="100%" fill="#06111b"/>
  <text x="${padL}" y="14" font-size="15" font-weight="700" fill="#f8fbfd">Warm convert time vs page count — SOW fixture</text>
  ${legend}
  ${grid}
  ${lines}
  <text x="${padL - 52}" y="${padT + innerH / 2}" fill="#a7b9c6" font-size="11" transform="rotate(-90 ${padL - 52} ${padT + innerH / 2})">milliseconds</text>
  <text x="${padL + innerW / 2}" y="${H - 10}" text-anchor="middle" font-size="12" fill="#a7b9c6">A4 pages dispatched</text>
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

    async function dominate(rel, viewport) {
      const raw = await readFile(resolve(ROOT, rel), 'utf8');
      const dir = dirname(rel).replace(/\\/g, '/');
      const html = withBase(raw, `${origin}/${dir}/`);
      return runner.evaluate(async ({ htmlString, viewport, baseUrl }) => {
        const { htmlToPdf } = await import('/src/index.js');
        const bytes = await htmlToPdf(htmlString, { viewport, baseUrl });
        return bytes.byteLength;
      }, { htmlString: html, viewport, baseUrl: `${origin}/${dir}/` });
    }

    async function rasterStack(rel, viewport, keepSections) {
      const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
      await page.addInitScript((n) => { window.__KEEP = n; }, keepSections ?? 99);
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
      await page.addScriptTag({ url: `${origin}${H2C}` });
      await page.addScriptTag({ url: `${origin}${JSPDF}` });
      await page.evaluate(() => document.fonts.ready);

      const raster = async () => page.evaluate(async ({ vw, vh }) => {
        const canvas = await html2canvas(document.documentElement, {
          scale: 1, useCORS: true, windowWidth: vw, windowHeight: vh, logging: false,
        });
        const JsPDF = window.jspdf?.jsPDF || window.jsPDF;
        const pdf = new JsPDF({ unit: 'px', format: [vw, vh], orientation: vh >= vw ? 'portrait' : 'landscape' });
        const pageH = vh;
        let y = 0;
        let first = true;
        while (y < canvas.height - 1) {
          if (!first) pdf.addPage([vw, vh], vh >= vw ? 'portrait' : 'landscape');
          first = false;
          const slice = document.createElement('canvas');
          slice.width = vw;
          slice.height = Math.min(pageH, canvas.height - y);
          slice.getContext('2d').drawImage(canvas, 0, y, vw, slice.height, 0, 0, vw, slice.height);
          pdf.addImage(slice.toDataURL('image/jpeg', 0.85), 'JPEG', 0, 0, vw, slice.height);
          y += pageH;
        }
        return pdf.output('arraybuffer').byteLength;
      }, { vw: viewport.width, vh: viewport.height });

      const play = async () => {
        const buf = await page.pdf({
          width: `${viewport.width}px`,
          height: `${viewport.height}px`,
          printBackground: true,
          margin: { top: '0', right: '0', bottom: '0', left: '0' },
        });
        return buf.byteLength;
      };

      const rasterTimed = await timeSamples(raster);
      const playTimed = await timeSamples(play);
      await page.close();
      return { html2canvas: rasterTimed, playwright: playTimed };
    }

    const invoiceVp = { width: 794, height: 1200 };
    const reportVp = { width: 794, height: 1123 };

    const invDom = await timeSamples(() => dominate(invoiceRel, invoiceVp));
    const invOthers = await rasterStack(invoiceRel, invoiceVp, null);

    const repDom = await timeSamples(() => dominate(reportRel, reportVp));
    const repOthers = await rasterStack(reportRel, reportVp, 4);

    const curve = [];
    for (let pages = 1; pages <= 4; pages++) {
      const raw = await readFile(resolve(ROOT, reportRel), 'utf8');
      const hidden = raw.replace(
        '</head>',
        `<style>${[1, 2, 3, 4].filter(i => i > pages).map(i => `#sec-${i},.page-break:nth-of-type(${i}){display:none!important}`).join('')}</style></head>`,
      );
      await writeFile(resolve(ROOT, 'example', `._sow-${pages}.html`), hidden);
      const rel = `example/._sow-${pages}.html`;
      const d = await timeSamples(() => dominate(rel, reportVp));
      const o = await rasterStack(rel, reportVp, pages);
      curve.push({
        pages,
        dominate: d.medianMs,
        html2canvas: o.html2canvas.medianMs,
        playwright: o.playwright.medianMs,
      });
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      iterations: ITERATIONS,
      notes: {
        dominate: 'Vector PDF, selectable text, in-browser htmlToPdf',
        html2canvas: 'Raster screenshot sliced into jsPDF pages (no selectable text)',
        playwright: 'Headless Chromium page.pdf — not a drop-in browser library',
      },
      bar: [
        {
          name: 'Invoice (1 page)',
          engines: {
            dominate: invDom.medianMs,
            html2canvas: invOthers.html2canvas.medianMs,
            playwright: invOthers.playwright.medianMs,
          },
        },
        {
          name: 'SOW (4 pages)',
          engines: {
            dominate: repDom.medianMs,
            html2canvas: repOthers.html2canvas.medianMs,
            playwright: repOthers.playwright.medianMs,
          },
        },
      ],
      curve,
    };

    await writeFile(resolve(OUT, 'compare.json'), `${JSON.stringify(payload, null, 2)}\n`);
    await writeFile(resolve(ASSETS, 'bench-bar.svg'), barSvg(payload.bar));
    await writeFile(resolve(ASSETS, 'bench-curve.svg'), curveSvg(payload.curve));
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
