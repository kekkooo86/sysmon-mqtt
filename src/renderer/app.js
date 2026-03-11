// ─── State ────────────────────────────────────────────────────────────────────
let availableSensors = []; // full list from main process
const liveValues = {};     // id → last received value
let currentPrefix = 'pc'; // mirrors the topicPrefix input

// ─── Topic resolution (mirrors src/main/utils.js) ────────────────────────────
function resolveTopic(template, prefix) {
  const p = (prefix || '').replace(/\/+$/, '');
  const resolved = p
    ? template.replace(/\{prefix\}/g, p)
    : template.replace(/\{prefix\}\//g, '');
  return resolved.replace(/\/\//g, '/');
}

// ─── Tab navigation ──────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ─── Sensor list rendering ────────────────────────────────────────────────────
const CATEGORY_LABELS = { cpu: 'CPU', gpu: 'GPU', memory: 'Memoria', disk: 'Disco', network: 'Rete' };
const CATEGORY_ORDER  = ['cpu', 'gpu', 'memory', 'disk', 'network'];

function renderSensors(sensors) {
  availableSensors = sensors;
  const list = document.getElementById('sensor-list');
  list.innerHTML = '';

  const grouped = {};
  for (const s of sensors) {
    (grouped[s.category] = grouped[s.category] || []).push(s);
  }

  for (const cat of CATEGORY_ORDER) {
    if (!grouped[cat]) continue;
    const group = document.createElement('div');
    group.className = 'sensor-group';
    group.innerHTML = `<h3 class="sensor-group-title">${CATEGORY_LABELS[cat] || cat}</h3>`;

    for (const s of grouped[cat]) {
      group.appendChild(buildSensorCard(s));
    }
    list.appendChild(group);
  }
  updateActiveSensorsCount();
}

function buildSensorCard(s) {
  const card = document.createElement('div');
  card.className = `sensor-card ${s.enabled ? 'enabled' : ''}`;
  card.dataset.id = s.id;

  card.innerHTML = `
    <div class="sensor-header">
      <label class="toggle">
        <input type="checkbox" class="sensor-enabled" ${s.enabled ? 'checked' : ''}>
        <span></span>
      </label>
      <span class="sensor-name">${s.name}</span>
      <span class="sensor-unit">${s.unit}</span>
      <span class="sensor-live" id="live-${s.id}">—</span>
    </div>
    <div class="sensor-details ${s.enabled ? '' : 'hidden'}">
      <div class="form-grid compact">
        <label>Topic</label>
        <input type="text" class="sensor-topic" value="${s.topic}">
        <label></label>
        <small class="topic-preview"></small>
        <label>Soglia (${s.unit})</label>
        <input type="number" class="sensor-threshold" value="${s.threshold}" min="0" step="0.1">
        <label>Intervallo (ms)</label>
        <input type="number" class="sensor-interval" value="${s.interval}" min="500" step="500" placeholder="1000">
      </div>
    </div>
  `;

  const checkbox   = card.querySelector('.sensor-enabled');
  const details    = card.querySelector('.sensor-details');
  const topicInput = card.querySelector('.sensor-topic');
  const preview    = card.querySelector('.topic-preview');

  updateSingleTopicPreview(topicInput, preview);

  topicInput.addEventListener('input', () => updateSingleTopicPreview(topicInput, preview));

  checkbox.addEventListener('change', () => {
    card.classList.toggle('enabled', checkbox.checked);
    details.classList.toggle('hidden', !checkbox.checked);
    updateActiveSensorsCount();
  });

  return card;
}

function updateActiveSensorsCount() {
  const count = document.querySelectorAll('.sensor-enabled:checked').length;
  document.getElementById('status-sensors').textContent = `${count} sensori attivi`;
}

function updateSingleTopicPreview(topicInput, previewEl) {
  const resolved = resolveTopic(topicInput.value.trim(), currentPrefix);
  previewEl.textContent = `→ ${resolved}`;
}

function updateAllTopicPreviews() {
  document.querySelectorAll('.sensor-card').forEach(card => {
    const topicInput = card.querySelector('.sensor-topic');
    const preview    = card.querySelector('.topic-preview');
    if (topicInput && preview) updateSingleTopicPreview(topicInput, preview);
  });
}

function collectSensorConfigs() {
  return availableSensors.map(s => {
    const card = document.querySelector(`.sensor-card[data-id="${s.id}"]`);
    if (!card) return null;
    return {
      id:        s.id,
      enabled:   card.querySelector('.sensor-enabled').checked,
      topic:     card.querySelector('.sensor-topic').value.trim(),
      threshold: parseFloat(card.querySelector('.sensor-threshold').value) || s.threshold,
      interval:  parseInt(card.querySelector('.sensor-interval').value, 10) || s.interval
    };
  }).filter(Boolean);
}

// ─── Live value updates ───────────────────────────────────────────────────────
window.api.onSensorUpdate(({ id, value, unit }) => {
  liveValues[id] = value;
  const el = document.getElementById(`live-${id}`);
  if (el) el.textContent = `${value} ${unit}`;
});

// ─── MQTT status ──────────────────────────────────────────────────────────────
window.api.onMqttStatus((status) => {
  const el = document.getElementById('status-mqtt');
  const labels = { connected: 'MQTT: connesso', disconnected: 'MQTT: disconnesso', error: 'MQTT: errore' };
  el.textContent = labels[status] ?? status;
  el.className = `status ${status}`;
});

// ─── Refresh sensors button ───────────────────────────────────────────────────
document.getElementById('btn-refresh-sensors').addEventListener('click', async () => {
  const btn = document.getElementById('btn-refresh-sensors');
  btn.disabled = true;
  btn.textContent = '↻ Ricerca...';
  const sensors = await window.api.getAvailableSensors();
  renderSensors(sensors);
  btn.disabled = false;
  btn.textContent = '↻ Scopri sensori';
});

// ─── Test connection ──────────────────────────────────────────────────────────
document.getElementById('btn-test').addEventListener('click', async () => {
  const btn = document.getElementById('btn-test');
  const resultEl = document.getElementById('test-result');
  btn.disabled = true;
  resultEl.textContent = 'Connessione...';
  resultEl.className = '';
  const result = await window.api.testConnection(collectMqttSettings());
  resultEl.textContent = result.success ? '✓ Connesso' : `✗ ${result.error}`;
  resultEl.className = result.success ? 'success' : 'error';
  btn.disabled = false;
});

// ─── Save ─────────────────────────────────────────────────────────────────────
document.getElementById('btn-save').addEventListener('click', async () => {
  const btn = document.getElementById('btn-save');
  btn.disabled = true;

  const [settingsResult, sensorsResult] = await Promise.all([
    window.api.saveSettings({
      mqtt: collectMqttSettings(),
      app:  collectAppSettings()
    }),
    window.api.saveSensorConfigs(collectSensorConfigs())
  ]);

  if (settingsResult.success && sensorsResult.success) {
    btn.textContent = 'Salvato ✓';
    setTimeout(() => { btn.textContent = 'Salva'; btn.disabled = false; }, 2000);
  } else {
    btn.textContent = 'Errore';
    btn.disabled = false;
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function collectMqttSettings() {
  return {
    host:        document.getElementById('mqtt-host').value.trim(),
    port:        parseInt(document.getElementById('mqtt-port').value, 10) || 1883,
    username:    document.getElementById('mqtt-username').value.trim(),
    password:    document.getElementById('mqtt-password').value,
    clientId:    document.getElementById('mqtt-clientId').value.trim(),
    topicPrefix: document.getElementById('mqtt-topicPrefix').value.trim(),
    qos:         parseInt(document.getElementById('mqtt-qos').value, 10),
    tls:         document.getElementById('mqtt-tls').checked,
    retain:      document.getElementById('mqtt-retain').checked
  };
}

function collectAppSettings() {
  return {
    autostart:      document.getElementById('app-autostart').checked,
    minimizeToTray: document.getElementById('app-minimizeToTray').checked
  };
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const [settings, sensors] = await Promise.all([
    window.api.getSettings(),
    window.api.getAvailableSensors()
  ]);

  document.getElementById('mqtt-host').value        = settings.mqtt.host        ?? '';
  document.getElementById('mqtt-port').value        = settings.mqtt.port        ?? 1883;
  document.getElementById('mqtt-username').value    = settings.mqtt.username    ?? '';
  document.getElementById('mqtt-password').value    = settings.mqtt.password    ?? '';
  document.getElementById('mqtt-clientId').value    = settings.mqtt.clientId    ?? '';
  document.getElementById('mqtt-topicPrefix').value = settings.mqtt.topicPrefix ?? 'pc';
  document.getElementById('mqtt-qos').value         = settings.mqtt.qos         ?? 0;
  document.getElementById('mqtt-tls').checked       = settings.mqtt.tls         ?? false;
  document.getElementById('mqtt-retain').checked    = settings.mqtt.retain      ?? false;
  document.getElementById('app-autostart').checked      = settings.app.autostart      ?? false;
  document.getElementById('app-minimizeToTray').checked = settings.app.minimizeToTray ?? true;

  currentPrefix = settings.mqtt.topicPrefix ?? 'pc';

  document.getElementById('mqtt-topicPrefix').addEventListener('input', (e) => {
    currentPrefix = e.target.value.trim();
    updateAllTopicPreviews();
  });

  renderSensors(sensors);
}

init();
