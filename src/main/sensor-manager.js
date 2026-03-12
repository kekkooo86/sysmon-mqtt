const { EventEmitter } = require('events');
const store            = require('./store');
const { resolveTopic } = require('./utils');

// Minimum and maximum tick boundaries (ms).
// The actual tick is computed dynamically as max(MIN_TICK_MS, floor(minInterval / 2))
// so the timer fires twice per shortest sensor interval, giving one retry slot
// against Node.js timer jitter without over-spinning when all sensors are slow.
const MIN_TICK_MS = 250;
const MAX_TICK_MS = 2000;

class SensorManager extends EventEmitter {
  constructor() {
    super();
    this._timer       = null;
    this._sensors     = [];
    this._mqttClient  = null;
    this._ticking     = false;
    this._topicPrefix = '';
  }

  // Load sensor definitions + user configs, bind mqtt client
  load(definitions, configs, mqttClient) {
    this._mqttClient  = mqttClient;
    this._topicPrefix = store.get('mqtt').topicPrefix ?? '';
    this._sensors     = [];

    for (const def of definitions) {
      const cfg = configs.find(c => c.id === def.id);
      if (!cfg || !cfg.enabled) continue;
      this._sensors.push({
        def,
        cfg,
        lastPolled:    0,
        lastPublished: null
      });
    }
  }

  start() {
    this.stop();
    if (this._sensors.length === 0) return;

    // Fire at half the shortest active sensor interval so each sensor gets
    // two tick opportunities per cycle, absorbing Node.js timer jitter.
    const minInterval = this._sensors.reduce((m, s) => Math.min(m, s.cfg.interval), Infinity);
    const tickMs      = Math.max(MIN_TICK_MS, Math.min(MAX_TICK_MS, Math.floor(minInterval / 2)));

    this._timer = setInterval(() => this._tick(), tickMs);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  reload(definitions, configs, mqttClient) {
    this.stop();
    this.load(definitions, configs, mqttClient);
    this.start();
  }

  get activeCount() {
    return this._sensors.length;
  }

  async _tick() {
    if (this._ticking) return; // skip if previous tick is still running
    this._ticking = true;
    try {
      const now = Date.now();
      for (const entry of this._sensors) {
        if (now - entry.lastPolled < entry.cfg.interval) continue;
        entry.lastPolled = now;
        this._pollSensor(entry);
      }
    } finally {
      this._ticking = false;
    }
  }

  async _pollSensor(entry) {
    try {
      const value = await entry.def.poll();
      if (value === null || value === undefined || isNaN(value)) return;

      const threshold = entry.cfg.threshold ?? entry.def.defaultThreshold;
      const changed   = entry.lastPublished === null ||
                        Math.abs(value - entry.lastPublished) >= threshold;

      if (!changed) return;

      entry.lastPublished = value;
      this.emit('sensor-update', { id: entry.def.id, name: entry.def.name, value, unit: entry.def.unit });

      if (this._mqttClient && this._mqttClient.isConnected) {
        this._mqttClient.publish(resolveTopic(entry.cfg.topic, this._topicPrefix), String(value));
      }
    } catch (err) {
      // Sensor read failure — emit but don't crash
      this.emit('sensor-error', { id: entry.def.id, error: err.message });
    }
  }
}

module.exports = new SensorManager();
