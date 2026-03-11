const Store = require('electron-store');

const schema = {
  mqtt: {
    type: 'object',
    properties: {
      host:     { type: 'string', default: 'localhost' },
      port:     { type: 'number', default: 1883 },
      username: { type: 'string', default: '' },
      password: { type: 'string', default: '' },
      clientId: { type: 'string', default: 'cpu-temp-monitor' },
      topic:    { type: 'string', default: 'homeassistant/pc_gaming/sensor/cpu_temperature/state' },
      tls:      { type: 'boolean', default: false },
      qos:      { type: 'number', default: 0 },
      retain:   { type: 'boolean', default: false }
    },
    default: {}
  },
  monitor: {
    type: 'object',
    properties: {
      interval: { type: 'number', default: 1000 }
    },
    default: {}
  },
  app: {
    type: 'object',
    properties: {
      autostart:      { type: 'boolean', default: false },
      minimizeToTray: { type: 'boolean', default: true }
    },
    default: {}
  }
};

const store = new Store({ schema });

module.exports = store;
