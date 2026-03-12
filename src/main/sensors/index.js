const si             = require('systeminformation');
const fs             = require('fs/promises');
const path           = require('path');
const { execFile }   = require('child_process');
const { Worker }     = require('worker_threads');
const hwinfo         = process.platform === 'win32' ? require('../hwinfo-bridge') : null;

// ---------------------------------------------------------------------------
// Worker Thread for si.* calls on Windows
// Keeps expensive WMI/PowerShell calls off the Electron main thread.
// ---------------------------------------------------------------------------

let _siWorker = null;
let _siWorkerPending = new Map();
let _siWorkerNextId = 0;

function getSiWorker() {
  if (_siWorker) return _siWorker;
  const workerPath = path.join(__dirname, '..', 'sensor-worker.js');
  _siWorker = new Worker(workerPath);
  _siWorker.on('message', ({ id, result, error }) => {
    const p = _siWorkerPending.get(id);
    if (!p) return;
    _siWorkerPending.delete(id);
    error ? p.reject(new Error(error)) : p.resolve(result);
  });
  _siWorker.on('error', (err) => {
    // Drain all pending requests with the error
    for (const [id, p] of _siWorkerPending) {
      _siWorkerPending.delete(id);
      p.reject(err);
    }
    _siWorker = null; // will recreate on next call
  });
  return _siWorker;
}

function siCall(fn, ...args) {
  // On Windows use the worker thread; on other platforms call directly
  if (process.platform === 'win32') {
    return new Promise((resolve, reject) => {
      const id = _siWorkerNextId++;
      _siWorkerPending.set(id, { resolve, reject });
      getSiWorker().postMessage({ id, fn, args });
    });
  }
  return si[fn](...args);
}

// ---------------------------------------------------------------------------
// Per-call caching for expensive si.* calls
// Multiple sensors that read the same underlying data share one system call
// per polling window instead of each spawning their own.
// ---------------------------------------------------------------------------

function makeCachedCall(fn, ttlMs) {
  let cache     = null;
  let cacheTime = 0;
  let pending   = null;
  return () => {
    const now = Date.now();
    if (cache !== null && (now - cacheTime) < ttlMs) return Promise.resolve(cache);
    if (pending) return pending;
    pending = fn().then(result => {
      cache     = result;
      cacheTime = Date.now();
      pending   = null;
      return result;
    }).catch(err => {
      pending = null;
      throw err;
    });
    return pending;
  };
}

const SI_TTL = 900; // ms — shorter than the minimum 1 s poll interval

const getCachedCpuTemperature = makeCachedCall(() => siCall('cpuTemperature'), SI_TTL);
const getCachedCpuLoad         = makeCachedCall(() => siCall('currentLoad'),   SI_TTL);
const getCachedMem             = makeCachedCall(() => siCall('mem'),           SI_TTL);
const getCachedFsSize          = makeCachedCall(() => siCall('fsSize'),        5000);

// Network stats are per-interface, so we keep one cache entry per iface name.
const _netStatsCaches = {};
function getCachedNetworkStats(ifaceName) {
  if (!_netStatsCaches[ifaceName]) {
    _netStatsCaches[ifaceName] = makeCachedCall(() => siCall('networkStats', ifaceName), SI_TTL);
  }
  return _netStatsCaches[ifaceName]();
}

// ---------------------------------------------------------------------------

const DRM_BASE   = '/sys/class/drm';
const HWMON_BASE = '/sys/class/hwmon';

// ---------------------------------------------------------------------------
// Static sensors — guaranteed on all platforms
// ---------------------------------------------------------------------------

