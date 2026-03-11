const { Tray, Menu, app, nativeImage } = require('electron');
const path = require('path');

let tray = null;
let mqttStatus = 'disconnected';
let activeSensors = 0;

function createTray(mainWindow) {
  const iconPath = path.join(__dirname, '../../assets/tray-icon.png');
  tray = new Tray(nativeImage.createFromPath(iconPath));
  buildMenu(mainWindow);

  tray.on('click', () => {
    mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
  });

  return tray;
}

function buildMenu(mainWindow) {
  const statusLabel = mqttStatus === 'connected'
    ? `MQTT: connesso (${activeSensors} sensori)`
    : `MQTT: ${mqttStatus}`;

  const menu = Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    { label: 'Impostazioni', click: () => mainWindow.show() },
    { type: 'separator' },
    { label: 'Esci', click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`PC Monitor — ${statusLabel}`);
}

function updateMqttStatus(status, mainWindow) {
  mqttStatus = status;
  buildMenu(mainWindow);
}

function updateActiveSensors(count, mainWindow) {
  activeSensors = count;
  buildMenu(mainWindow);
}

module.exports = { createTray, updateMqttStatus, updateActiveSensors };

