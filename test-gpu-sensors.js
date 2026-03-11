#!/usr/bin/env node
/**
 * test-gpu-sensors.js
 * Verifica la lettura dei dati GPU AMD da sysfs (Linux only).
 * Nessuna dipendenza esterna — usa solo fs/promises e path.
 *
 * Usage: node test-gpu-sensors.js
 */

const fs = require('fs/promises');
const path = require('path');

const DRM_BASE  = '/sys/class/drm';
const HWMON_BASE = '/sys/class/hwmon';

// ── helpers ────────────────────────────────────────────────────────────────

async function readSysFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return raw.trim();
  } catch {
    return null;
  }
}

async function readSysInt(filePath) {
  const val = await readSysFile(filePath);
  if (val === null) return null;
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

function bytesToGB(bytes) {
  return (bytes / 1024 / 1024 / 1024).toFixed(2);
}

// ── GPU card discovery ─────────────────────────────────────────────────────

async function discoverGpuCards() {
  let entries;
  try {
    entries = await fs.readdir(DRM_BASE);
  } catch {
    console.error(`[ERROR] Cannot read ${DRM_BASE} — not on Linux?`);
    return [];
  }

  // Keep only "cardN" (no connectors like card1-DP-1)
  const cardNames = entries.filter(e => /^card\d+$/.test(e));

  const cards = [];
  for (const cardName of cardNames) {
    const deviceDir = path.join(DRM_BASE, cardName, 'device');

    const vramTotal = await readSysInt(path.join(deviceDir, 'mem_info_vram_total'));
    const vramUsed  = await readSysInt(path.join(deviceDir, 'mem_info_vram_used'));
    const gpuBusy   = await readSysInt(path.join(deviceDir, 'gpu_busy_percent'));
    const vendor    = await readSysFile(path.join(deviceDir, 'vendor'));

    // Skip entries that don't have any GPU-specific sysfs files
    if (vramTotal === null && gpuBusy === null) continue;

    cards.push({ name: cardName, deviceDir, vramTotal, vramUsed, gpuBusy, vendor });
  }

  return cards;
}

// ── hwmon temperature discovery ────────────────────────────────────────────

async function discoverAmdgpuTemps() {
  let entries;
  try {
    entries = await fs.readdir(HWMON_BASE);
  } catch {
    console.error(`[ERROR] Cannot read ${HWMON_BASE}`);
    return [];
  }

  const results = [];
  for (const hwmonName of entries) {
    const hwmonDir = path.join(HWMON_BASE, hwmonName);
    const driverName = await readSysFile(path.join(hwmonDir, 'name'));
    if (driverName !== 'amdgpu') continue;

    // Collect all temp*_input files
    let files;
    try {
      files = await fs.readdir(hwmonDir);
    } catch {
      continue;
    }

    const tempFiles = files.filter(f => /^temp\d+_input$/.test(f));
    const temps = [];
    for (const tf of tempFiles) {
      const millideg = await readSysInt(path.join(hwmonDir, tf));
      if (millideg !== null) {
        const labelFile = tf.replace('_input', '_label');
        const label = await readSysFile(path.join(hwmonDir, labelFile)) || tf;
        temps.push({ label, celsius: millideg / 1000 });
      }
    }

    // Try to find which card this hwmon belongs to
    let linkedCard = null;
    try {
      const deviceLink = await fs.readlink(path.join(hwmonDir, 'device'));
      // deviceLink is something like ../../0000:03:00.0
      // Look for a drm card whose device symlink resolves to the same PCI addr
      linkedCard = deviceLink.split('/').pop();
    } catch { /* no symlink — skip */ }

    results.push({ hwmonName, temps, linkedCard });
  }

  return results;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════');
  console.log('  AMD GPU sysfs sensor test');
  console.log('═══════════════════════════════════════\n');

  // ── 1. DRM cards ──────────────────────────────────────────────────────
  console.log('▶ Discovering GPU cards via /sys/class/drm ...\n');
  const cards = await discoverGpuCards();

  if (cards.length === 0) {
    console.log('  [SKIP] No GPU cards with sysfs stats found.');
  } else {
    for (const card of cards) {
      const vramGB     = card.vramTotal ? bytesToGB(card.vramTotal) : 'n/a';
      const vramUsedGB = card.vramUsed  ? bytesToGB(card.vramUsed)  : 'n/a';
      const busy       = card.gpuBusy !== null ? `${card.gpuBusy}%` : 'n/a';
      const isDiscrete = card.vramTotal && card.vramTotal > 2 * 1024 * 1024 * 1024;

      console.log(`  [${card.name}] ${isDiscrete ? '(discrete)' : '(integrated)'}`);
      console.log(`    vendor          : ${card.vendor ?? 'n/a'}`);
      console.log(`    gpu_busy_percent: ${busy}`);
      console.log(`    vram_used       : ${vramUsedGB} GB`);
      console.log(`    vram_total      : ${vramGB} GB`);
      console.log(`    deviceDir       : ${card.deviceDir}`);
      console.log();
    }
  }

  // ── 2. hwmon temperatures ─────────────────────────────────────────────
  console.log('▶ Discovering amdgpu hwmon temperature entries ...\n');
  const hwmons = await discoverAmdgpuTemps();

  if (hwmons.length === 0) {
    console.log('  [SKIP] No amdgpu hwmon entries found.');
  } else {
    for (const h of hwmons) {
      console.log(`  [${h.hwmonName}] linked device: ${h.linkedCard ?? 'unknown'}`);
      if (h.temps.length === 0) {
        console.log('    No temp*_input files found.');
      } else {
        for (const t of h.temps) {
          console.log(`    ${t.label.padEnd(20)}: ${t.celsius} °C`);
        }
      }
      console.log();
    }
  }

  // ── 3. Summary / verdict ──────────────────────────────────────────────
  console.log('═══════════════════════════════════════');
  const hasCards  = cards.length > 0;
  const hasTemps  = hwmons.length > 0 && hwmons.some(h => h.temps.length > 0);
  const discrete  = cards.find(c => c.vramTotal && c.vramTotal > 2 * 1024 * 1024 * 1024);

  console.log(`  GPU cards found  : ${cards.length}`);
  console.log(`  Discrete GPU     : ${discrete ? discrete.name : 'not found'}`);
  console.log(`  Usage readable   : ${hasCards && cards.some(c => c.gpuBusy !== null) ? '✓ YES' : '✗ NO'}`);
  console.log(`  VRAM readable    : ${hasCards && cards.some(c => c.vramTotal !== null) ? '✓ YES' : '✗ NO'}`);
  console.log(`  Temperature read : ${hasTemps ? '✓ YES' : '✗ NO'}`);
  console.log('═══════════════════════════════════════\n');

  if (hasCards && hasTemps) {
    console.log('  ✅ Tutti i dati GPU sono leggibili — pronto per l\'implementazione!\n');
  } else {
    console.log('  ⚠️  Alcuni dati non sono disponibili — vedi sopra per i dettagli.\n');
  }
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