const STATIC_SENSORS = [
  {
    id: 'cpu_usage',
    name: 'CPU Usage',
    category: 'cpu',
    unit: '%',
    source: process.platform === 'win32' ? 'lhm' : 'si',
    defaultTopic: '{prefix}/sensor/cpu_usage/state',
    defaultThreshold: 1,
    defaultInterval: 1000,
    poll: async () => {
      // On Windows prefer LHM CPU Total Load — pure HTTP read, no WMI/PowerShell
      if (process.platform === 'win32' && hwinfo) {
        const v = await hwinfo.readFirstMatch('Load',
          /^CPU Total$/i, /^CPU Package$/i, /^Processor Total$/i, /^CPU$/i);
        if (v !== null) return round(v, 1);
      }
      const d = await getCachedCpuLoad();
      return round(d.currentLoad, 1);
    }
  },
  {
    id: 'cpu_temp_max',
    name: 'CPU Temp (max)',
    category: 'cpu',
    unit: '°C',
    source: process.platform === 'win32' ? 'lhm' : 'si',
    defaultTopic: '{prefix}/sensor/cpu_temp_max/state',
    defaultThreshold: 0.1,
    defaultInterval: 1000,
    poll: async () => {
      // On Windows si.cpuTemperature() always returns null — skip it entirely
      if (process.platform === 'win32') {
        const hwinfoTemp = await hwinfo.readCpuTemp();
        if (hwinfoTemp !== null) return hwinfoTemp;
        return readWmiCpuTemp();
      }
      const d = await getCachedCpuTemperature();
      const val = (d.max != null && d.max > 0) ? d.max : d.main;
      return (val != null && val > 0) ? round(val, 1) : null;
    }
  },
  {
    id: 'ram_used_percent',
    name: 'RAM Used',
    category: 'memory',
    unit: '%',
    source: process.platform === 'win32' ? 'lhm' : 'si',
    defaultTopic: '{prefix}/sensor/ram_used_percent/state',
    defaultThreshold: 1,
    defaultInterval: 2000,
    poll: async () => {
      // On Windows prefer LHM Memory Load — no WMI
      if (process.platform === 'win32' && hwinfo) {
        const v = await hwinfo.readFirstMatch('Load',
          /^Memory$/i, /^Physical Memory$/i, /^Used Memory$/i, /^RAM$/i);
        if (v !== null) return round(v, 1);
      }
      const d = await getCachedMem();
      return round(d.active / d.total * 100, 1);
    }
  },
  {
    id: 'ram_used_gb',
    name: 'RAM Used (GB)',
    category: 'memory',
    unit: 'GB',
    source: process.platform === 'win32' ? 'lhm' : 'si',
    defaultTopic: '{prefix}/sensor/ram_used_gb/state',
    defaultThreshold: 0.1,
    defaultInterval: 2000,
    poll: async () => {
      // On Windows prefer LHM Data "Used Memory" (in GB)
      if (process.platform === 'win32' && hwinfo) {
        const v = await hwinfo.readFirstMatch('Data',
          /^Used Memory$/i, /^Memory Used$/i, /^RAM Used$/i);
        if (v !== null) return round(v, 2);
      }
      const d = await getCachedMem();
      return round(d.active / 1073741824, 2);
    }
  }
];

// ---------------------------------------------------------------------------
// Dynamic sensors — discovered at runtime (temperatures, disk, network)
// ---------------------------------------------------------------------------

