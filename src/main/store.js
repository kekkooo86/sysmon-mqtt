const Store = require('electron-store');

const schema = {
  mqtt: {
    type: 'object',
    properties: {
      host:        { type: 'string', default: 'localhost' },
      port:        { type: 'number', default: 1883 },
      username:    { type: 'string', default: '' },
      password:    { type: 'string', default: '' },
      clientId:    { type: 'string', default: 'pc-monitor' },
      tls:         { type: 'boolean', default: false },
      qos:         { type: 'number', default: 0 },
      retain:      { type: 'boolean', default: false },
      topicPrefix: { type: 'string', default: 'pc' }
    },
    default: {}
  },
  // sensors: array of { id, enabled, topic, threshold, interval }
  // Managed dynamically — no strict schema so new sensors can be added
  sensors: {
    type: 'array',
    default: []
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
