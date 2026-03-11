async function loadSettings() {
  const settings = await window.api.getSettings();

  document.getElementById('mqtt-host').value       = settings.mqtt.host     ?? '';
  document.getElementById('mqtt-port').value       = settings.mqtt.port     ?? 1883;
  document.getElementById('mqtt-username').value   = settings.mqtt.username ?? '';
  document.getElementById('mqtt-password').value   = settings.mqtt.password ?? '';
  document.getElementById('mqtt-clientId').value   = settings.mqtt.clientId ?? '';
  document.getElementById('mqtt-topic').value      = settings.mqtt.topic    ?? '';
  document.getElementById('mqtt-qos').value        = settings.mqtt.qos      ?? 0;
  document.getElementById('mqtt-tls').checked      = settings.mqtt.tls      ?? false;
  document.getElementById('mqtt-retain').checked   = settings.mqtt.retain   ?? false;

  document.getElementById('monitor-interval').value      = settings.monitor.interval    ?? 5000;
  document.getElementById('app-autostart').checked       = settings.app.autostart       ?? false;
  document.getElementById('app-minimizeToTray').checked  = settings.app.minimizeToTray  ?? true;
}

function collectSettings() {
  return {
    mqtt: {
      host:     document.getElementById('mqtt-host').value.trim(),
      port:     parseInt(document.getElementById('mqtt-port').value, 10),
      username: document.getElementById('mqtt-username').value.trim(),
      password: document.getElementById('mqtt-password').value,
      clientId: document.getElementById('mqtt-clientId').value.trim(),
      topic:    document.getElementById('mqtt-topic').value.trim(),
      qos:      parseInt(document.getElementById('mqtt-qos').value, 10),
      tls:      document.getElementById('mqtt-tls').checked,
      retain:   document.getElementById('mqtt-retain').checked
    },
    monitor: {
      interval: parseInt(document.getElementById('monitor-interval').value, 10) || 1000
    },
    app: {
      autostart:      document.getElementById('app-autostart').checked,
      minimizeToTray: document.getElementById('app-minimizeToTray').checked
    }
  };
}

document.getElementById('btn-save').addEventListener('click', async () => {
  const settings = collectSettings();
  const result = await window.api.saveSettings(settings);
  if (result.success) showFeedback('btn-save', 'Salvato ✓', 2000);
});

document.getElementById('btn-test').addEventListener('click', async () => {
  const btn = document.getElementById('btn-test');
  const resultEl = document.getElementById('test-result');
  btn.disabled = true;
  resultEl.textContent = 'Connessione in corso…';
  resultEl.className = '';

  const mqttConfig = collectSettings().mqtt;
  const result = await window.api.testConnection(mqttConfig);

  resultEl.textContent = result.success ? '✓ Connesso' : `✗ ${result.error}`;
  resultEl.className = result.success ? 'success' : 'error';
  btn.disabled = false;
});

window.api.onTemperature((temp) => {
  document.getElementById('status-temp').textContent = `Temp: ${temp}°C`;
});

window.api.onMqttStatus((status) => {
  const el = document.getElementById('status-mqtt');
  const labels = { connected: 'MQTT: connesso', disconnected: 'MQTT: disconnesso', error: 'MQTT: errore' };
  el.textContent = labels[status] ?? status;
  el.className = `status ${status}`;
});

function showFeedback(btnId, text, ms) {
  const btn = document.getElementById(btnId);
  const orig = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = orig; }, ms);
}

loadSettings();