async function discoverTemperatureSensors() {
  const sensors = [];

  // On Windows, discover core temperatures directly from LHM (avoids si.cpuTemperature())
  if (process.platform === 'win32' && hwinfo) {
    try {
      const temps = await hwinfo.readByType('Temperature');
      if (temps.length > 0) {
        // CPU core temperatures (e.g. "Core #0", "CPU Core #0")
        const coreTemps = temps.filter(t => /Core\s*#?\d+/i.test(t.label) && t.value > 0);
        coreTemps.forEach((t, i) => {
          const label = t.label;
          sensors.push({
            id: `cpu_temp_core${i}`,
            name: `CPU Core ${i} Temp`,
            category: 'cpu',
            unit: '°C',
            source: 'lhm',
            defaultTopic: `{prefix}/sensor/cpu_temp_core${i}/state`,
            defaultThreshold: 0.1,
            defaultInterval: 1000,
            poll: async () => {
              const all = await hwinfo.readByType('Temperature');
              const r = all.find(t => t.label === label);
              return r && r.value > 0 ? round(r.value, 1) : null;
            }
          });
        });

        // Chipset
        const chipset = temps.find(t => /chipset/i.test(t.label) && t.value > 0);
        if (chipset) {
          const label = chipset.label;
          sensors.push({
            id: 'chipset_temp',
            name: 'Chipset Temp',
            category: 'cpu',
            unit: '°C',
            source: 'lhm',
            defaultTopic: '{prefix}/sensor/chipset_temp/state',
            defaultThreshold: 0.5,
            defaultInterval: 5000,
            poll: async () => {
              const all = await hwinfo.readByType('Temperature');
              const r = all.find(t => t.label === label);
              return r && r.value > 0 ? round(r.value, 1) : null;
            }
          });
        }

        return sensors;
      }
    } catch (_) { /* fall through to si path */ }
  }

  try {
    const data = await siCall('cpuTemperature');

    // Individual core temperatures
    if (Array.isArray(data.cores) && data.cores.length > 1) {
      data.cores.forEach((_, i) => {
        sensors.push({
          id: `cpu_temp_core${i}`,
          name: `CPU Core ${i} Temp`,
          category: 'cpu',
          unit: '°C',
          source: 'si',
          defaultTopic: `{prefix}/sensor/cpu_temp_core${i}/state`,
          defaultThreshold: 0.1,
          defaultInterval: 1000,
          poll: async () => {
            const d = await getCachedCpuTemperature();
            const val = d.cores?.[i];
            return (val != null && val > 0) ? round(val, 1) : null;
          }
        });
      });
    }

    // GPU temperature if available
    if (data.gpu != null && data.gpu > 0) {
      sensors.push({
        id: 'gpu_temp',
        name: 'GPU Temp',
        category: 'cpu',
        unit: '°C',
        source: 'si',
        defaultTopic: '{prefix}/sensor/gpu_temp/state',
        defaultThreshold: 0.5,
        defaultInterval: 2000,
        poll: async () => {
          const d = await getCachedCpuTemperature();
          return (d.gpu != null && d.gpu > 0) ? round(d.gpu, 1) : null;
        }
      });
    }

    // Chipset temperature if available
    if (data.chipset != null && data.chipset > 0) {
      sensors.push({
        id: 'chipset_temp',
        name: 'Chipset Temp',
        category: 'cpu',
        unit: '°C',
        source: 'si',
        defaultTopic: '{prefix}/sensor/chipset_temp/state',
        defaultThreshold: 0.5,
        defaultInterval: 5000,
        poll: async () => {
          const d = await getCachedCpuTemperature();
          return (d.chipset != null && d.chipset > 0) ? round(d.chipset, 1) : null;
        }
      });
    }
  } catch (_) {
    // Temperature sensors not available on this platform — skip silently
  }
  return sensors;
}

async function discoverGpuSensors() {
  if (process.platform === 'linux') return discoverGpuSensorsLinux();
  if (process.platform === 'win32') return discoverGpuSensorsWindows();
  return [];
}

// ── Linux GPU discovery (AMD sysfs) ──────────────────────────────────────────

async function discoverGpuSensorsLinux() {
  const sensors = [];

  try {
    // ── 1. Find discrete AMD GPU card ─────────────────────────────────────
    const cards = await readAmdDrmCards();
    const discrete = cards.find(c => c.vramTotal > 2 * 1024 * 1024 * 1024);
    if (!discrete) return [];

    const { deviceDir, pciAddr } = discrete;

    // ── 2. Usage ──────────────────────────────────────────────────────────
    const busyPath = `${deviceDir}/gpu_busy_percent`;
    if (await readSysInt(busyPath) !== null) {
      sensors.push({
        id: 'gpu_usage',
        name: 'GPU Usage',
        category: 'gpu',
        unit: '%',
        source: 'sysfs',
        defaultTopic: '{prefix}/sensor/gpu_usage/state',
        defaultThreshold: 1,
        defaultInterval: 1000,
        poll: async () => readSysInt(busyPath)
      });
    }

    // ── 3. VRAM used (GB + %) ─────────────────────────────────────────────
    const vramUsedPath  = `${deviceDir}/mem_info_vram_used`;
    const vramTotalPath = `${deviceDir}/mem_info_vram_total`;

    if (await readSysInt(vramUsedPath) !== null) {
      sensors.push({
        id: 'gpu_vram_used_gb',
        name: 'GPU VRAM Used (GB)',
        category: 'gpu',
        unit: 'GB',
        source: 'sysfs',
        defaultTopic: '{prefix}/sensor/gpu_vram_used_gb/state',
        defaultThreshold: 0.1,
        defaultInterval: 2000,
        poll: async () => {
          const v = await readSysInt(vramUsedPath);
          return v !== null ? round(v / 1073741824, 2) : null;
        }
      });

      sensors.push({
        id: 'gpu_vram_used_percent',
        name: 'GPU VRAM Used (%)',
        category: 'gpu',
        unit: '%',
        source: 'sysfs',
        defaultTopic: '{prefix}/sensor/gpu_vram_used_percent/state',
        defaultThreshold: 1,
        defaultInterval: 2000,
        poll: async () => {
          const [used, total] = await Promise.all([
            readSysInt(vramUsedPath),
            readSysInt(vramTotalPath)
          ]);
          if (used === null || !total) return null;
          return round(used / total * 100, 1);
        }
      });
    }

    // ── 4. Temperatures from hwmon ────────────────────────────────────────
    const hwmonDir = await findAmdgpuHwmon(pciAddr);
    if (hwmonDir) {
      const TEMP_NAMES = {
        edge:     'GPU Temp (edge)',
        junction: 'GPU Temp (junction)',
        mem:      'GPU VRAM Temp'
      };

      const tempFiles = (await fs.readdir(hwmonDir)).filter(f => /^temp\d+_input$/.test(f));
      for (const tf of tempFiles) {
        const labelFile = path.join(hwmonDir, tf.replace('_input', '_label'));
        const label = await readSysFile(labelFile);
        if (!label || !TEMP_NAMES[label]) continue;

        const inputPath = path.join(hwmonDir, tf);
        sensors.push({
          id: `gpu_temp_${label}`,
          name: TEMP_NAMES[label],
          category: 'gpu',
          unit: '°C',
          source: 'sysfs',
          defaultTopic: `{prefix}/sensor/gpu_temp_${label}/state`,
          defaultThreshold: 0.5,
          defaultInterval: 2000,
          poll: async () => {
            const millideg = await readSysInt(inputPath);
            return millideg !== null ? round(millideg / 1000, 1) : null;
          }
        });
      }
    }
  } catch (_) {
    // GPU sensors not available — skip silently
  }

  return sensors;
}

// ── Windows GPU discovery (LHM preferred, fallback: si.graphics() + perf counters) ──

async function discoverGpuSensorsWindows() {
  const sensors = [];

  try {
    // First try: discover GPU sensors from LHM (covers temp, load, fans, VRAM, etc.)
    if (hwinfo) {
      const lhmSensors = await discoverGpuSensorsFromLhm();
      if (lhmSensors.length > 0) return lhmSensors;
    }

    // Fallback: detect discrete GPU via si.graphics() + Windows perf counters
    const { controllers } = await siCall('graphics');
    const discrete = (controllers || [])
      .filter(c => c.vram > 1024)
      .sort((a, b) => b.vram - a.vram)[0];
    if (!discrete) return [];

    // Verify that the Windows GPU performance counters are available
    const testUsage = await getCachedGpuUsageWindows();
    if (testUsage === null) return [];

    sensors.push({
      id: 'gpu_usage',
      name: 'GPU Usage',
      category: 'gpu',
      unit: '%',
      source: 'win-api',
      defaultTopic: '{prefix}/sensor/gpu_usage/state',
      defaultThreshold: 1,
      defaultInterval: 2000,
      poll: getCachedGpuUsageWindows
    });
  } catch (_) {
    // GPU sensors not available — skip silently
  }

  return sensors;
}

// Discover GPU sensors directly from LHM using device-aware readings.
// Handles both AMD (D3D-based labels) and NVIDIA (GPU-labelled sensors).
const GPU_DEVICE_RE = /geforce|radeon|rtx|gtx|rx\s*\d|vega|navi|polaris|quadro|tesla|intel.*arc|uhd.*graphics|iris.*graphics/i;

// Priority-ordered patterns for GPU usage: prefer native GPU Core, fall back to D3D 3D
const GPU_USAGE_PATTERNS = [/^GPU Core$/i, /^GPU$/i, /^D3D 3D$/i, /^D3D/i];

function escapeRe(s) {
  return new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
}

async function discoverGpuSensorsFromLhm() {
  const sensors = [];
  try {
    const byDevice = await hwinfo.readByDevice();
    if (!byDevice) return sensors;

    for (const [deviceName, readings] of Object.entries(byDevice)) {
      if (!GPU_DEVICE_RE.test(deviceName)) continue;

      const devId = deviceName.toLowerCase()
        .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');

      const makePoller = (type, labelRe) => async () => {
        const dev = await hwinfo.readByDevice();
        if (!dev || !dev[deviceName]) return null;
        const r = dev[deviceName].find(x => x.type === type && labelRe.test(x.label));
        return r != null ? round(r.value, 1) : null;
      };

      // ── Usage % ──────────────────────────────────────────────────────────
      const usageReading = GPU_USAGE_PATTERNS
        .map(re => readings.find(r => r.type === 'Load' && re.test(r.label)))
        .find(Boolean);

      if (usageReading) {
        sensors.push({
          id: `gpu_${devId}_usage`,
          name: `${deviceName} Usage`,
          category: 'gpu',
          unit: '%',
          source: 'lhm',
          defaultTopic: `{prefix}/sensor/gpu_${devId}_usage/state`,
          defaultThreshold: 1,
          defaultInterval: 2000,
          poll: makePoller('Load', escapeRe(usageReading.label))
        });
      }

      // ── All temperatures ──────────────────────────────────────────────────
      // Priority order for the "main" temp shown first; then expose all others
      const TEMP_PRIO_RE = [/^GPU Core$/i, /^GPU$/i, /^GPU Package$/i, /^Edge$/i];
      const allTemps = readings.filter(r => r.type === 'Temperature' && r.value > 0);

      // Sort: priority temps first, then alphabetically
      allTemps.sort((a, b) => {
        const pa = TEMP_PRIO_RE.findIndex(re => re.test(a.label));
        const pb = TEMP_PRIO_RE.findIndex(re => re.test(b.label));
        const ra = pa === -1 ? 99 : pa;
        const rb = pb === -1 ? 99 : pb;
        return ra !== rb ? ra - rb : a.label.localeCompare(b.label);
      });

      for (const t of allTemps) {
        const safeTempId = t.label.toLowerCase()
          .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
        sensors.push({
          id: `gpu_${devId}_temp_${safeTempId}`,
          name: `${deviceName} ${t.label}`,
          category: 'gpu',
          unit: '°C',
          source: 'lhm',
          defaultTopic: `{prefix}/sensor/gpu_${devId}_temp_${safeTempId}/state`,
          defaultThreshold: 0.5,
          defaultInterval: 2000,
          poll: makePoller('Temperature', escapeRe(t.label))
        });
      }

      // ── Fan speed ─────────────────────────────────────────────────────────
      const fanReading = readings.find(r => r.type === 'Fan' && /GPU Fan|Fan/i.test(r.label));
      if (fanReading) {
        sensors.push({
          id: `gpu_${devId}_fan_rpm`,
          name: `${deviceName} Fan`,
          category: 'gpu',
          unit: 'RPM',
          source: 'lhm',
          defaultTopic: `{prefix}/sensor/gpu_${devId}_fan_rpm/state`,
          defaultThreshold: 50,
          defaultInterval: 2000,
          poll: makePoller('Fan', escapeRe(fanReading.label))
        });
      }

      // ── Power (W) ─────────────────────────────────────────────────────────
      const powerReading = readings.find(r => r.type === 'Power' && /GPU Package|GPU Core|GPU$/i.test(r.label));
      if (powerReading) {
        sensors.push({
          id: `gpu_${devId}_power_w`,
          name: `${deviceName} Power`,
          category: 'gpu',
          unit: 'W',
          source: 'lhm',
          defaultTopic: `{prefix}/sensor/gpu_${devId}_power_w/state`,
          defaultThreshold: 1,
          defaultInterval: 2000,
          poll: makePoller('Power', escapeRe(powerReading.label))
        });
      }

      // ── VRAM Used (MB) + Used % ───────────────────────────────────────────
      const vramUsed = readings.find(r => r.type === 'Data' && /^GPU Memory Used$/i.test(r.label))
                    || readings.find(r => r.type === 'Data' && /D3D Dedicated Memory Used/i.test(r.label));
      const vramTotal = readings.find(r => r.type === 'Data' && /^GPU Memory Total$/i.test(r.label))
                     || readings.find(r => r.type === 'Data' && /D3D Dedicated Memory Total/i.test(r.label));

      if (vramUsed) {
        const vramUsedRe  = escapeRe(vramUsed.label);
        sensors.push({
          id: `gpu_${devId}_vram_used_mb`,
          name: `${deviceName} VRAM Used`,
          category: 'gpu',
          unit: 'MB',
          source: 'lhm',
          defaultTopic: `{prefix}/sensor/gpu_${devId}_vram_used_mb/state`,
          defaultThreshold: 50,
          defaultInterval: 2000,
          poll: makePoller('Data', vramUsedRe)
        });

        if (vramTotal && vramTotal.value > 0) {
          const vramTotalRe = escapeRe(vramTotal.label);
          sensors.push({
            id: `gpu_${devId}_vram_percent`,
            name: `${deviceName} VRAM %`,
            category: 'gpu',
            unit: '%',
            source: 'lhm',
            defaultTopic: `{prefix}/sensor/gpu_${devId}_vram_percent/state`,
            defaultThreshold: 1,
            defaultInterval: 2000,
            poll: async () => {
              const dev = await hwinfo.readByDevice();
              if (!dev || !dev[deviceName]) return null;
              const used  = dev[deviceName].find(x => x.type === 'Data' && vramUsedRe.test(x.label));
              const total = dev[deviceName].find(x => x.type === 'Data' && vramTotalRe.test(x.label));
              if (!used || !total || !total.value) return null;
              return round(used.value / total.value * 100, 1);
            }
          });
        }
      }
    }
  } catch (_) { /* ignore */ }
  return sensors;
}

// Queries Windows GPU performance counters (3D engine utilization, summed).
// Works natively on Windows 10/11 without third-party tools.
function _pollGpuUsageWindowsRaw() {
  return new Promise((resolve) => {
    const script =
      'try {' +
      ' $v = (Get-WmiObject -Query "SELECT UtilizationPercentage FROM Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine" -ErrorAction Stop' +
      ' | Where-Object { $_.Name -like "*engtype_3D*" }' +
      ' | Measure-Object -Property UtilizationPercentage -Sum).Sum;' +
      ' Write-Output ([math]::Min([int]$v, 100))' +
      '} catch { Write-Output "" }';

    execFile('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 4000 }, (err, stdout) => {
      if (err || !stdout.trim()) return resolve(null);
      const val = parseFloat(stdout.trim());
      resolve(isNaN(val) ? null : val);
    });
  });
}

