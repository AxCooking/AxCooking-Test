// optimize-images.mjs (v2)
// Image-Pipeline für AxCooking
// 
// Erwartete Source-Dateien in images/source/:
//   recipe-id-16x9.jpg      → 16:9 Variante (Pflicht, wird für Detail-Hauptbild + Übersicht genutzt)
//   recipe-id-43.jpg        → 4:3 Variante (optional; falls fehlend, wird aus 16:9 smart-cropped)
//   recipe-id-pin.jpg       → 2:3 Pinterest-Pin Variante (optional; falls fehlend, wird aus 4:3 oder 16:9 smart-cropped)
//
// Endung kann .jpg oder .png sein. Mindestens eine 16:9-Source pro Recipe-ID muss existieren.
//
// Output-Dateinamen sind unverändert von v1 (Frontend braucht keine Änderung):
//   recipe-id-{400|800|1200}-16x9.{avif|webp|jpg}
//   recipe-id-{400|800|1200}-4x3.{avif|webp|jpg}
//   recipe-id-pin.{jpg|webp}
//   recipe-id-square.jpg
//   recipe-id-og.jpg
//   recipe-id.jpg (legacy 800x450)

import sharp from 'sharp';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pLimit from 'p-limit';

const SOURCE_DIR = 'images/source';
const OUTPUT_DIR = 'images/optimized';
const MANIFEST_PATH = 'images/manifest.json';

const SIZES = [400, 800, 1200];
const ASPECTS = {
  '16x9': { ratio: 16 / 9 },
  '4x3': { ratio: 4 / 3 }
};

// Encoding settings (food-photography optimized)
const AVIF_OPTS = { quality: 65, effort: 4, chromaSubsampling: '4:2:0' };
const WEBP_OPTS = { quality: 82, smartSubsample: true, effort: 5 };
const JPEG_OPTS = { quality: 85, mozjpeg: true, chromaSubsampling: '4:4:4' };
const PIN_JPEG_OPTS = { quality: 88, mozjpeg: true, chromaSubsampling: '4:4:4' };

const FORCE = process.argv.includes('--force');
const limit = pLimit(2);

const SOURCE_EXTS = ['.jpg', '.jpeg', '.png'];
// Recognized suffixes (sorted by specificity — longer first)
const SUFFIX_PATTERNS = [
  { suffix: '-16x9', kind: '16x9' },
  { suffix: '-4x3', kind: '4x3' },
  { suffix: '-43', kind: '4x3' },
  { suffix: '-pin', kind: 'pin' }
];

function parseSourceFilename(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (!SOURCE_EXTS.includes(ext)) return null;
  const base = filename.slice(0, -ext.length);
  for (const { suffix, kind } of SUFFIX_PATTERNS) {
    if (base.endsWith(suffix)) {
      return { slug: base.slice(0, -suffix.length), kind, ext, filename };
    }
  }
  // No suffix → treat as 16x9 source (legacy / default)
  return { slug: base, kind: '16x9', ext, filename };
}

