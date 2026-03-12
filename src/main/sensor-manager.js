const { EventEmitter } = require('events');
const store            = require('./store');
const { resolveTopic } = require('./utils');

/**
 * SensorManager — per-sensor setTimeout chains instead of a global setInterval.
 *
 * Why: a shared tick timer at half the shortest interval fires N times/second
 * even when no sensor is due (idle wakeups). With per-sensor timers each sensor
 * sleeps exactly until its next poll, keeping the Node.js event loop quiet
 * between readings.
 */
class SensorManager extends EventEmitter {
  constructor() {
    super();
    this._sensors     = [];
    this._mqttClient  = null;
    this._topicPrefix = '';
    this._active      = false;
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
        lastPublished: null,
        _handle:       null   // per-sensor timer handle
      });
    }
  }

  start() {
    this.stop();
    if (this._sensors.length === 0) return;
    this._active = true;
    // Fire each sensor immediately on first start, then on its own schedule.
    for (const entry of this._sensors) {
      this._schedule(entry, 0);
    }
  }

  stop() {
    this._active = false;
    for (const entry of this._sensors) {
      if (entry._handle !== null) {
        clearTimeout(entry._handle);
        entry._handle = null;
      }
    }
    // Do NOT clear this._sensors here — start() calls stop() internally and
    // then immediately iterates this._sensors to schedule timers. Clearing
    // sensors is load()'s responsibility.
  }

  reload(definitions, configs, mqttClient) {
    this.stop();
    this.load(definitions, configs, mqttClient);
    this.start();
  }

  get activeCount() {
    return this._sensors.length;
  }

  // Schedule (or re-schedule) a sensor's next poll after delayMs.
  _schedule(entry, delayMs) {
    entry._handle = setTimeout(() => {
      entry._handle = null;
      if (!this._active) return;

      const pollStart  = Date.now();
      entry.lastPolled = pollStart;

      this._pollSensor(entry).finally(() => {
        // Guard against stop()/reload() that ran while the poll was in flight.
        if (!this._active || !this._sensors.includes(entry)) return;

        // Schedule the next poll so the *interval* is measured from when this
        // poll started, keeping drift minimal even if the poll takes a few ms.
        const elapsed = Date.now() - pollStart;
        this._schedule(entry, Math.max(0, entry.cfg.interval - elapsed));
      });
    }, delayMs);
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
