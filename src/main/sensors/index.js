const si             = require('systeminformation');
const fs             = require('fs/promises');
const path           = require('path');
const { execFile }   = require('child_process');
const hwinfo         = process.platform === 'win32' ? require('../hwinfo-bridge') : null;

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
    defaultTopic: '{prefix}/sensor/cpu_usage/state',
    defaultThreshold: 1,
    defaultInterval: 1000,
    poll: async () => {
      const d = await si.currentLoad();
      return round(d.currentLoad, 1);
    }
  },
  {
    id: 'cpu_temp_max',
    name: 'CPU Temp (max)',
    category: 'cpu',
    unit: '°C',
    defaultTopic: '{prefix}/sensor/cpu_temp_max/state',
    defaultThreshold: 0.1,
    defaultInterval: 1000,
    poll: async () => {
      const d = await si.cpuTemperature();
      const val = (d.max != null && d.max > 0) ? d.max : d.main;
      if (val != null && val > 0) return round(val, 1);
      // Windows fallback: try HWiNFO64 shared memory first, then WMI thermal zones
      if (process.platform === 'win32') {
        const hwinfoTemp = await hwinfo.readCpuTemp();
        if (hwinfoTemp !== null) return hwinfoTemp;
        return readWmiCpuTemp();
      }
      return null;
    }
  },
  {
    id: 'ram_used_percent',
    name: 'RAM Used',
    category: 'memory',
    unit: '%',
    defaultTopic: '{prefix}/sensor/ram_used_percent/state',
    defaultThreshold: 1,
    defaultInterval: 2000,
    poll: async () => {
      const d = await si.mem();
      return round(d.active / d.total * 100, 1);
    }
  },
  {
    id: 'ram_used_gb',
    name: 'RAM Used (GB)',
    category: 'memory',
    unit: 'GB',
    defaultTopic: '{prefix}/sensor/ram_used_gb/state',
    defaultThreshold: 0.1,
    defaultInterval: 2000,
    poll: async () => {
      const d = await si.mem();
      return round(d.active / 1073741824, 2);
    }
  }
];

// ---------------------------------------------------------------------------
// Dynamic sensors — discovered at runtime (temperatures, disk, network)
// ---------------------------------------------------------------------------

async function discoverTemperatureSensors() {
  const sensors = [];
  try {
    const data = await si.cpuTemperature();

    // Individual core temperatures
    if (Array.isArray(data.cores) && data.cores.length > 1) {
      data.cores.forEach((_, i) => {
        sensors.push({
          id: `cpu_temp_core${i}`,
          name: `CPU Core ${i} Temp`,
          category: 'cpu',
          unit: '°C',
          defaultTopic: `{prefix}/sensor/cpu_temp_core${i}/state`,
          defaultThreshold: 0.1,
          defaultInterval: 1000,
          poll: async () => {
            const d = await si.cpuTemperature();
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
        defaultTopic: '{prefix}/sensor/gpu_temp/state',
        defaultThreshold: 0.5,
        defaultInterval: 2000,
        poll: async () => {
          const d = await si.cpuTemperature();
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
        defaultTopic: '{prefix}/sensor/chipset_temp/state',
        defaultThreshold: 0.5,
        defaultInterval: 5000,
        poll: async () => {
          const d = await si.cpuTemperature();
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

// ── Windows GPU discovery (via si.graphics() + Windows performance counters) ─

async function discoverGpuSensorsWindows() {
  const sensors = [];

  try {
    // Detect discrete GPU (VRAM > 1 GB)
    const { controllers } = await si.graphics();
    const discrete = (controllers || [])
      .filter(c => c.vram > 1024)
      .sort((a, b) => b.vram - a.vram)[0];
    if (!discrete) return [];

    // Verify that the Windows GPU performance counters are available
    const testUsage = await pollGpuUsageWindows();
    if (testUsage === null) return [];  // counters not available on this system

    sensors.push({
      id: 'gpu_usage',
      name: 'GPU Usage',
      category: 'gpu',
      unit: '%',
      defaultTopic: '{prefix}/sensor/gpu_usage/state',
      defaultThreshold: 1,
      defaultInterval: 2000,
      poll: pollGpuUsageWindows
    });
  } catch (_) {
    // GPU sensors not available — skip silently
  }

  return sensors;
}

// Queries Windows GPU performance counters (3D engine utilization, summed).
// Works natively on Windows 10/11 without third-party tools.
function pollGpuUsageWindows() {
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

// ── Windows WMI CPU temperature fallback ────────────────────────────────────

// Reads thermal zones via MSAcpi_ThermalZoneTemperature (requires admin rights).
// Returns the highest valid reading in °C, or null if unavailable.
function readWmiCpuTemp() {
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


async function discoverDiskSensors() {
  const drives = await si.fsSize();
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
      defaultTopic: `{prefix}/sensor/disk_${safeMount}_use_percent/state`,
      defaultThreshold: 1,
      defaultInterval: 30000,
      poll: async () => {
        const list = await si.fsSize();
        const d = list.find(x => x.mount === mount);
        return d ? round(d.use, 1) : null;
      }
    });
    sensors.push({
      id: `disk_${safeMount}_free_gb`,
      name: `Disk ${mount} Free`,
      category: 'disk',
      unit: 'GB',
      defaultTopic: `{prefix}/sensor/disk_${safeMount}_free_gb/state`,
      defaultThreshold: 0.5,
      defaultInterval: 30000,
      poll: async () => {
        const list = await si.fsSize();
        const d = list.find(x => x.mount === mount);
        return d ? round((d.size - d.used) / 1073741824, 2) : null;
      }
    });
  }
  return sensors;
}

async function discoverNetworkSensors() {
  const ifaces = await si.networkInterfaces();
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
      defaultTopic: `{prefix}/sensor/net_${safeId}_rx_kbs/state`,
      defaultThreshold: 10,
      defaultInterval: 2000,
      poll: async () => {
        const stats = await si.networkStats(ifaceName);
        const s = Array.isArray(stats) ? stats[0] : stats;
        return s ? round(s.rx_sec / 1024, 1) : null;
      }
    });
    sensors.push({
      id: `net_${safeId}_tx_kbs`,
      name: `${ifaceName} Upload`,
      category: 'network',
      unit: 'KB/s',
      defaultTopic: `{prefix}/sensor/net_${safeId}_tx_kbs/state`,
      defaultThreshold: 10,
      defaultInterval: 2000,
      poll: async () => {
        const stats = await si.networkStats(ifaceName);
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
