#!/usr/bin/env node
// One-shot generator for deterministic test images in assets/img/ (used by the
// torture-image fixture). Uses @napi-rs/canvas (scripts-only dependency).
import { createCanvas } from '@napi-rs/canvas';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'assets', 'img');
await mkdir(OUT, { recursive: true });

// 1) photo.jpg — 320x200 synthetic landscape (sky gradient, sun, hills).
{
  const c = createCanvas(320, 200);
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, 130);
  sky.addColorStop(0, '#2c6fbb'); sky.addColorStop(1, '#bcd8f0');
  g.fillStyle = sky; g.fillRect(0, 0, 320, 130);
  g.fillStyle = '#f7d154'; g.beginPath(); g.arc(250, 55, 28, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#3f7d3a'; g.beginPath();
  g.moveTo(0, 130); g.quadraticCurveTo(80, 70, 160, 128); g.quadraticCurveTo(240, 180, 320, 110);
  g.lineTo(320, 200); g.lineTo(0, 200); g.closePath(); g.fill();
  g.fillStyle = '#2a5d28'; g.beginPath();
  g.moveTo(0, 160); g.quadraticCurveTo(110, 120, 220, 165); g.quadraticCurveTo(280, 185, 320, 170);
  g.lineTo(320, 200); g.lineTo(0, 200); g.closePath(); g.fill();
  await writeFile(resolve(OUT, 'photo.jpg'), c.toBuffer('image/jpeg', 88));
}

// 2) badge.png — 128x128 RGBA with real transparency (ring + star on empty bg).
{
  const c = createCanvas(128, 128);
  const g = c.getContext('2d');
  g.strokeStyle = '#c44536'; g.lineWidth = 10;
  g.beginPath(); g.arc(64, 64, 52, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#1b6ca8';
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 38 : 16;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = 64 + r * Math.cos(a), y = 64 + r * Math.sin(a);
    i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
  }
  g.closePath(); g.fill();
  await writeFile(resolve(OUT, 'badge.png'), c.toBuffer('image/png'));
}

// 3) tile.png — 24x24 opaque checker tile for background-repeat.
{
  const c = createCanvas(24, 24);
  const g = c.getContext('2d');
  g.fillStyle = '#e8edf4'; g.fillRect(0, 0, 24, 24);
  g.fillStyle = '#9fb3cc'; g.fillRect(0, 0, 12, 12); g.fillRect(12, 12, 12, 12);
  await writeFile(resolve(OUT, 'tile.png'), c.toBuffer('image/png'));
}

console.log('wrote assets/img/photo.jpg, badge.png, tile.png');
