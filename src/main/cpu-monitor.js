const { EventEmitter } = require('events');
const si = require('systeminformation');

// Minimum difference (°C) required to trigger a new 'temperature' event.
// Avoids publishing on micro-fluctuations (e.g. 65.1 → 65.2 → 65.1).
const CHANGE_THRESHOLD = 0.1;

class CpuMonitor extends EventEmitter {
  constructor() {
    super();
    this._timer = null;
    this._interval = 5000;
    this._lastTemp = null;
  }

  start(interval = 1000) {
    this._interval = interval;
    this._lastTemp = null; // reset on (re)start
    this._poll();
    this._timer = setInterval(() => this._poll(), this._interval);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async _poll() {
    try {
      const data = await si.cpuTemperature();
      // Prefer max (hottest point), fallback to main if max is unavailable
      const raw = (data.max != null && data.max > 0) ? data.max : data.main;
      if (raw == null || raw <= 0) {
        this.emit('error', new Error('Temperature sensor not available'));
        return;
      }
      const temp = parseFloat(raw.toFixed(1));
      if (this._lastTemp === null || Math.abs(temp - this._lastTemp) >= CHANGE_THRESHOLD) {
        this._lastTemp = temp;
        this.emit('temperature', temp);
      }
    } catch (err) {
      this.emit('error', err);
    }
  }
}

module.exports = new CpuMonitor();
