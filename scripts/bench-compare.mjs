#!/usr/bin/env node
// Competitive convert bench: DOMinate vs popular HTML→PDF repos.
// Reports warm time AND worst-page pixel-diff vs the live HTML screenshot
// (same protocol as scripts/loop.mjs). Writes JSON + bar/curve SVGs.

import { chromium } from 'playwright';
import puppeteer from 'puppeteer-core';
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

const LIB = {
  html2canvas: '/node_modules/html2canvas/dist/html2canvas.min.js',
  jspdf: '/node_modules/jspdf/dist/jspdf.umd.min.js',
  htmlToImage: '/node_modules/html-to-image/dist/html-to-image.js',
  html2pdf: '/node_modules/html2pdf.js/dist/html2pdf.bundle.min.js',
};

const ENGINES = [
  { key: 'dominate', label: 'DOMinate', color: '#12b76a' },
  { key: 'html2canvas', label: 'html2canvas + jsPDF', color: '#e07a5f' },
  { key: 'html2pdf', label: 'html2pdf.js', color: '#c026d3', dash: '8 4' },
  { key: 'htmltoimage', label: 'html-to-image + jsPDF', color: '#f59e0b', dash: '2 4' },
  { key: 'jspdfhtml', label: 'jsPDF.html()', color: '#8b5cf6' },
  { key: 'playwright', label: 'Playwright page.pdf', color: '#2563eb' },
  { key: 'puppeteer', label: 'Puppeteer page.pdf', color: '#0ea5e9', dash: '6 3' },
];

const CHART = {
  bg: '#ffffff',
  ink: '#1c1c1c',
  muted: '#6b7280',
  grid: '#e8e4dc',
  axis: '#1c1c1c',
  legendFill: '#f6f3ec',
  legendStroke: '#e5dfd4',
  titleFont: "Georgia, 'Times New Roman', Times, serif",
  bodyFont: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
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
  if (maxV <= 100 && stepHint <= 5) {
    const step = maxV > 50 ? 20 : maxV > 20 ? 10 : 5;
    return Math.min(100, Math.max(step, Math.ceil((maxV * 1.08) / step) * step));
  }
  const raw = maxV * 1.12;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 1.5, 2, 2.5, 5, 10]) {
    const step = m * mag;
    if (step * 2 >= raw) return Math.ceil(raw / step) * step || stepHint;
  }
  return Math.ceil(raw / mag) * mag;
}

function legendSize() {
  const rowH = 30;
  const pad = 18;
  return { w: 236, h: pad * 2 + ENGINES.length * rowH - 8, rowH, pad };
}

function legendCard(x, y) {
  const { w, h, rowH, pad } = legendSize();
  let out = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="${CHART.legendFill}" stroke="${CHART.legendStroke}"/>`;
  ENGINES.forEach((e, i) => {
    const cy = y + pad + 10 + i * rowH;
    if (e.dash) {
      out += `<line x1="${x + 12}" y1="${cy}" x2="${x + 36}" y2="${cy}" stroke="${e.color}" stroke-width="2.4" stroke-dasharray="${e.dash}" stroke-linecap="round"/>`;
    }
    out += `<circle cx="${x + 24}" cy="${cy}" r="7.5" fill="${e.color}"/>`;
    out += `<text x="${x + 42}" y="${cy + 5}" font-size="13.5" fill="${CHART.ink}" font-family="${CHART.bodyFont}">${e.label}</text>`;
  });
  return out;
}

function fmtTick(v, digits) {
  if (Math.abs(v - Math.round(v)) < 1e-6) return String(Math.round(v));
  return v.toFixed(digits);
}

function chartShell({ title, subtitle, unit, xLabel, W, H, padL, padR, padT, padB }) {
  const plotX = padL;
  const plotY = padT;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const yMid = plotY + plotH / 2;
  const xMid = plotX + plotW / 2;
  const { h: legendH } = legendSize();
  const legendX = W - padR + 28;
  const legendY = plotY + Math.max(0, (plotH - legendH) / 2);
  const head = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="100%" height="100%" fill="${CHART.bg}"/>
  <text x="${W / 2}" y="42" text-anchor="middle" font-size="26" font-weight="700" fill="${CHART.ink}" font-family="${CHART.titleFont}">${title}</text>
  ${subtitle ? `<text x="${W / 2}" y="68" text-anchor="middle" font-size="14" fill="${CHART.muted}" font-family="${CHART.bodyFont}">${subtitle}</text>` : ''}
  <text x="${padL - 62}" y="${yMid}" text-anchor="middle" fill="${CHART.ink}" font-size="13" font-family="${CHART.bodyFont}" transform="rotate(-90 ${padL - 62} ${yMid})">${unit}</text>
  ${xLabel ? `<text x="${xMid}" y="${H - 16}" text-anchor="middle" font-size="14" font-weight="600" fill="${CHART.ink}" font-family="${CHART.bodyFont}">${xLabel}</text>` : ''}
  ${legendCard(legendX, legendY)}`;
  return { head, plotX, plotY, plotW, plotH, close: '</svg>\n' };
}