// Cached wrapper — avoids spawning PowerShell on every poll tick
const getCachedGpuUsageWindows = makeCachedCall(_pollGpuUsageWindowsRaw, SI_TTL);

// ── Windows WMI CPU temperature fallback ────────────────────────────────────

// Reads thermal zones via MSAcpi_ThermalZoneTemperature (requires admin rights).
// Returns the highest valid reading in °C, or null if unavailable.
function _readWmiCpuTempRaw() {
  return new Promise((resolve) => {
    const script =
      'try {' +
      ' $t = Get-WmiObject MSAcpi_ThermalZoneTemperature -Namespace "root/wmi" -ErrorAction Stop;' +
      ' $max = ($t | ForEach-Object { [math]::Round(($_.CurrentTemperature - 2732) / 10.0, 1) } | Measure-Object -Maximum).Maximum;' +
      ' if ($max -gt 0) { Write-Output $max } else { Write-Output "" }' +
      '} catch { Write-Output "" }';

    execFile('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout.trim()) return resolve(null);
      const val = parseFloat(stdout.trim());
      resolve(isNaN(val) || val <= 0 ? null : val);
    });
  });
}

const readWmiCpuTemp = makeCachedCall(_readWmiCpuTempRaw, SI_TTL);

// ── sysfs helpers ────────────────────────────────────────────────────────────

