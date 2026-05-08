// Spawn headless Chromium, load demo/run.html via a tiny HTTP server, retrieve
// Uint8Array PDF bytes from the page. The lib (src/index.js) runs entirely in-browser.

import { chromium } from 'playwright';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.json': 'application/json',
  '.ttf':  'font/ttf',
  '.otf':  'font/otf',
  '.woff2':'font/woff2',
  '.pdf':  'application/pdf',
};

function startServer() {
  return new Promise((resolveServer) => {
    const server = createServer(async (req, res) => {
      try {
        let p = decodeURIComponent(req.url.split('?')[0]);
        if (p === '/' || p === '') p = '/demo/run.html';
        const full = resolve(ROOT, '.' + p);
        if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
        const s = await stat(full);
        if (s.isDirectory()) { res.writeHead(404); return res.end(); }
        const data = await readFile(full);
        res.writeHead(200, {
          'Content-Type': MIME[extname(full)] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(data);
      } catch (e) {
        res.writeHead(404); res.end(String(e?.message || e));
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveServer({ server, port });
    });
  });
}

export async function renderWithLib(htmlPath, viewport = { width: 1123, height: 794 }) {
  const html = await readFile(htmlPath, 'utf8');

  const { server, port } = await startServer();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: Math.max(viewport.width, 1123), height: Math.max(viewport.height, 794) },
      deviceScaleFactor: 1,
    });

    page.on('console', msg => {
      const t = msg.type();
      if (t === 'error' || t === 'warning') console.error('[browser]', t, msg.text());
    });
    page.on('pageerror', err => console.error('[browser pageerror]', err.message));

    await page.goto(`http://127.0.0.1:${port}/demo/run.html`, { waitUntil: 'networkidle' });

    const base64 = await page.evaluate(async ({ htmlString, vp }) => {
      const { htmlToPdf } = await import('/src/index.js');
      const bytes = await htmlToPdf(htmlString, { viewport: vp, margin: 0 });
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    }, { htmlString: html, vp: viewport });

    return Uint8Array.from(Buffer.from(base64, 'base64'));
  } finally {
    await browser.close();
    server.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = await renderWithLib(resolve(ROOT, 'reference', 'source.html'), { width: 1123, height: 794 });
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(resolve(ROOT, 'dist'), { recursive: true });
  await writeFile(resolve(ROOT, 'dist', 'output.pdf'), out);
  console.log('Wrote dist/output.pdf', out.byteLength, 'bytes');
}