function yGrid({ plotX, plotY, plotW, plotH, nice, digits, ticks = 5 }) {
  let out = `<line x1="${plotX}" y1="${plotY}" x2="${plotX}" y2="${plotY + plotH}" stroke="${CHART.axis}" stroke-width="1.4"/>`;
  for (let i = 0; i <= ticks; i++) {
    const v = (nice / ticks) * i;
    const yy = plotY + plotH - (v / nice) * plotH;
    out += `<line x1="${plotX}" y1="${yy.toFixed(1)}" x2="${plotX + plotW}" y2="${yy.toFixed(1)}" stroke="${i === 0 ? CHART.axis : CHART.grid}" stroke-width="${i === 0 ? 1.4 : 1}"/>`;
    out += `<text x="${plotX - 12}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-size="12" fill="${CHART.muted}" font-family="${CHART.bodyFont}">${fmtTick(v, digits)}</text>`;
  }
  return out;
}

function barSvg(series, { title, subtitle, unit, digits = 0, stepHint = 100 }) {
  const W = 1280, H = 680, padL = 108, padR = 276, padT = 104, padB = 78;
  const { head, plotX, plotY, plotW, plotH, close } = chartShell({
    title, subtitle, unit, xLabel: '', W, H, padL, padR, padT, padB,
  });
  const groupW = plotW / series.length;
  const barW = groupW / (ENGINES.length + 1.6);
  const maxV = Math.max(...series.flatMap(s => ENGINES.map(e => s.engines[e.key] || 0)), 0.01);
  const nice = niceMax(maxV, stepHint);
  const y = v => plotY + plotH - (v / nice) * plotH;

  let bars = yGrid({ plotX, plotY, plotW, plotH, nice, digits });
  series.forEach((s, gi) => {
    const gx = plotX + gi * groupW;
    const cluster = ENGINES.length * barW + (ENGINES.length - 1) * 8;
    const start = gx + (groupW - cluster) / 2;
    ENGINES.forEach((e, ei) => {
      const v = s.engines[e.key] || 0;
      const x = start + ei * (barW + 8);
      const top = y(v);
      const h = Math.max(0, plotY + plotH - top);
      bars += `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${e.color}" rx="3"/>`;
      bars += `<text x="${(x + barW / 2).toFixed(1)}" y="${(top - 7).toFixed(1)}" text-anchor="middle" font-size="${digits >= 2 ? 9 : 10}" font-weight="600" fill="${CHART.ink}" font-family="${CHART.bodyFont}">${v.toFixed(digits)}</text>`;
    });
    bars += `<text x="${(gx + groupW / 2).toFixed(1)}" y="${plotY + plotH + 28}" text-anchor="middle" font-size="13.5" fill="${CHART.ink}" font-family="${CHART.bodyFont}">${s.name}</text>`;
  });

  return `${head}
  ${bars}
${close}`;
}

