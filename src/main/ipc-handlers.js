const { ipcMain, BrowserWindow, app } = require('electron');
const store = require('./store');
const cpuMonitor = require('./cpu-monitor');
const mqttClient = require('./mqtt-client');
const autostart = require('./autostart');

function registerHandlers(mainWindow) {
  ipcMain.handle('get-settings', () => {
    return {
      mqtt: store.get('mqtt'),
      monitor: store.get('monitor'),
      app: {
        ...store.get('app'),
        autostart: autostart.isEnabled()
      }
    };
  });

  ipcMain.handle('save-settings', (_, settings) => {
    if (settings.mqtt)    store.set('mqtt', settings.mqtt);
    if (settings.monitor) store.set('monitor', settings.monitor);
    if (settings.app) {
      store.set('app', settings.app);
      settings.app.autostart ? autostart.enable() : autostart.disable();
    }

    // Restart MQTT connection with new config
    mqttClient.disconnect();
    mqttClient.connect(store.get('mqtt'));

    // Restart monitor with new interval
    cpuMonitor.stop();
    cpuMonitor.start(store.get('monitor').interval);

    return { success: true };
  });

  ipcMain.handle('test-connection', async (_, mqttConfig) => {
    return new Promise((resolve) => {
      const mqtt = require('mqtt');
      const { host, port, username, password, clientId, tls } = mqttConfig;
      const protocol = tls ? 'mqtts' : 'mqtt';
      const url = `${protocol}://${host}:${port}`;
      const options = {
        clientId: clientId + '_test',
        clean: true,
        connectTimeout: 5000,
        reconnectPeriod: 0,
        ...(username && { username }),
        ...(password && { password })
      };
      const client = mqtt.connect(url, options);
      const timeout = setTimeout(() => {
        client.end(true);
        resolve({ success: false, error: 'Connection timeout' });
      }, 6000);
      client.on('connect', () => {
        clearTimeout(timeout);
        client.end(true);
        resolve({ success: true });
      });
      client.on('error', (err) => {
        clearTimeout(timeout);
        client.end(true);
        resolve({ success: false, error: err.message });
      });
    });
  });

  // Forward temperature readings to renderer
  cpuMonitor.on('temperature', (temp) => {
    mainWindow.webContents.send('temperature', temp);
    const mqttConfig = store.get('mqtt');
    mqttClient.publish(mqttConfig.topic, String(temp), {
      qos: mqttConfig.qos,
      retain: mqttConfig.retain
    });
  });

  // Forward MQTT status to renderer
  mqttClient.on('connected',    () => mainWindow.webContents.send('mqtt-status', 'connected'));
  mqttClient.on('disconnected', () => mainWindow.webContents.send('mqtt-status', 'disconnected'));
  mqttClient.on('error',        () => mainWindow.webContents.send('mqtt-status', 'error'));
}

module.exports = { registerHandlers };
