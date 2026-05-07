// Pixel-diff two PNGs of the same dimensions using pixelmatch.
import { readFile, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

export async function diffPngs(refPath, candPath, outPath) {
  const ref = PNG.sync.read(await readFile(refPath));
  const cand = PNG.sync.read(await readFile(candPath));

  // If dimensions differ, that itself counts as 100% diff and we still write
  // an artifact for inspection (pad the smaller to match).
  const w = Math.max(ref.width, cand.width);
  const h = Math.max(ref.height, cand.height);
  const refData = padTo(ref, w, h);
  const candData = padTo(cand, w, h);

  const out = new PNG({ width: w, height: h });
  const diffPx = pixelmatch(refData, candData, out.data, w, h, {
    threshold: 0.1,
    includeAA: false,
    alpha: 0.5,
    diffColor: [255, 0, 0],
  });

  await writeFile(outPath, PNG.sync.write(out));
  const totalPx = w * h;
  return { diffPx, totalPx, percent: (diffPx / totalPx) * 100, width: w, height: h };
}

function padTo(png, w, h) {
  if (png.width === w && png.height === h) return png.data;
  const out = Buffer.alloc(w * h * 4, 0);
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const src = (y * png.width + x) * 4;
      const dst = (y * w + x) * 4;
      out[dst]     = png.data[src];
      out[dst + 1] = png.data[src + 1];
      out[dst + 2] = png.data[src + 2];
      out[dst + 3] = png.data[src + 3];
    }
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const r = await diffPngs(
    resolve(ROOT, 'reference', 'source.png'),
    resolve(ROOT, 'dist', 'output.png'),
    resolve(ROOT, 'dist', 'diff.png'),
  );
  console.log(r);
}
