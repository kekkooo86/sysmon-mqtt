const si = require('systeminformation');

// ---------------------------------------------------------------------------
// Static sensors — guaranteed on all platforms
// ---------------------------------------------------------------------------

const STATIC_SENSORS = [
  {
    id: 'cpu_usage',
    name: 'CPU Usage',
    category: 'cpu',
    unit: '%',
    defaultTopic: 'pc/sensor/cpu_usage/state',
    defaultThreshold: 1,
    defaultInterval: 1000,
    poll: async () => {
      const d = await si.currentLoad();
      return round(d.currentLoad, 1);
    }
  },
  {
    id: 'ram_used_percent',
    name: 'RAM Used',
    category: 'memory',
    unit: '%',
    defaultTopic: 'pc/sensor/ram_used_percent/state',
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
    defaultTopic: 'pc/sensor/ram_used_gb/state',
    defaultThreshold: 0.1,
    defaultInterval: 2000,
    poll: async () => {
      const d = await si.mem();
      return round(d.active / 1073741824, 2);
    }
  }
];

// ---------------------------------------------------------------------------
// Dynamic sensors — discovered at runtime (disk mounts, network interfaces)
// ---------------------------------------------------------------------------

async function discoverDiskSensors() {
  const drives = await si.fsSize();
  const sensors = [];
  for (const drive of drives) {
    if (!drive.size || drive.size === 0) continue;
    const safeMount = drive.mount.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '') || 'root';
    const mount = drive.mount;
    sensors.push({
      id: `disk_${safeMount}_use_percent`,
      name: `Disk ${mount} Usage`,
      category: 'disk',
      unit: '%',
      defaultTopic: `pc/sensor/disk_${safeMount}_use_percent/state`,
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
      defaultTopic: `pc/sensor/disk_${safeMount}_free_gb/state`,
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
  for (const iface of ifaces) {
    if (iface.internal || !iface.operstate || iface.operstate === 'down') continue;
    const safeId = iface.iface.replace(/[^a-zA-Z0-9]/g, '_');
    const ifaceName = iface.iface;
    sensors.push({
      id: `net_${safeId}_rx_kbs`,
      name: `${ifaceName} Download`,
      category: 'network',
      unit: 'KB/s',
      defaultTopic: `pc/sensor/net_${safeId}_rx_kbs/state`,
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
      defaultTopic: `pc/sensor/net_${safeId}_tx_kbs/state`,
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
  const [diskSensors, netSensors] = await Promise.all([
    discoverDiskSensors(),
    discoverNetworkSensors()
  ]);
  return [...STATIC_SENSORS, ...diskSensors, ...netSensors];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round(value, decimals) {
  return parseFloat(Number(value).toFixed(decimals));
}

module.exports = { discoverSensors, STATIC_SENSORS };
