const { ipcMain } = require('electron');
const store          = require('./store');
const mqttClient     = require('./mqtt-client');
const sensorManager  = require('./sensor-manager');
const { discoverSensors } = require('./sensors');
const autostart      = require('./autostart');
const { updateActiveSensors } = require('./tray');

let _cachedDefinitions = null;

async function getDefinitions() {
  if (!_cachedDefinitions) _cachedDefinitions = await discoverSensors();
  return _cachedDefinitions;
}

// Merge user configs over sensor defaults, fill missing fields
function buildConfigs(definitions, savedConfigs) {
  return definitions.map(def => {
    const saved = savedConfigs.find(c => c.id === def.id) || {};
    return {
      id:        def.id,
      enabled:   saved.enabled   ?? false,
      topic:     saved.topic     ?? def.defaultTopic,
      threshold: saved.threshold ?? def.defaultThreshold,
      interval:  saved.interval  ?? def.defaultInterval
    };
  });
}

function registerHandlers(mainWindow) {
  // --- MQTT settings ---
  ipcMain.handle('get-settings', () => ({
    mqtt: store.get('mqtt'),
    app:  { ...store.get('app'), autostart: autostart.isEnabled() }
  }));

  ipcMain.handle('save-settings', (_, settings) => {
    if (settings.mqtt) store.set('mqtt', settings.mqtt);
    if (settings.app) {
      store.set('app', settings.app);
      settings.app.autostart ? autostart.enable() : autostart.disable();
    }
    mqttClient.disconnect();
    mqttClient.connect(store.get('mqtt'));
    return { success: true };
  });

  ipcMain.handle('test-connection', async (_, mqttConfig) => {
    return new Promise((resolve) => {
      const mqtt = require('mqtt');
      const { host, port, username, password, clientId, tls } = mqttConfig;
      const url = `${tls ? 'mqtts' : 'mqtt'}://${host}:${port}`;
      const client = mqtt.connect(url, {
        clientId: clientId + '_test',
        clean: true,
        connectTimeout: 5000,
        reconnectPeriod: 0,
        ...(username && { username }),
        ...(password && { password })
      });
      const timeout = setTimeout(() => { client.end(true); resolve({ success: false, error: 'Timeout' }); }, 6000);
      client.on('connect', () => { clearTimeout(timeout); client.end(true); resolve({ success: true }); });
      client.on('error', (err) => { clearTimeout(timeout); client.end(true); resolve({ success: false, error: err.message }); });
    });
  });

  // --- Sensors ---
  ipcMain.handle('get-available-sensors', async () => {
    _cachedDefinitions = null; // force re-discovery
    const defs = await getDefinitions();
    const savedConfigs = store.get('sensors');
    return buildConfigs(defs, savedConfigs).map((cfg, i) => ({
      ...cfg,
      name:     defs[i].name,
      category: defs[i].category,
      unit:     defs[i].unit
    }));
  });

  ipcMain.handle('save-sensor-configs', async (_, configs) => {
    store.set('sensors', configs);
    const defs = await getDefinitions();
    sensorManager.reload(defs, configs, mqttClient);
    updateActiveSensors(sensorManager.activeCount, mainWindow);
    return { success: true };
  });

  // Forward sensor updates to renderer
  sensorManager.on('sensor-update', (data) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('sensor-update', data);
  });

  // Forward MQTT status to renderer
  mqttClient.on('connected',    () => { if (!mainWindow.isDestroyed()) mainWindow.webContents.send('mqtt-status', 'connected'); });
  mqttClient.on('disconnected', () => { if (!mainWindow.isDestroyed()) mainWindow.webContents.send('mqtt-status', 'disconnected'); });
  mqttClient.on('error',        () => { if (!mainWindow.isDestroyed()) mainWindow.webContents.send('mqtt-status', 'error'); });
}

module.exports = { registerHandlers, getDefinitions, buildConfigs };
