const { Tray, Menu, app, nativeImage } = require('electron');
const path = require('path');

let tray = null;
let currentTemp = '--';
let mqttStatus = 'disconnected';

function createTray(mainWindow) {
  const iconPath = path.join(__dirname, '../../assets/tray-icon.png');
  tray = new Tray(nativeImage.createFromPath(iconPath));

  updateTooltip();
  buildMenu(mainWindow);

  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.focus();
    } else {
      mainWindow.show();
    }
  });

  return tray;
}

function buildMenu(mainWindow) {
  const menu = Menu.buildFromTemplate([
    { label: `CPU: ${currentTemp}°C`, enabled: false },
    { label: `MQTT: ${mqttStatus}`, enabled: false },
    { type: 'separator' },
    { label: 'Impostazioni', click: () => mainWindow.show() },
    { type: 'separator' },
    { label: 'Esci', click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
}

function updateTemperature(temp, mainWindow) {
  currentTemp = temp;
  updateTooltip();
  buildMenu(mainWindow);
}

function updateMqttStatus(status, mainWindow) {
  mqttStatus = status;
  buildMenu(mainWindow);
}

function updateTooltip() {
  if (tray) tray.setToolTip(`CPU Temp: ${currentTemp}°C`);
}

module.exports = { createTray, updateTemperature, updateMqttStatus };
