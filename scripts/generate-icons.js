/**
 * Icon Generator — creates PNG/ICO raster icons from brand master SVG.
 * Uses sharp for crisp SVG→PNG rendering at all sizes.
 * Run: node scripts/generate-icons.js
 */
'use strict';
let sharp;
try { sharp = require('sharp'); } catch {
  console.log('⚠ sharp not installed — skipping icon generation (icons are pre-built and committed)');
  process.exit(0);
}
const fs = require('fs');
const path = require('path');

const BRAND_DIR = path.join(__dirname, '..', 'public', 'brand');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MASTER_SVG = path.join(BRAND_DIR, 'favicon.svg');

async function main() {
  if (!fs.existsSync(BRAND_DIR)) fs.mkdirSync(BRAND_DIR, { recursive: true });

  const svgBuf = fs.readFileSync(MASTER_SVG);

  // Generate PNGs at each required size
  const sizes = [
    { name: 'icon-16.png',          size: 16 },
    { name: 'icon-32.png',          size: 32 },
    { name: 'icon-48.png',          size: 48 },
    { name: 'apple-touch-icon.png', size: 180 },
    { name: 'icon-192.png',         size: 192 },
    { name: 'icon-512.png',         size: 512 },
  ];

  for (const { name, size } of sizes) {
    await sharp(svgBuf, { density: Math.max(72, Math.round(72 * size / 512 * 4)) })
      .resize(size, size)
      .png()
      .toFile(path.join(BRAND_DIR, name));
    console.log(`✓ ${name} (${size}×${size})`);
  }

  // Build favicon.ico from the 16/32/48 PNGs
  const ico16 = fs.readFileSync(path.join(BRAND_DIR, 'icon-16.png'));
  const ico32 = fs.readFileSync(path.join(BRAND_DIR, 'icon-32.png'));
  const ico48 = fs.readFileSync(path.join(BRAND_DIR, 'icon-48.png'));
  const icoBuffer = buildIco([ico16, ico32, ico48], [16, 32, 48]);
  fs.writeFileSync(path.join(BRAND_DIR, 'favicon.ico'), icoBuffer);
  fs.writeFileSync(path.join(PUBLIC_DIR, 'favicon.ico'), icoBuffer);
  console.log('✓ favicon.ico (16+32+48)');
  console.log('\nAll icons generated in public/brand/');
}

/**
 * Build a minimal ICO file from PNG buffers.
 * ICO format: 6-byte header + N×16-byte directory entries + PNG data blocks.
 */
function buildIco(pngs, sizes) {
  const n = pngs.length;
  const headerSize = 6;
  const dirSize = n * 16;
  let dataOffset = headerSize + dirSize;

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(n, 4);

  const entries = [];
  for (let i = 0; i < n; i++) {
    const entry = Buffer.alloc(16);
    const s = sizes[i];
    entry.writeUInt8(s < 256 ? s : 0, 0);
    entry.writeUInt8(s < 256 ? s : 0, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(pngs[i].length, 8);
    entry.writeUInt32LE(dataOffset, 12);
    entries.push(entry);
    dataOffset += pngs[i].length;
  }

  return Buffer.concat([header, ...entries, ...pngs]);
}

main().catch(err => {
  console.error('Icon generation failed:', err);
  process.exit(1);
});
