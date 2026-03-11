const { EventEmitter } = require('events');
const store            = require('./store');
const { resolveTopic } = require('./utils');

// Master timer interval — all sensors are checked against this tick.
// Individual sensor intervals are multiples of TICK_MS.
const TICK_MS = 500;

class SensorManager extends EventEmitter {
  constructor() {
    super();
    this._timer     = null;
    this._sensors   = [];   // { definition, config, lastPolled, lastPublished }
    this._mqttClient = null;
  }

  // Load sensor definitions + user configs, bind mqtt client
  load(definitions, configs, mqttClient) {
    this._mqttClient = mqttClient;
    this._sensors = [];

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
    this._timer = setInterval(() => this._tick(), TICK_MS);
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
    const now = Date.now();
    for (const entry of this._sensors) {
      if (now - entry.lastPolled < entry.cfg.interval) continue;
      entry.lastPolled = now;
      this._pollSensor(entry);
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
        const prefix = store.get('mqtt').topicPrefix ?? '';
        this._mqttClient.publish(resolveTopic(entry.cfg.topic, prefix), String(value));
      }
    } catch (err) {
      // Sensor read failure — emit but don't crash
      this.emit('sensor-error', { id: entry.def.id, error: err.message });
    }
  }
}

module.exports = new SensorManager();