function curveSvg(points, keys, { title, subtitle, unit, digits = 0, stepHint = 100, xLabel = 'A4 pages dispatched' }) {
  const W = 1280, H = 680, padL = 108, padR = 276, padT = 104, padB = 86;
  const { head, plotX, plotY, plotW, plotH, close } = chartShell({
    title, subtitle, unit, xLabel, W, H, padL, padR, padT, padB,
  });
  const xs = points.map(p => p.pages);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const maxV = Math.max(...points.flatMap(p => keys.map(k => p[k] || 0)), 0.01);
  const nice = niceMax(maxV, stepHint);
  const inset = 36;
  const x = v => plotX + inset + ((v - minX) / (maxX - minX || 1)) * (plotW - inset * 2);
  const y = v => plotY + plotH - (v / nice) * plotH;

  let grid = yGrid({ plotX, plotY, plotW, plotH, nice, digits });
  for (const p of points) {
    const xx = x(p.pages);
    grid += `<line x1="${xx.toFixed(1)}" y1="${plotY}" x2="${xx.toFixed(1)}" y2="${plotY + plotH}" stroke="${CHART.grid}"/>`;
    grid += `<text x="${xx.toFixed(1)}" y="${plotY + plotH + 26}" text-anchor="middle" font-size="13" fill="${CHART.ink}" font-family="${CHART.bodyFont}">${p.pages}</text>`;
  }

  const drawOrder = [...ENGINES].sort((a, b) => {
    const rank = e => (e.key === 'dominate' ? 4 : e.dash ? 2 : 1);
    return rank(a) - rank(b);
  });
  const lines = drawOrder.map(e => {
    const key = keys.find(k => k === e.key || k === `${e.key}Diff`);
    if (!key) return '';
    const d = points.map((p, i) => `${i ? 'L' : 'M'} ${x(p.pages).toFixed(1)} ${y(p[key] || 0).toFixed(1)}`).join(' ');
    const dash = e.dash ? ` stroke-dasharray="${e.dash}"` : '';
    const dots = points.map(p => {
      const cx = x(p.pages).toFixed(1);
      const cy = y(p[key] || 0).toFixed(1);
      return `<circle cx="${cx}" cy="${cy}" r="6.5" fill="${e.color}" stroke="${CHART.bg}" stroke-width="2"/>`;
    }).join('');
    return `<path d="${d}" fill="none" stroke="${e.color}" stroke-width="2.8" stroke-linejoin="round" stroke-linecap="round"${dash}/>${dots}`;
  }).join('');

  return `${head}
  ${grid}
  ${lines}
${close}`;
}

async function writeCharts(payload) {
  const curve = payload.curve;
  await writeFile(resolve(ASSETS, 'bench-bar.svg'), barSvg(payload.bar, {
    title: 'Warm convert time',
    subtitle: 'Median of 5 warm calls — lower is better',
    unit: 'milliseconds',
    digits: 0,
    stepHint: 20,
  }));
  await writeFile(resolve(ASSETS, 'bench-diff.svg'), barSvg(
    payload.bar.map(s => ({ name: s.name, engines: s.diff })),
    {
      title: 'Worst-page pixel-diff vs HTML',
      subtitle: '96 DPI · pixelmatch 0.1 — lower is better',
      unit: 'percent',
      digits: 2,
      stepHint: 2,
    },
  ));
  await writeFile(resolve(ASSETS, 'bench-curve.svg'), curveSvg(curve, ENGINES.map(e => e.key), {
    title: 'Warm convert time vs page count',
    subtitle: 'SOW fixture — lower is better',
    unit: 'milliseconds',
    digits: 0,
    stepHint: 20,
  }));
  await writeFile(resolve(ASSETS, 'bench-curve-diff.svg'), curveSvg(curve, ENGINES.map(e => `${e.key}Diff`), {
    title: 'Worst-page pixel-diff vs page count',
    subtitle: 'SOW fixture · 96 DPI — lower is better',
    unit: 'percent',
    digits: 2,
    stepHint: 2,
  }));
}

async function timeSamples(fn) {
  await fn();
  const times = [];
  let last = null;
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    const out = await fn();
    if (out && typeof out === 'object' && typeof out.elapsed === 'number' && out.bytes) {
      times.push(out.elapsed);
      last = out.bytes;
    } else {
      last = out;
      times.push(performance.now() - t0);
    }
  }
  return { ...stats(times), last };
}

