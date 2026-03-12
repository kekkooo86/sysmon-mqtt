/**
 * hwinfo-bridge.js
 *
 * Windows hardware sensor bridge. Reads temperatures (and more) from companion
 * monitoring tools that expose data via HTTP JSON or Shared Memory.
 *
 * Priority order:
 *   1. LibreHardwareMonitor HTTP  — web server on localhost:8085/data.json
 *                                   Options → "Run remote web server" in LHM
 *   2. LibreHardwareMonitor WMI   — root\LibreHardwareMonitor (requires service mode)
 *   3. OpenHardwareMonitor WMI    — root\OpenHardwareMonitor
 *   4. HWiNFO64 Shared Memory     — 12h limit on free tier
 *   5. Core Temp Shared Memory    — https://www.alcpu.com/CoreTemp/ (free, portable)
 *
 * ── LibreHardwareMonitor setup (recommended) ─────────────────────────────────
 *   1. Download: https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases
 *   2. Run LibreHardwareMonitor.exe as Administrator
 *   3. Options → enable "Run remote web server"
 *   Data available at http://localhost:8085/data.json while the app is running.
 */

'use strict';

const http   = require('http');
const { execFile } = require('child_process');

// ---------------------------------------------------------------------------
// Helper: run a PowerShell script reliably via -EncodedCommand
// ---------------------------------------------------------------------------

function runPS(script, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { timeout: timeoutMs },
      (err, stdout) => resolve(err ? '' : (stdout || ''))
    );
  });
}

// ---------------------------------------------------------------------------
// Helper: HTTP GET → parsed JSON (no external dependencies)
// ---------------------------------------------------------------------------

