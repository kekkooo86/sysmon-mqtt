const { app, BrowserWindow } = require('electron');
const path = require('path');
const store         = require('./store');
const mqttClient    = require('./mqtt-client');
const sensorManager = require('./sensor-manager');
const { createTray, updateMqttStatus } = require('./tray');
const { registerHandlers, getDefinitions, buildConfigs } = require('./ipc-handlers');
const autostart     = require('./autostart');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 600,
    height: 680,
    resizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('mqtt-status', mqttClient.isConnected ? 'connected' : 'disconnected');
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
}

app.whenReady().then(async () => {
  createWindow();
  createTray(mainWindow);
  registerHandlers(mainWindow);

  // Connect MQTT
  mqttClient.connect(store.get('mqtt'));
  mqttClient.on('connected',    () => updateMqttStatus('connected', mainWindow));
  mqttClient.on('disconnected', () => updateMqttStatus('disconnected', mainWindow));
  mqttClient.on('error',        () => updateMqttStatus('error', mainWindow));

  // Start sensor manager with saved configs
  const defs    = await getDefinitions();
  const configs = buildConfigs(defs, store.get('sensors'));
  sensorManager.load(defs, configs, mqttClient);
  sensorManager.start();

  // Show window on first launch
  if (!store.get('mqtt').host || store.get('mqtt').host === 'localhost') {
    mainWindow.show();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  sensorManager.stop();
  mqttClient.disconnect();
});

app.on('window-all-closed', (e) => e.preventDefault());