async function worstPageDiff(shot, pdfBytes, viewport, tag) {
  const pdfPath = resolve(OUT, `_cmp-${tag}.pdf`);
  await writeFile(pdfPath, pdfBytes);
  const all = await rasterizeAll(pdfPath, { dpi: 96 });
  const htmlSize = await shot.evaluate(() => ({
    width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0, 1),
    height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0, 1),
  }));
  let worst = { percent: 0, page: 1, pages: [] };
  for (const page of all.pages) {
    const pdfPng = resolve(OUT, `_cmp-${tag}-p${page.index}.png`);
    const htmlPng = resolve(OUT, `_cmp-${tag}-h${page.index}.png`);
    const diffPng = resolve(OUT, `_cmp-${tag}-d${page.index}.png`);
    await writeFile(pdfPng, page.png);
    const y = (page.index - 1) * viewport.height;
    if (y >= htmlSize.height) {
      const row = { page: page.index, percent: 100, diffPx: 0, totalPx: 0, extraPage: true };
      worst.pages.push(row);
      if (row.percent > worst.percent) {
        worst.percent = row.percent;
        worst.page = page.index;
      }
      continue;
    }
    const clipH = Math.min(viewport.height, htmlSize.height - y);
    const clipW = Math.min(viewport.width, htmlSize.width);
    await shot.screenshot({
      path: htmlPng,
      fullPage: true,
      clip: { x: 0, y, width: clipW, height: clipH },
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
  if (process.argv.includes('--charts-only')) {
    const payload = JSON.parse(await readFile(resolve(OUT, 'compare.json'), 'utf8'));
    await writeCharts(payload);
    console.log('rewrote SVGs from benchmark/compare.json');
    return;
  }
  const { server, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ args: ['--disable-lcd-text'] });
  const pptr = await puppeteer.launch({
    executablePath: chromium.executablePath(),
    headless: true,
    args: ['--disable-lcd-text'],
  });

  const landingRel = 'example/templatemo_550_diagoona/index.html';
  const invoiceRel = 'example/Ivonne - Template/hotel-booking-invoice.html';
  const reportRel = 'example/dominate-sow.html';

  try {
    const runner = await browser.newPage({ viewport: { width: 1400, height: 1200 }, deviceScaleFactor: 1 });
    await runner.goto(`${origin}/demo/run.html`, { waitUntil: 'networkidle' });
    await runner.evaluate(() => import('/src/index.js'));

    async function dominatePdf(rel, viewport) {
      const raw = await readFile(resolve(ROOT, rel), 'utf8');
      const dir = dirname(rel).replace(/\\/g, '/');
      const html = withBase(raw, `${origin}/${dir}/`);
      const result = await runner.evaluate(async ({ htmlString, viewport, baseUrl }) => {
        const { htmlToPdf } = await import('/src/index.js');
        const t0 = performance.now();
        const bytes = await htmlToPdf(htmlString, { viewport, baseUrl });
        const elapsed = performance.now() - t0;
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return { elapsed, base64: btoa(binary) };
      }, { htmlString: html, viewport, baseUrl: `${origin}/${dir}/` });
      return { bytes: Buffer.from(result.base64, 'base64'), elapsed: result.elapsed };
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
        await page.addScriptTag({ url: `${origin}${LIB.html2canvas}` });
        await page.addScriptTag({ url: `${origin}${LIB.jspdf}` });
        await page.addScriptTag({ url: `${origin}${LIB.htmlToImage}` });
        await page.evaluate(() => {
          window.__h2c = window.html2canvas;
          window.__jspdf = window.jspdf;
        });
        await page.addScriptTag({ url: `${origin}${LIB.html2pdf}` });
        await page.evaluate(() => {
          window.html2pdfLib = window.html2pdf;
          window.html2canvas = window.__h2c;
          window.jspdf = window.__jspdf;
        });
      }
      await page.evaluate(() => document.fonts.ready);
      await new Promise(r => setTimeout(r, 80));
      return page;
    }

    async function openPuppeteerFixture(rel, viewport, keepSections) {
      const page = await pptr.newPage();
      await page.setViewport(viewport);
      await page.goto(`${origin}/${rel.replace(/\\/g, '/')}`, { waitUntil: 'networkidle0' });
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

    async function html2pdfPdf(page, viewport) {
      const base64 = await page.evaluate(async ({ vw, vh }) => {
        const worker = window.html2pdfLib || window.html2pdf;
        const opt = {
          margin: 0,
          image: { type: 'jpeg', quality: 0.85 },
          html2canvas: { scale: 1, useCORS: true, logging: false, windowWidth: vw, windowHeight: vh },
          jsPDF: { unit: 'px', format: [vw, vh], orientation: vh >= vw ? 'portrait' : 'landscape' },
          pagebreak: { mode: ['css', 'legacy'] },
        };
        const datauri = await worker().set(opt).from(document.documentElement).outputPdf('datauristring');
        return String(datauri).split(',').pop();
      }, { vw: viewport.width, vh: viewport.height });
      return Buffer.from(base64, 'base64');
    }

    async function htmlToImagePdf(page, viewport) {
      const base64 = await page.evaluate(async ({ vw, vh }) => {
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
      }, { vw: viewport.width, vh: viewport.height });
      return Buffer.from(base64, 'base64');
    }

    async function jspdfHtmlPdf(page, viewport) {
      const base64 = await page.evaluate(async ({ vw, vh }) => {
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

    async function puppeteerPdf(page, viewport) {
      return page.pdf({
        width: `${viewport.width}px`,
        height: `${viewport.height}px`,
        printBackground: true,
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
      });
    }

    async function measure(rel, viewport, keepSections, tag) {
      const page = await openFixture(rel, viewport, keepSections);
      const pptrPage = process.env.BENCH_FAST ? null : await openPuppeteerFixture(rel, viewport, keepSections);

      const runners = {
        dominate: () => dominatePdf(rel, viewport),
        playwright: () => playwrightPdf(page, viewport),
      };
      if (!process.env.BENCH_FAST) {
        runners.html2canvas = () => html2canvasPdf(page, viewport);
        runners.html2pdf = () => html2pdfPdf(page, viewport);
        runners.htmltoimage = () => htmlToImagePdf(page, viewport);
        runners.jspdfhtml = () => jspdfHtmlPdf(page, viewport);
        runners.puppeteer = () => puppeteerPdf(pptrPage, viewport);
      }

      const timed = {};
      for (const e of ENGINES) {
        if (!runners[e.key]) {
          timed[e.key] = { medianMs: 0, last: null };
          continue;
        }
        try {
          process.stderr.write(`  ${tag} ${e.key} time…\n`);
          timed[e.key] = await timeSamples(runners[e.key]);
        } catch (error) {
          throw new Error(`${e.key} failed on ${tag}: ${error.message}`);
        }
      }

      const time = {};
      const diff = {};
      const detail = {};
      for (const e of ENGINES) {
        time[e.key] = timed[e.key].medianMs;
        if (!timed[e.key].last) {
          diff[e.key] = 0;
          detail[e.key] = { worstPercent: 0, pageCount: 0, worstPage: 0, pages: [] };
          continue;
        }
        process.stderr.write(`  ${tag} ${e.key} diff…\n`);
        detail[e.key] = await worstPageDiff(page, timed[e.key].last, viewport, `${tag}-${e.key}`);
        diff[e.key] = detail[e.key].worstPercent;
      }
      await page.close();
      if (pptrPage) await pptrPage.close();
      return { time, diff, detail };
    }

    const landingVp = { width: 1280, height: 800 };
    const invoiceVp = { width: 794, height: 1200 };
    const reportVp = { width: 794, height: 1123 };

    const landing = await measure(landingRel, landingVp, null, 'land');
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
      const row = { pages };
      for (const e of ENGINES) {
        row[e.key] = m.time[e.key];
        row[`${e.key}Diff`] = m.diff[e.key];
      }
      curve.push(row);
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      iterations: ITERATIONS,
      protocol: 'HTML screenshot vs PDF raster at 96 DPI, pixelmatch threshold 0.1; worst page retained.',
      notes: {
        dominate: 'Vector PDF, selectable text, in-browser htmlToPdf — https://github.com/RandazzoMaxime/DOMinate',
        html2canvas: 'Raster screenshot sliced into jsPDF pages — https://github.com/niklasvh/html2canvas + https://github.com/parallax/jsPDF',
        html2pdf: 'Client wrapper around html2canvas + jsPDF — https://github.com/eKoopmans/html2pdf.js',
        htmltoimage: 'DOM snapshot via html-to-image, wrapped in jsPDF — https://github.com/bubkoo/html-to-image',
        jspdfhtml: 'Official jsPDF.html() plugin (html2canvas internally) — https://github.com/parallax/jsPDF',
        playwright: 'Headless Chromium page.pdf via Playwright — not a drop-in browser library',
        puppeteer: 'Headless Chromium page.pdf via Puppeteer — https://github.com/puppeteer/puppeteer',
      },
      bar: [
        { name: 'Landing', engines: landing.time, diff: landing.diff, detail: landing.detail },
        { name: 'Invoice (1 page)', engines: invoice.time, diff: invoice.diff, detail: invoice.detail },
        { name: 'SOW (4 pages)', engines: sow.time, diff: sow.diff, detail: sow.detail },
      ],
      curve,
    };

    await writeFile(resolve(OUT, 'compare.json'), `${JSON.stringify(payload, null, 2)}\n`);
    await writeCharts(payload);
    console.log(JSON.stringify(payload, null, 2));
  } finally {
    await browser.close();
    await pptr.close();
    await new Promise(resolveClosed => server.close(resolveClosed));
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