async function readSysFile(filePath) {
  try {
    return (await fs.readFile(filePath, 'utf8')).trim();
  } catch {
    return null;
  }
}

async function readSysInt(filePath) {
  const v = await readSysFile(filePath);
  if (v === null) return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

async function readAmdDrmCards() {
  let entries;
  try {
    entries = await fs.readdir(DRM_BASE);
  } catch {
    return [];
  }

  const cards = [];
  for (const name of entries.filter(e => /^card\d+$/.test(e))) {
    const deviceDir = path.join(DRM_BASE, name, 'device');
    const vramTotal = await readSysInt(path.join(deviceDir, 'mem_info_vram_total'));
    if (vramTotal === null) continue;

    // Resolve PCI address via symlink: .../device → ../../0000:03:00.0
    let pciAddr = null;
    try {
      const link = await fs.readlink(path.join(DRM_BASE, name, 'device'));
      pciAddr = link.split('/').pop();
    } catch { /* ignore */ }

    cards.push({ name, deviceDir, vramTotal, pciAddr });
  }
  return cards;
}

async function findAmdgpuHwmon(pciAddr) {
  let entries;
  try {
    entries = await fs.readdir(HWMON_BASE);
  } catch {
    return null;
  }

  for (const name of entries) {
    const hwmonDir = path.join(HWMON_BASE, name);
    if (await readSysFile(path.join(hwmonDir, 'name')) !== 'amdgpu') continue;
    if (!pciAddr) return hwmonDir; // fallback: return first amdgpu hwmon

    try {
      const link = await fs.readlink(path.join(hwmonDir, 'device'));
      if (link.split('/').pop() === pciAddr) return hwmonDir;
    } catch { /* ignore */ }
  }
  return null;
}



// ── LHM-based disk discovery ──────────────────────────────────────────────────
// Reads Read Rate, Write Rate, Used Space and Free Space directly from LHM.
// Called before si-based discovery; skipped if LHM is not running.

// Label patterns expected from LHM for disk devices
const LHM_DISK_THROUGHPUT = { read: /read rate/i, write: /write rate/i };
const LHM_DISK_LOAD       = { used: /used space/i };
const LHM_DISK_DATA       = { free: /free space/i };

// Heuristic: a device is a storage device if it has Read Rate / Write Rate throughput sensors
function isLhmDiskDevice(readings) {
  return readings.some(r => r.type === 'Throughput' && LHM_DISK_THROUGHPUT.read.test(r.label));
}

async function discoverDiskSensorsFromLhm() {
  const sensors = [];
  try {
    const byDevice = await hwinfo.readByDevice();
    if (!byDevice) return sensors;

    for (const [deviceName, readings] of Object.entries(byDevice)) {
      if (!isLhmDiskDevice(readings)) continue;

      const safeId = deviceName.toLowerCase()
        .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');

      const makePoller = (type, labelRe) => async () => {
        const dev = await hwinfo.readByDevice();
        if (!dev || !dev[deviceName]) return null;
        const r = dev[deviceName].find(x => x.type === type && labelRe.test(x.label));
        return r != null ? round(r.value, 1) : null;
      };

      sensors.push({
        id: `disk_${safeId}_read_kbs`,
        name: `${deviceName} Read`,
        category: 'disk',
        unit: 'KB/s',
        source: 'lhm',
        defaultTopic: `{prefix}/sensor/disk_${safeId}_read_kbs/state`,
        defaultThreshold: 10,
        defaultInterval: 2000,
        poll: makePoller('Throughput', LHM_DISK_THROUGHPUT.read)
      });

      sensors.push({
        id: `disk_${safeId}_write_kbs`,
        name: `${deviceName} Write`,
        category: 'disk',
        unit: 'KB/s',
        source: 'lhm',
        defaultTopic: `{prefix}/sensor/disk_${safeId}_write_kbs/state`,
        defaultThreshold: 10,
        defaultInterval: 2000,
        poll: makePoller('Throughput', LHM_DISK_THROUGHPUT.write)
      });

      if (readings.some(r => r.type === 'Load' && LHM_DISK_LOAD.used.test(r.label))) {
        sensors.push({
          id: `disk_${safeId}_use_percent`,
          name: `${deviceName} Usage`,
          category: 'disk',
          unit: '%',
          source: 'lhm',
          defaultTopic: `{prefix}/sensor/disk_${safeId}_use_percent/state`,
          defaultThreshold: 1,
          defaultInterval: 30000,
          poll: makePoller('Load', LHM_DISK_LOAD.used)
        });
      }

      if (readings.some(r => r.type === 'Data' && LHM_DISK_DATA.free.test(r.label))) {
        sensors.push({
          id: `disk_${safeId}_free_gb`,
          name: `${deviceName} Free`,
          category: 'disk',
          unit: 'GB',
          source: 'lhm',
          defaultTopic: `{prefix}/sensor/disk_${safeId}_free_gb/state`,
          defaultThreshold: 0.5,
          defaultInterval: 30000,
          poll: makePoller('Data', LHM_DISK_DATA.free)
        });
      }
    }
  } catch (_) { /* ignore */ }
  return sensors;
}

// ── LHM-based network discovery ───────────────────────────────────────────────
// Reads Download Speed, Upload Speed and Network Utilization directly from LHM.

const LHM_NET_THROUGHPUT = { rx: /download speed/i, tx: /upload speed/i };
const LHM_NET_LOAD       = { util: /network utilization/i };

// Virtual/irrelevant adapter name patterns to skip
const LHM_NET_SKIP = [
  /debugger/i, /QoS Packet Scheduler/i, /WFP/i, /Npcap/i, /Hyper-V/i,
  /VMware/i, /VirtualBox/i, /Loopback/i, /Teredo/i, /ISATAP/i,
  /6to4/i, /WAN Miniport/i, /Bluetooth/i
];

function isLhmNetDevice(deviceName, readings) {
  if (LHM_NET_SKIP.some(re => re.test(deviceName))) return false;
  return readings.some(r => r.type === 'Throughput' &&
    (LHM_NET_THROUGHPUT.rx.test(r.label) || LHM_NET_THROUGHPUT.tx.test(r.label)));
}

async function discoverNetworkSensorsFromLhm() {
  const sensors = [];
  try {
    const byDevice = await hwinfo.readByDevice();
    if (!byDevice) return sensors;

    for (const [deviceName, readings] of Object.entries(byDevice)) {
      if (!isLhmNetDevice(deviceName, readings)) continue;

      const safeId = deviceName.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');

      const makePoller = (type, labelRe) => async () => {
        const dev = await hwinfo.readByDevice();
        if (!dev || !dev[deviceName]) return null;
        const r = dev[deviceName].find(x => x.type === type && labelRe.test(x.label));
        return r != null ? round(r.value, 1) : null;
      };

      sensors.push({
        id: `net_${safeId}_rx_kbs`,
        name: `${deviceName} Download`,
        category: 'network',
        unit: 'KB/s',
        source: 'lhm',
        defaultTopic: `{prefix}/sensor/net_${safeId}_rx_kbs/state`,
        defaultThreshold: 10,
        defaultInterval: 2000,
        poll: makePoller('Throughput', LHM_NET_THROUGHPUT.rx)
      });

      sensors.push({
        id: `net_${safeId}_tx_kbs`,
        name: `${deviceName} Upload`,
        category: 'network',
        unit: 'KB/s',
        source: 'lhm',
        defaultTopic: `{prefix}/sensor/net_${safeId}_tx_kbs/state`,
        defaultThreshold: 10,
        defaultInterval: 2000,
        poll: makePoller('Throughput', LHM_NET_THROUGHPUT.tx)
      });

      if (readings.some(r => r.type === 'Load' && LHM_NET_LOAD.util.test(r.label))) {
        sensors.push({
          id: `net_${safeId}_utilization`,
          name: `${deviceName} Utilization`,
          category: 'network',
          unit: '%',
          source: 'lhm',
          defaultTopic: `{prefix}/sensor/net_${safeId}_utilization/state`,
          defaultThreshold: 1,
          defaultInterval: 2000,
          poll: makePoller('Load', LHM_NET_LOAD.util)
        });
      }
    }
  } catch (_) { /* ignore */ }
  return sensors;
}


async function discoverDiskSensors() {
  // On Windows: try LHM first (no WMI overhead); fall back to si for volume-level data
  if (process.platform === 'win32' && hwinfo) {
    const lhmSensors = await discoverDiskSensorsFromLhm();
    if (lhmSensors.length > 0) return lhmSensors;
  }

  const drives = await siCall('fsSize');
  const sensors = [];

  // Exclude non-user-facing virtual/system mounts
  const EXCLUDED_PREFIXES = ['/sys', '/proc', '/dev', '/run', '/snap', '/boot/efi', '/boot/grub'];
  const EXCLUDED_TYPES    = ['squashfs', 'tmpfs', 'devtmpfs', 'devfs', 'efivarfs'];

  for (const drive of drives) {
    if (!drive.size || drive.size === 0) continue;
    if (EXCLUDED_TYPES.includes(drive.type)) continue;
    if (EXCLUDED_PREFIXES.some(p => drive.mount.startsWith(p))) continue;

    const safeMount = drive.mount.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '') || 'root';
    const mount = drive.mount;
    sensors.push({
      id: `disk_${safeMount}_use_percent`,
      name: `Disk ${mount} Usage`,
      category: 'disk',
      unit: '%',
      source: 'si',
      defaultTopic: `{prefix}/sensor/disk_${safeMount}_use_percent/state`,
      defaultThreshold: 1,
      defaultInterval: 30000,
      poll: async () => {
        const list = await getCachedFsSize();
        const d = list.find(x => x.mount === mount);
        return d ? round(d.use, 1) : null;
      }
    });
    sensors.push({
      id: `disk_${safeMount}_free_gb`,
      name: `Disk ${mount} Free`,
      category: 'disk',
      unit: 'GB',
      source: 'si',
      defaultTopic: `{prefix}/sensor/disk_${safeMount}_free_gb/state`,
      defaultThreshold: 0.5,
      defaultInterval: 30000,
      poll: async () => {
        const list = await getCachedFsSize();
        const d = list.find(x => x.mount === mount);
        return d ? round((d.size - d.used) / 1073741824, 2) : null;
      }
    });
  }
  return sensors;
}