async function sha256OfFile(filePath) {
  const buf = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function loadManifest() {
  try {
    const raw = await fs.readFile(MANIFEST_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return { version: 2, generatedAt: null, images: {} };
  }
}

async function saveManifest(manifest) {
  manifest.version = 2;
  manifest.generatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function fileSize(p) {
  try {
    const s = await fs.stat(p);
    return s.size;
  } catch (e) {
    return null;
  }
}

// Resize+crop a source to a target aspect ratio at a given width
function buildPipeline(sourceBuffer, targetWidth, aspectKey) {
  const ratio = ASPECTS[aspectKey].ratio;
  const targetHeight = Math.round(targetWidth / ratio);
  return sharp(sourceBuffer, { failOn: 'truncated' })
    .rotate() // honor EXIF orientation
    .resize({
      width: targetWidth,
      height: targetHeight,
      fit: 'cover',
      position: sharp.strategy.attention
    });
}

async function encodeVariant(sourceBuffer, slug, width, aspectKey, format) {
  const ext = format === 'jpeg' ? 'jpg' : format;
  const outPath = path.join(OUTPUT_DIR, `${slug}-${width}-${aspectKey}.${ext}`);
  const pipeline = buildPipeline(sourceBuffer, width, aspectKey);
  let out;
  if (format === 'avif') {
    out = pipeline.avif(AVIF_OPTS);
  } else if (format === 'webp') {
    out = pipeline.webp(WEBP_OPTS);
  } else {
    out = pipeline.jpeg(JPEG_OPTS);
  }
  const info = await out.toFile(outPath);
  return {
    path: outPath.replace(/\\/g, '/'),
    bytes: info.size,
    format: ext,
    width: info.width,
    height: info.height
  };
}

async function encodePinterestPin(sourceBuffer, slug) {
  const targetW = 1000;
  const targetH = 1500;
  const pipelineBase = sharp(sourceBuffer, { failOn: 'truncated' })
    .rotate()
    .resize({ width: targetW, height: targetH, fit: 'cover', position: sharp.strategy.attention });

  const jpgPath = path.join(OUTPUT_DIR, `${slug}-pin.jpg`);
  const webpPath = path.join(OUTPUT_DIR, `${slug}-pin.webp`);
  const jpgInfo = await pipelineBase.clone().jpeg(PIN_JPEG_OPTS).toFile(jpgPath);
  const webpInfo = await pipelineBase.clone().webp({ quality: 86, effort: 5 }).toFile(webpPath);
  return [
    { path: jpgPath.replace(/\\/g, '/'), bytes: jpgInfo.size, format: 'jpg', width: jpgInfo.width, height: jpgInfo.height },
    { path: webpPath.replace(/\\/g, '/'), bytes: webpInfo.size, format: 'webp', width: webpInfo.width, height: webpInfo.height }
  ];
}

async function encodeSquare(sourceBuffer, slug) {
  const out = sharp(sourceBuffer, { failOn: 'truncated' })
    .rotate()
    .resize({ width: 1200, height: 1200, fit: 'cover', position: sharp.strategy.attention })
    .jpeg(JPEG_OPTS);
  const outPath = path.join(OUTPUT_DIR, `${slug}-square.jpg`);
  const info = await out.toFile(outPath);
  return { path: outPath.replace(/\\/g, '/'), bytes: info.size, format: 'jpg', width: info.width, height: info.height };
}

async function encodeOg(sourceBuffer, slug) {
  // og:image standard 1200x630 (~1.91:1) — closer to 16:9, derive from 16:9 source
  const out = sharp(sourceBuffer, { failOn: 'truncated' })
    .rotate()
    .resize({ width: 1200, height: 630, fit: 'cover', position: sharp.strategy.attention })
    .jpeg(JPEG_OPTS);
  const outPath = path.join(OUTPUT_DIR, `${slug}-og.jpg`);
  const info = await out.toFile(outPath);
  return { path: outPath.replace(/\\/g, '/'), bytes: info.size, format: 'jpg', width: info.width, height: info.height };
}

async function encodeLegacy(sourceBuffer, slug) {
  // Legacy 800x450 jpg (path: images/optimized/recipe-id.jpg)
  const out = sharp(sourceBuffer, { failOn: 'truncated' })
    .rotate()
    .resize({ width: 800, height: 450, fit: 'cover', position: sharp.strategy.attention })
    .jpeg(JPEG_OPTS);
  const outPath = path.join(OUTPUT_DIR, `${slug}.jpg`);
  const info = await out.toFile(outPath);
  return { path: outPath.replace(/\\/g, '/'), bytes: info.size, format: 'jpg', width: info.width, height: info.height };
}

async function processSlug(slug, sources, manifest) {
  // sources: { '16x9': {filename,filePath,hash,buffer}, '4x3': {...}, 'pin': {...} }
  const src169 = sources['16x9'];
  if (!src169) {
    console.warn(`[skip] ${slug}: no 16:9 source found`);
    return null;
  }
  const src43 = sources['4x3'] || src169; // fallback: smart-crop from 16:9
  const srcPin = sources['pin'] || sources['4x3'] || sources['16x9']; // best-fit fallback

  // Composite hash: includes all source hashes so changes anywhere invalidate cache
  const compositeKey = ['16x9', '4x3', 'pin']
    .map(k => sources[k] ? sources[k].hash : '-')
    .join('|');

  const existing = manifest.images[slug];
  if (!FORCE && existing && existing.compositeKey === compositeKey) {
    // Verify all expected output files still exist
    const allExist = await Promise.all((existing.outputs || []).map(o => fileSize(o.path).then(s => s !== null)));
    if (allExist.every(Boolean)) {
      console.log(`[cached] ${slug}`);
      return null; // unchanged
    }
  }

  console.log(`[encoding] ${slug}`);
  const startMs = Date.now();
  const outputs = [];

  // Read all source buffers up front
  const buf169 = await fs.readFile(src169.filePath);
  const buf43 = src43 === src169 ? buf169 : await fs.readFile(src43.filePath);
  const bufPin = srcPin === src169 ? buf169 : (srcPin === src43 ? buf43 : await fs.readFile(srcPin.filePath));

  // 16:9 outputs (3 sizes × 3 formats = 9)
  for (const w of SIZES) {
    for (const fmt of ['avif', 'webp', 'jpeg']) {
      outputs.push(await encodeVariant(buf169, slug, w, '16x9', fmt));
    }
  }

  // 4:3 outputs (3 sizes × 3 formats = 9)
  for (const w of SIZES) {
    for (const fmt of ['avif', 'webp', 'jpeg']) {
      outputs.push(await encodeVariant(buf43, slug, w, '4x3', fmt));
    }
  }

  // Pinterest pin (jpg + webp)
  const pinOutputs = await encodePinterestPin(bufPin, slug);
  outputs.push(...pinOutputs);

  // Square (from 4:3 — better center composition than 16:9)
  outputs.push(await encodeSquare(buf43, slug));

  // OG image (1200x630, from 16:9)
  outputs.push(await encodeOg(buf169, slug));

  // Legacy 800x450 (from 16:9)
  outputs.push(await encodeLegacy(buf169, slug));

  // Source dimensions (from primary 16:9)
  const meta = await sharp(buf169).metadata();

  const totalBytes = outputs.reduce((sum, o) => sum + (o.bytes || 0), 0);
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`[done] ${slug}: ${outputs.length} variants, ${(totalBytes / 1024).toFixed(0)} KB total, ${elapsed}s`);

  return {
    slug,
    sources: Object.fromEntries(
      Object.entries(sources).map(([k, v]) => [k, { filename: v.filename, hash: v.hash }])
    ),
    compositeKey,
    sourceWidth: meta.width,
    sourceHeight: meta.height,
    encodedAt: new Date().toISOString(),
    outputs
  };
}

async function main() {
  await ensureDir(OUTPUT_DIR);

  // Read source directory
  let sourceFiles;
  try {
    sourceFiles = await fs.readdir(SOURCE_DIR);
  } catch (e) {
    console.log(`No ${SOURCE_DIR}/ directory yet — nothing to process.`);
    await saveManifest({ version: 2, generatedAt: null, images: {} });
    return;
  }

  // Group files by slug + kind
  const slugMap = new Map(); // slug → { '16x9': {...}, '4x3': {...}, 'pin': {...} }
  for (const filename of sourceFiles) {
    const parsed = parseSourceFilename(filename);
    if (!parsed) continue;
    const filePath = path.join(SOURCE_DIR, filename);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) continue;
    const hash = await sha256OfFile(filePath);
    if (!slugMap.has(parsed.slug)) slugMap.set(parsed.slug, {});
    const slugSources = slugMap.get(parsed.slug);
    if (slugSources[parsed.kind]) {
      console.warn(`[duplicate] ${parsed.slug} ${parsed.kind}: ${slugSources[parsed.kind].filename} vs ${filename} — keeping ${slugSources[parsed.kind].filename}`);
      continue;
    }
    slugSources[parsed.kind] = { filename, filePath, hash };
  }

  if (slugMap.size === 0) {
    console.log(`Found 0 source images.`);
    await saveManifest({ version: 2, generatedAt: null, images: {} });
    return;
  }

  console.log(`Found ${slugMap.size} recipe(s) with source images.`);
  for (const [slug, sources] of slugMap.entries()) {
    const kinds = Object.keys(sources).join(', ');
    console.log(`  - ${slug}: [${kinds}]`);
  }

  const manifest = await loadManifest();
  if (!manifest.images) manifest.images = {};

  // Process each slug (parallel-limited)
  const results = await Promise.all(
    [...slugMap.entries()].map(([slug, sources]) =>
      limit(() => processSlug(slug, sources, manifest))
    )
  );

  // Update manifest with new entries (results that are non-null)
  for (const r of results) {
    if (r) manifest.images[r.slug] = r;
  }

  // Remove manifest entries for slugs that no longer have any source
  for (const slug of Object.keys(manifest.images)) {
    if (!slugMap.has(slug)) {
      console.log(`[orphan] ${slug}: no source files remain — removing from manifest`);
      delete manifest.images[slug];
    }
  }

  await saveManifest(manifest);
  console.log(`Manifest saved with ${Object.keys(manifest.images).length} entries.`);
}

main().catch(err => {
  console.error('Pipeline failed:', err);
  process.exit(1);
});
