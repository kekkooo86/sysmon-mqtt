const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  testConnection: (mqttConfig) => ipcRenderer.invoke('test-connection', mqttConfig),
  onTemperature: (callback) => {
    ipcRenderer.on('temperature', (_, value) => callback(value));
  },
  onMqttStatus: (callback) => {
    ipcRenderer.on('mqtt-status', (_, status) => callback(status));
  }
});
