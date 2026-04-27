#!/usr/bin/env node
/**
 * AxCooking Image Pipeline
 * - Inkrementell via SHA256-Manifest
 * - Idempotent: kann beliebig oft laufen
 * - Cleanup von Orphans (Source gelöscht → Outputs weg)
 * - Crash-Recovery: Manifest wird nach jedem Bild geschrieben
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, basename, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import pLimit from 'p-limit';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SOURCE_DIR = join(ROOT, 'images/source');
const OUT_DIR = join(ROOT, 'images/optimized');
const MANIFEST_PATH = join(ROOT, 'images/manifest.json');

const FORCE = process.argv.includes('--force');
const CLEANUP_ONLY = process.argv.includes('--cleanup-only');

// libvips: bei 4 vCPU + AVIF lieber niedrige Concurrency, sonst RAM-Spike
sharp.concurrency(2);
sharp.cache({ memory: 256, files: 50 });

// ─── Variant Definitions ────────────────────────────────────────────────────
const RESPONSIVE_WIDTHS = [400, 800, 1200];
const ASPECT_RATIOS = {
  '16x9': { ratio: 16 / 9, label: '16x9' },
  '4x3':  { ratio: 4 / 3,  label: '4x3' },
};
const FIXED_VARIANTS = [
  { label: 'pin',    w: 1000, h: 1500, formats: ['jpg', 'webp'] },          // Pinterest 2:3
  { label: 'square', w: 1200, h: 1200, formats: ['jpg'] },                   // Schema.org 1:1
  { label: 'og',     w: 1200, h: 630,  formats: ['jpg'] },                   // OpenGraph
  { label: 'legacy', w: 800,  h: 450,  formats: ['jpg'] },                   // Legacy {slug}.jpg
];

const FORMAT_OPTS = {
  avif: (size) => ({
    quality: size >= 800 ? 65 : 60,
    effort: 4,
    chromaSubsampling: '4:2:0',
  }),
  webp: (size) => ({
    quality: size >= 800 ? 82 : 78,
    smartSubsample: true,
    effort: 4,
  }),
  jpg: (size) => ({
    quality: size >= 800 ? 85 : 78,
    mozjpeg: true,
    chromaSubsampling: size >= 800 ? '4:4:4' : '4:2:0',
    progressive: true,
  }),
};

// ─── Helpers ────────────────────────────────────────────────────────────────
async function sha256(filepath) {
  const buf = await readFile(filepath);
  return createHash('sha256').update(buf).digest('hex');
}

async function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    return { version: 1, generatedAt: null, images: {} };
  }
  try {
    return JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  } catch (err) {
    console.warn('⚠ Manifest corrupt, starting fresh:', err.message);
    return { version: 1, generatedAt: null, images: {} };
  }
}

async function saveManifest(manifest) {
  manifest.generatedAt = new Date().toISOString();
  await mkdir(dirname(MANIFEST_PATH), { recursive: true });
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

async function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(jpe?g|png|webp|tiff?)$/i.test(entry.name)) yield full;
  }
}

function slugify(filename) {
  return basename(filename, extname(filename))
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// ─── Variant Generation ─────────────────────────────────────────────────────
function buildVariantPlan(slug) {
  const plan = [];

  // Responsive: 3 Breiten × 2 Aspect Ratios × 3 Formate = 18
  for (const [arKey, ar] of Object.entries(ASPECT_RATIOS)) {
    for (const w of RESPONSIVE_WIDTHS) {
      const h = Math.round(w / ar.ratio);
      for (const fmt of ['avif', 'webp', 'jpg']) {
        plan.push({
          path: `${slug}-${w}-${ar.label}.${fmt}`,
          width: w, height: h, format: fmt,
          fit: 'cover', position: 'attention',
        });
      }
    }
  }

  // Fixed: Pinterest, Square, OG, Legacy
  for (const fv of FIXED_VARIANTS) {
    for (const fmt of fv.formats) {
      const filename = fv.label === 'legacy'
        ? `${slug}.${fmt}`
        : `${slug}-${fv.label}.${fmt}`;
      plan.push({
        path: filename,
        width: fv.w, height: fv.h, format: fmt,
        fit: 'cover', position: 'attention',
      });
    }
  }

  return plan;
}

async function processVariant(pipeline, variant, outDir) {
  const outPath = join(outDir, variant.path);
  await mkdir(dirname(outPath), { recursive: true });

  let p = pipeline.clone()
    .resize({
      width: variant.width,
      height: variant.height,
      fit: variant.fit,
      position: variant.position,
      withoutEnlargement: true,
    });

  // Sharpen nur für JPEG/WebP (AVIF reagiert mit Halos)
  if (variant.format !== 'avif') {
    p = p.sharpen({ sigma: 0.8, m1: 0.5, m2: 1.5 });
  }

  const opts = FORMAT_OPTS[variant.format](variant.width);
  if (variant.format === 'avif') p = p.avif(opts);
  else if (variant.format === 'webp') p = p.webp(opts);
  else p = p.jpeg(opts);

  const info = await p.toFile(outPath);
  return { path: relative(ROOT, outPath), bytes: info.size };
}

async function processSource(sourcePath, manifest) {
  const relPath = relative(SOURCE_DIR, sourcePath);
  const slug = slugify(relPath);
  const hash = await sha256(sourcePath);
  const existing = manifest.images[relPath];

  // Skip-Logik: gleicher Hash + alle Outputs vorhanden
  if (!FORCE && existing?.sourceHash === hash) {
    const allExist = existing.outputs.every(o => existsSync(join(ROOT, o.path)));
    if (allExist) {
      console.log(`⊙ skip ${relPath} (unchanged)`);
      return { skipped: true };
    }
    console.log(`↻ re-encode ${relPath} (outputs missing)`);
  } else {
    console.log(`▶ encode ${relPath}`);
  }

  const t0 = Date.now();

  // Base-Pipeline: einmal aus File lesen, dann clone() pro Variant
  const basePipeline = sharp(sourcePath, { failOn: 'error' })
    .autoOrient()                        // EXIF-Orientation
    .pipelineColourspace('rgb16')        // hochpräzise interne Pipeline
    .toColourspace('srgb')               // Web-Output sRGB
    .withIccProfile('srgb')
    .flatten({ background: { r: 255, g: 255, b: 255 } })  // PNG-Alpha → weiß
    .withMetadata({ orientation: 1 });

  // Sanity Check: Original-Dimensionen
  const meta = await sharp(sourcePath).metadata();
  if (meta.width < 1200 || meta.height < 800) {
    console.warn(`  ⚠ low-res source: ${meta.width}×${meta.height} (${relPath})`);
  }

  const plan = buildVariantPlan(slug);
  const outputs = [];
  for (const v of plan) {
    try {
      const result = await processVariant(basePipeline, v, OUT_DIR);
      outputs.push({ ...result, format: v.format, width: v.width, height: v.height });
    } catch (err) {
      console.error(`  ✗ ${v.path}: ${err.message}`);
      throw err;
    }
  }

  manifest.images[relPath] = {
    slug,
    sourceHash: hash,
    sourceWidth: meta.width,
    sourceHeight: meta.height,
    encodedAt: new Date().toISOString(),
    outputs,
  };

  const ms = Date.now() - t0;
  const totalKB = Math.round(outputs.reduce((s, o) => s + o.bytes, 0) / 1024);
  console.log(`  ✓ ${outputs.length} variants, ${totalKB} KB, ${ms}ms`);
  return { processed: true, ms, bytes: outputs.reduce((s, o) => s + o.bytes, 0) };
}

// ─── Cleanup orphaned outputs ───────────────────────────────────────────────
async function cleanup(manifest, currentSourcePaths) {
  const orphanedKeys = Object.keys(manifest.images)
    .filter(k => !currentSourcePaths.has(k));

  let removed = 0;
  for (const key of orphanedKeys) {
    console.log(`✗ orphan: ${key}`);
    for (const out of manifest.images[key].outputs) {
      const full = join(ROOT, out.path);
      try {
        await unlink(full);
        removed++;
      } catch (err) {
        if (err.code !== 'ENOENT') console.warn(`  ⚠ unlink ${out.path}: ${err.message}`);
      }
    }
    delete manifest.images[key];
  }
  if (removed) console.log(`✓ removed ${removed} orphaned files`);
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`AxCooking Image Pipeline`);
  console.log(`sharp ${sharp.versions.sharp} | libvips ${sharp.versions.vips}`);
  console.log(`force=${FORCE} cleanupOnly=${CLEANUP_ONLY}`);

  await mkdir(OUT_DIR, { recursive: true });
  const manifest = await loadManifest();

  // Source-Inventar
  const sourcePaths = new Set();
  for await (const f of walk(SOURCE_DIR)) {
    sourcePaths.add(relative(SOURCE_DIR, f));
  }
  console.log(`Found ${sourcePaths.size} source images`);

  if (sourcePaths.size === 0) {
    console.log('⚠ No source images found in images/source/');
    console.log('  Place images there to start processing.');
    await saveManifest(manifest);
    return;
  }

  // Cleanup zuerst (idempotent, sicher auch bei späterem Crash)
  await cleanup(manifest, sourcePaths);

  if (CLEANUP_ONLY) {
    await saveManifest(manifest);
    console.log('✓ cleanup-only done');
    return;
  }

  // Parallel Encoding
  const limit = pLimit(2);
  const stats = { processed: 0, skipped: 0, totalMs: 0, totalBytes: 0, failed: 0 };

  // Manifest nach jedem Bild persistieren → Crash-Recovery
  let saveLock = Promise.resolve();
  const persistManifest = () => {
    saveLock = saveLock.then(() => saveManifest(manifest)).catch(() => {});
    return saveLock;
  };

  const tasks = [...sourcePaths].map(rel => limit(async () => {
    const full = join(SOURCE_DIR, rel);
    try {
      const r = await processSource(full, manifest);
      if (r.skipped) stats.skipped++;
      else { stats.processed++; stats.totalMs += r.ms; stats.totalBytes += r.bytes; }
      await persistManifest();
    } catch (err) {
      stats.failed++;
      console.error(`✗ FAIL ${rel}: ${err.stack}`);
    }
  }));

  await Promise.all(tasks);
  await saveLock;
  await saveManifest(manifest);

  console.log('\n─── Summary ───');
  console.log(`Processed: ${stats.processed}`);
  console.log(`Skipped:   ${stats.skipped}`);
  console.log(`Failed:    ${stats.failed}`);
  if (stats.processed) {
    console.log(`Avg time:  ${Math.round(stats.totalMs / stats.processed)}ms/image`);
    console.log(`Total out: ${(stats.totalBytes / 1024 / 1024).toFixed(1)} MB`);
  }

  if (stats.failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