function httpGetJson(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ---------------------------------------------------------------------------
// Backend 1: LibreHardwareMonitor HTTP (localhost:8085/data.json)
// ---------------------------------------------------------------------------

// Map LHM category node names → generic type
const LHM_CATEGORY_TYPE = {
  temperatures: 'Temperature',
  temperature:  'Temperature',
  clocks:       'Clock',
  clock:        'Clock',
  loads:        'Load',
  load:         'Load',
  fans:         'Fan',
  fan:          'Fan',
  voltages:     'Voltage',
  voltage:      'Voltage',
  powers:       'Power',
  power:        'Power',
  throughputs:  'Throughput',
  throughput:   'Throughput',
  controls:     'Control',
};

function lhmExtractReadings(node, readings = [], parentType = null) {
  if (!node) return readings;

  // Determine type context from category nodes ("Temperatures", "Loads", …)
  const typeFromText = LHM_CATEGORY_TYPE[node.Text?.toLowerCase()];
  const currentType  = typeFromText || parentType;

  // Leaf sensor node: has a non-empty Value and no children
  if (node.Value && node.Value !== '-' && Array.isArray(node.Children) && node.Children.length === 0) {
    // Handle locale-specific decimal comma ("43,5 °C" → 43.5)
    const valueStr = node.Value.replace(',', '.').replace(/[^\d.\-]/g, '');
    const value    = parseFloat(valueStr);
    if (!isNaN(value) && currentType) {
      readings.push({ type: currentType, label: node.Text, value });
    }
  }

  if (Array.isArray(node.Children)) {
    for (const child of node.Children) lhmExtractReadings(child, readings, currentType);
  }
  return readings;
}

async function readFromLhmHttp(port = 8085) {
  const json = await httpGetJson(`http://localhost:${port}/data.json`);
  if (!json) return null;
  const readings = lhmExtractReadings(json);
  return readings.length > 0 ? readings : null;
}

// ---------------------------------------------------------------------------
// Backend 2: LibreHardwareMonitor / OpenHardwareMonitor WMI
// ---------------------------------------------------------------------------

async function readFromWmiBackend(namespace) {
  const script = `
try {
  $sensors = Get-WmiObject -Namespace '${namespace}' -Class Sensor -ErrorAction Stop
  foreach ($s in $sensors) {
    Write-Output "$($s.SensorType)|$($s.Name)|$($s.Value)"
  }
} catch {
  Write-Output "ERROR"
}
`.trim();

  const out = await runPS(script, 4000);
  if (!out || out.trim() === 'ERROR' || out.trim() === '') return null;

  const readings = [];
  for (const line of out.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
    if (line === 'ERROR') continue;
    const parts = line.split('|');
    if (parts.length < 3) continue;
    const [sensorType, name, valueStr] = parts;
    const value = parseFloat(valueStr);
    if (!isNaN(value) && name) {
      readings.push({ type: sensorType, label: name, value });
    }
  }
  return readings.length > 0 ? readings : null;
}

// ---------------------------------------------------------------------------
// Backend 3: HWiNFO64 Shared Memory
// ---------------------------------------------------------------------------

async function readFromHWiNFO64() {
  const script = `
$names = @("Global\\HWiNFO_SENSORS_SM2", "HWiNFO_SENSORS_SM2")
$mmf = $null
foreach ($n in $names) {
  try { $mmf = [System.IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting($n); break }
  catch [System.IO.FileNotFoundException] { }
}
if (-not $mmf) { Write-Output "NOT_RUNNING"; exit }

$acc = $mmf.CreateViewAccessor(0, 0, [System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)
$sig = $acc.ReadUInt32(0)
if ($sig -ne 0x53574948) { Write-Output "BAD_SIG"; $acc.Dispose(); $mmf.Dispose(); exit }

$rdOff  = $acc.ReadUInt32(32)
$rdSize = $acc.ReadUInt32(36)
$rdCnt  = $acc.ReadUInt32(40)

for ($i = 0; $i -lt $rdCnt; $i++) {
  $pos  = $rdOff + [long]($i * $rdSize)
  $type = $acc.ReadUInt32($pos)
  if ($type -eq 0) { continue }

  $lb = New-Object byte[] 128
  $acc.ReadArray($pos + 12, $lb, 0, 128) | Out-Null
  $label = [System.Text.Encoding]::ASCII.GetString($lb).TrimEnd([char]0)

  $ub = New-Object byte[] 16
  $acc.ReadArray($pos + 268, $ub, 0, 16) | Out-Null
  $unit = [System.Text.Encoding]::ASCII.GetString($ub).TrimEnd([char]0)

  $value = $acc.ReadDouble($pos + 284)
  Write-Output "$type|$label|$unit|$($value.ToString('F2'))"
}

$acc.Dispose(); $mmf.Dispose()
`.trim();

  const out = await runPS(script, 5000);
  if (!out || out.trim() === 'NOT_RUNNING' || out.trim() === 'BAD_SIG') return null;

  const HWINFO_TYPE = { '1': 'Temperature', '2': 'Voltage', '3': 'Fan', '7': 'Load' };
  const readings = [];
  for (const line of out.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
    const parts = line.split('|');
    if (parts.length < 4) continue;
    const [typeStr, label, unit, valueStr] = parts;
    const value = parseFloat(valueStr);
    if (!isNaN(value) && label) {
      readings.push({ type: HWINFO_TYPE[typeStr] || typeStr, label, unit, value });
    }
  }
  return readings.length > 0 ? readings : null;
}

// ---------------------------------------------------------------------------
// Backend 4: Core Temp Shared Memory
// ---------------------------------------------------------------------------

async function readFromCoreTemp() {
  const script = `
$SM = "CoreTempMappingObject"
try {
  $mmf = [System.IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting($SM)
  $acc = $mmf.CreateViewAccessor(0, 0, [System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)

  $coreCnt     = $acc.ReadUInt32(1536)
  $fahrenheit  = $acc.ReadByte(2584)
  $deltaMode   = $acc.ReadByte(2585)

  if ($coreCnt -eq 0) { Write-Output "NO_CORES"; $acc.Dispose(); $mmf.Dispose(); exit }

  for ($i = 0; $i -lt $coreCnt; $i++) {
    $raw = $acc.ReadSingle(1544 + $i * 4)
    if ($deltaMode -eq 1) {
      $tjmax = $acc.ReadUInt32(1024 + $i * 4)
      $raw   = $tjmax - $raw
    }
    if ($fahrenheit -eq 1) { $raw = ($raw - 32) * 5 / 9 }
    Write-Output "Temperature|CPU Core #$i|C|$($raw.ToString('F1'))"
  }

  $acc.Dispose(); $mmf.Dispose()
} catch [System.IO.FileNotFoundException] {
  Write-Output "NOT_RUNNING"
} catch {
  Write-Output "ERROR:$($_.Exception.Message)"
}
`.trim();

  const out = await runPS(script, 4000);
  if (!out || out.trim() === 'NOT_RUNNING' || out.trim().startsWith('ERROR:') || out.trim() === 'NO_CORES') return null;

  const readings = [];
  for (const line of out.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
    const parts = line.split('|');
    if (parts.length < 4) continue;
    const [type, label, unit, valueStr] = parts;
    const value = parseFloat(valueStr);
    if (!isNaN(value) && value > 0) readings.push({ type, label, unit, value });
  }
  return readings.length > 0 ? readings : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const BACKENDS = [
  { name: 'LibreHardwareMonitor-HTTP', fn: () => readFromLhmHttp()                               },
  { name: 'LibreHardwareMonitor-WMI',  fn: () => readFromWmiBackend('root\\LibreHardwareMonitor') },
  { name: 'OpenHardwareMonitor-WMI',   fn: () => readFromWmiBackend('root\\OpenHardwareMonitor')  },
  { name: 'HWiNFO64',                  fn: () => readFromHWiNFO64()                               },
  { name: 'CoreTemp',                  fn: () => readFromCoreTemp()                               },
];

/**
 * Returns all sensor readings from the first available backend.
 * Each entry: { type, label, value, unit? }
 * Returns null if no backend is available.
 */
async function readAllSensors() {
  for (const backend of BACKENDS) {
    const data = await backend.fn();
    if (data) return { source: backend.name, readings: data };
  }
  return null;
}

/**
 * Returns temperature readings only (type === 'Temperature').
 * Returns null if no backend available.
 */
async function readTemperatures() {
  const result = await readAllSensors();
  if (!result) return null;
  return {
    source: result.source,
    temps: result.readings.filter(r => r.type === 'Temperature' && r.value > 0)
  };
}

/**
 * Returns true if at least one backend is available.
 */
async function isAvailable() {
  return (await readAllSensors()) !== null;
}

/**
 * Best-effort CPU package/die temperature in °C.
 * Handles both LHM-WMI labels ("CPU Package") and LHM-HTTP labels ("Package",
 * "Core (Tctl/Tdie)") and Core Temp labels ("CPU Core #N").
 */
async function readCpuTemp() {
  const result = await readTemperatures();
  if (!result) return null;

  const { temps } = result;

  // Ordered from most specific/accurate to broadest fallback
  const CPU_PRIORITY = [
    /^CPU Package$/i,             // LHM WMI / HWiNFO
    /^Package$/i,                 // LHM HTTP (Ryzen)
    /^CPU \(Tdie\)$/i,            // LHM WMI AMD
    /^CPU \(Tctl\/Tdie\)$/i,      // LHM WMI AMD
    /^Core \(Tctl\/Tdie\)$/i,     // LHM HTTP AMD Ryzen
    /Tctl\/Tdie/i,                // any label with Tctl/Tdie
    /Tdie/i,                      // any label with Tdie
    /^CPU$/i,
    /^CPU\b/i,
    /\bCPU\b/i,
  ];

  for (const pattern of CPU_PRIORITY) {
    const match = temps.find(t => pattern.test(t.label) && t.value > 0);
    if (match) return parseFloat(match.value.toFixed(1));
  }

  // Last resort: max of individual core readings (Core Temp "CPU Core #N")
  const coreTemps = temps.filter(t => /CPU Core/i.test(t.label) && t.value > 0);
  if (coreTemps.length > 0) {
    return parseFloat(Math.max(...coreTemps.map(t => t.value)).toFixed(1));
  }

  return null;
}

module.exports = { readAllSensors, readTemperatures, readCpuTemp, isAvailable };


// ---------------------------------------------------------------------------
// Helper: run a PowerShell script reliably via -EncodedCommand
// ---------------------------------------------------------------------------

function runPS(script, timeoutMs = 5000) {
  return new Promise((resolve) => {
    // UTF-16LE + Base64 → avoids all quoting/newline issues with -Command
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { timeout: timeoutMs },
      (err, stdout) => resolve(err ? '' : (stdout || ''))
    );
  });
}

// ---------------------------------------------------------------------------
// Backend 1: LibreHardwareMonitor (or OpenHardwareMonitor) via WMI
// ---------------------------------------------------------------------------

async function readFromWmiBackend(namespace) {
  const script = `
try {
  $sensors = Get-WmiObject -Namespace '${namespace}' -Class Sensor -ErrorAction Stop
  foreach ($s in $sensors) {
    Write-Output "$($s.SensorType)|$($s.Name)|$($s.Value)"
  }
} catch {
  Write-Output "ERROR"
}
`.trim();

  const out = await runPS(script, 4000);
  if (!out || out.trim() === 'ERROR' || out.trim() === '') return null;

  const readings = [];
  for (const line of out.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
    if (line === 'ERROR') continue;
    const parts = line.split('|');
    if (parts.length < 3) continue;
    const [sensorType, name, valueStr] = parts;
    const value = parseFloat(valueStr);
    if (!isNaN(value) && name) {
      readings.push({ type: sensorType, label: name, value });
    }
  }
  return readings.length > 0 ? readings : null;
}

// ---------------------------------------------------------------------------
// Backend 2: HWiNFO64 Shared Memory
// ---------------------------------------------------------------------------

async function readFromHWiNFO64() {
  const script = `
$names = @("Global\\HWiNFO_SENSORS_SM2", "HWiNFO_SENSORS_SM2")
$mmf = $null
foreach ($n in $names) {
  try { $mmf = [System.IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting($n); break }
  catch [System.IO.FileNotFoundException] { }
}
if (-not $mmf) { Write-Output "NOT_RUNNING"; exit }

$acc = $mmf.CreateViewAccessor(0, 0, [System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)
$sig = $acc.ReadUInt32(0)
if ($sig -ne 0x53574948) { Write-Output "BAD_SIG"; $acc.Dispose(); $mmf.Dispose(); exit }

$rdOff  = $acc.ReadUInt32(32)
$rdSize = $acc.ReadUInt32(36)
$rdCnt  = $acc.ReadUInt32(40)

for ($i = 0; $i -lt $rdCnt; $i++) {
  $pos  = $rdOff + [long]($i * $rdSize)
  $type = $acc.ReadUInt32($pos)
  if ($type -eq 0) { continue }

  $lb = New-Object byte[] 128
  $acc.ReadArray($pos + 12, $lb, 0, 128) | Out-Null
  $label = [System.Text.Encoding]::ASCII.GetString($lb).TrimEnd([char]0)

  $ub = New-Object byte[] 16
  $acc.ReadArray($pos + 268, $ub, 0, 16) | Out-Null
  $unit = [System.Text.Encoding]::ASCII.GetString($ub).TrimEnd([char]0)

  $value = $acc.ReadDouble($pos + 284)
  Write-Output "$type|$label|$unit|$($value.ToString('F2'))"
}

$acc.Dispose(); $mmf.Dispose()
`.trim();

  const out = await runPS(script, 5000);
  if (!out || out.trim() === 'NOT_RUNNING' || out.trim() === 'BAD_SIG') return null;

  const readings = [];
  for (const line of out.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
    const parts = line.split('|');
    if (parts.length < 4) continue;
    const [typeStr, label, unit, valueStr] = parts;
    const value = parseFloat(valueStr);
    const HWINFO_TYPE = { '1': 'Temperature', '2': 'Voltage', '3': 'Fan', '7': 'Load' };
    if (!isNaN(value) && label) {
      readings.push({ type: HWINFO_TYPE[typeStr] || typeStr, label, unit, value });
    }
  }
  return readings.length > 0 ? readings : null;
}

// ---------------------------------------------------------------------------
// Backend 3: Core Temp shared memory
// ---------------------------------------------------------------------------
// Core Temp (https://www.alcpu.com/CoreTemp/) exposes CPU temperatures via
// a shared memory object "CoreTempMappingObject". Free, no time limits.
//
// CORE_TEMP_SHARED_DATA layout (offsets in bytes):
//   0    uiLoad[256]      uint32 ×256  = 1024  CPU core load %
//   1024 uiTjMax[128]     uint32 ×128  = 512   TjMax per core
//   1536 uiCoreCnt        uint32       = 4     physical cores
//   1540 uiCPUCnt         uint32       = 4     CPU sockets
//   1544 fTemp[256]       float  ×256  = 1024  temperatures
//   2568 fVID             float        = 4
//   2572 fCPUSpeed        float        = 4
//   2576 fFSBSpeed        float        = 4
//   2580 fMultiplier      float        = 4
//   2584 ucFahrenheit     byte         = 1     0=Celsius 1=Fahrenheit
//   2585 ucDeltaToTjMax   byte         = 1     0=real temp 1=delta to TjMax

async function readFromCoreTemp() {
  const script = `
$SM = "CoreTempMappingObject"
try {
  $mmf = [System.IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting($SM)
  $acc = $mmf.CreateViewAccessor(0, 0, [System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)

  $coreCnt     = $acc.ReadUInt32(1536)
  $cpuCnt      = $acc.ReadUInt32(1540)
  $fahrenheit  = $acc.ReadByte(2584)
  $deltaMode   = $acc.ReadByte(2585)

  if ($coreCnt -eq 0) { Write-Output "NO_CORES"; $acc.Dispose(); $mmf.Dispose(); exit }

  for ($i = 0; $i -lt $coreCnt; $i++) {
    $raw = $acc.ReadSingle(1544 + $i * 4)
    if ($deltaMode -eq 1) {
      $tjmax = $acc.ReadUInt32(1024 + $i * 4)
      $raw   = $tjmax - $raw
    }
    if ($fahrenheit -eq 1) { $raw = ($raw - 32) * 5 / 9 }
    Write-Output "Temperature|CPU Core #$i|C|$($raw.ToString('F1'))"
  }

  $acc.Dispose(); $mmf.Dispose()
} catch [System.IO.FileNotFoundException] {
  Write-Output "NOT_RUNNING"
} catch {
  Write-Output "ERROR:$($_.Exception.Message)"
}
`.trim();

  const out = await runPS(script, 4000);
  if (!out || out.trim() === 'NOT_RUNNING' || out.trim().startsWith('ERROR:') || out.trim() === 'NO_CORES') return null;

  const readings = [];
  return readings.length > 0 ? readings : null;
}

module.exports = { readAllSensors, readTemperatures, readCpuTemp, isAvailable };