async function discoverNetworkSensors() {
  // On Windows: try LHM first (no WMI overhead); fall back to si
  if (process.platform === 'win32' && hwinfo) {
    const lhmSensors = await discoverNetworkSensorsFromLhm();
    if (lhmSensors.length > 0) return lhmSensors;
  }

  const ifaces = await siCall('networkInterfaces');
  const sensors = [];

  // Exclude loopback and common virtual/container interfaces
  const EXCLUDED_PREFIXES = ['lo', 'docker', 'veth', 'virbr', 'br-', 'tun', 'tap', 'vmnet'];

  for (const iface of ifaces) {
    if (iface.internal) continue;
    if (EXCLUDED_PREFIXES.some(p => iface.iface.startsWith(p))) continue;
    const safeId = iface.iface.replace(/[^a-zA-Z0-9]/g, '_');
    const ifaceName = iface.iface;
    sensors.push({
      id: `net_${safeId}_rx_kbs`,
      name: `${ifaceName} Download`,
      category: 'network',
      unit: 'KB/s',
      source: 'si',
      defaultTopic: `{prefix}/sensor/net_${safeId}_rx_kbs/state`,
      defaultThreshold: 10,
      defaultInterval: 2000,
      poll: async () => {
        const stats = await getCachedNetworkStats(ifaceName);
        const s = Array.isArray(stats) ? stats[0] : stats;
        return s ? round(s.rx_sec / 1024, 1) : null;
      }
    });
    sensors.push({
      id: `net_${safeId}_tx_kbs`,
      name: `${ifaceName} Upload`,
      category: 'network',
      unit: 'KB/s',
      source: 'si',
      defaultTopic: `{prefix}/sensor/net_${safeId}_tx_kbs/state`,
      defaultThreshold: 10,
      defaultInterval: 2000,
      poll: async () => {
        const stats = await getCachedNetworkStats(ifaceName);
        const s = Array.isArray(stats) ? stats[0] : stats;
        return s ? round(s.tx_sec / 1024, 1) : null;
      }
    });
  }
  return sensors;
}

async function discoverSensors() {
  const [tempSensors, gpuSensors, diskSensors, netSensors] = await Promise.all([
    discoverTemperatureSensors(),
    discoverGpuSensors(),
    discoverDiskSensors(),
    discoverNetworkSensors()
  ]);
  return [...STATIC_SENSORS, ...tempSensors, ...gpuSensors, ...diskSensors, ...netSensors];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round(value, decimals) {
  return parseFloat(Number(value).toFixed(decimals));
}

module.exports = { discoverSensors, STATIC_SENSORS };
