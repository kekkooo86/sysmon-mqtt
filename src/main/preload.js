const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // MQTT settings
  getSettings:    ()         => ipcRenderer.invoke('get-settings'),
  saveSettings:   (settings) => ipcRenderer.invoke('save-settings', settings),
  testConnection: (cfg)      => ipcRenderer.invoke('test-connection', cfg),

  // Sensors
  getAvailableSensors: ()       => ipcRenderer.invoke('get-available-sensors'),
  saveSensorConfigs:   (configs) => ipcRenderer.invoke('save-sensor-configs', configs),

  // Events
  onMqttStatus:  (cb) => ipcRenderer.on('mqtt-status',   (_, v) => cb(v)),
  onSensorUpdate:(cb) => ipcRenderer.on('sensor-update', (_, v) => cb(v))
});
