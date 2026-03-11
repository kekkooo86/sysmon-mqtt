const { app, BrowserWindow } = require('electron');
const path = require('path');
const store = require('./store');
const cpuMonitor = require('./cpu-monitor');
const mqttClient = require('./mqtt-client');
const { createTray, updateTemperature, updateMqttStatus } = require('./tray');
const { registerHandlers } = require('./ipc-handlers');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 600,
    resizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Renderer misses events fired before it finishes loading — resync on ready
  mainWindow.webContents.on('did-finish-load', () => {
    const status = mqttClient.isConnected ? 'connected' : 'disconnected';
    mainWindow.webContents.send('mqtt-status', status);
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

app.whenReady().then(() => {
  createWindow();

  const tray = createTray(mainWindow);

  registerHandlers(mainWindow);

  // Connect MQTT
  mqttClient.connect(store.get('mqtt'));
  mqttClient.on('connected',    () => updateMqttStatus('connected', mainWindow));
  mqttClient.on('disconnected', () => updateMqttStatus('disconnected', mainWindow));
  mqttClient.on('error',        () => updateMqttStatus('error', mainWindow));

  // Start CPU monitoring
  cpuMonitor.on('temperature', (temp) => updateTemperature(temp, mainWindow));
  cpuMonitor.start(store.get('monitor').interval);

  // Show window on first launch if no settings configured
  if (!store.get('mqtt').host || store.get('mqtt').host === 'localhost') {
    mainWindow.show();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  cpuMonitor.stop();
  mqttClient.disconnect();
});

app.on('window-all-closed', (e) => {
  // Keep app running in tray — don't quit
  e.preventDefault();
});
