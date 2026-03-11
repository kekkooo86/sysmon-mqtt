# Copilot Instructions

## Project Overview

Electron desktop app that monitors CPU temperature and publishes state changes via MQTT to Home Assistant. It toggles an RGB LED (or any HA entity) based on configurable temperature thresholds. Features a system tray icon, settings window, and autostart support (Windows/macOS/Linux).

**Status:** Early development — project structure is being built from `PLAN.md`.

## Planned Architecture

```
src/
  main/
    index.js          # Electron entry point — window lifecycle, app setup
    tray.js           # Tray icon with dynamic menu showing current temp
    mqtt-client.js    # MQTT connect/disconnect/publish + event emitter
    cpu-monitor.js    # CPU temp polling, state machine (normal/warm/hot/critical)
    store.js          # Settings persistence via electron-store
    autostart.js      # Login item wrapper using app.setLoginItemSettings()
    ipc-handlers.js   # IPC bridge main ↔ renderer
    preload.js        # Secure context bridge (contextIsolation: true)
  renderer/
    index.html        # Settings window shell
    app.js            # Renderer logic (vanilla JS, no framework)
    styles.css        # Dark/light theme, CSS variables
assets/
  icon.png            # App icon (256x256+)
  tray-icon.png       # 16x16 / 32x32
  tray-icon-active.png
electron-builder.yml  # Cross-platform build config
```

## Tech Stack

| Package | Role |
|---|---|
| `electron` | Desktop framework |
| `electron-builder` | Package for Windows (.exe/NSIS), macOS (.dmg), Linux (.AppImage/.deb) |
| `electron-store` | Persistent settings on disk |
| `mqtt` | MQTT v5 client |
| `systeminformation` | Cross-platform CPU temperature reading |

## Key Conventions

### IPC / Security
- `contextIsolation: true`, `nodeIntegration: false` always.
- All main↔renderer communication goes through `preload.js` via `contextBridge`.
- `ipc-handlers.js` registers all `ipcMain` listeners; renderer calls through the preload-exposed API only.

### CPU Monitor State Machine
- States: `normal` / `warm` / `hot` / `critical` (thresholds configurable).
- Only publishes to MQTT on **state change**, not on every polling tick.
- Polling interval is configurable (default 5s).
- Temperature is always in °C with 1 decimal place.

### Home Assistant MQTT Sensors

These are the active HA sensors listening on the broker:

```yaml
binary_sensor:
  - name: led_temp_cpu_pc_gaming_state
    unique_id: led_temp_cpu_pc_gaming_state
    state_topic: "pc_gaming/lights/cpu_temperature/state"
    payload_on: "ON"
    payload_off: "OFF"

sensor:
  - name: "temp_cpu_pc_gaming"
    state_topic: "pc_gaming/sensor/cpu_temperature/state"
    unit_of_measurement: "°C"
    value_template: "{{ value }}"
```

- **Binary sensor topic** `pc_gaming/lights/cpu_temperature/state` — expects `ON` or `OFF` (raw string, no JSON)
- **Temperature sensor topic** `pc_gaming/sensor/cpu_temperature/state` — expects the raw °C value as a plain number string (e.g. `"65.3"`)

**Cosa pubblicare e quando:**

| Topic | Payload | Quando |
|---|---|---|
| `pc_gaming/sensor/cpu_temperature/state` | valore grezzo °C, es. `"65.3"` | ad ogni cambio di temperatura rilevato |
| `pc_gaming/lights/cpu_temperature/state` | `ON` oppure `OFF` | per accendere/spegnere il controller LED |

Flusso completo:
1. App legge temp CPU → pubblica su `sensor/...` → HA copia in `input_number` → automazione interpola il colore RGB del LED
2. App pubblica `ON`/`OFF` su `lights/...` → HA accende o spegne fisicamente `light.controller_rgb_bcc74e`

### Home Assistant Automations

Queste automazioni HA gestiscono il ciclo completo dal valore MQTT al LED fisico:

1. **`Aggiorna input_number.temp_cpu_pc_gaming da mqtt`**
   - Trigger: cambio stato di `sensor.temp_cpu_pc_gaming` (aggiornato dal topic MQTT)
   - Azione: copia il valore in `input_number.temp_cpu_pc_gaming` (usato come sorgente per le altre automazioni)

2. **`Cambio colore LED scrivania stanzetta cpu pc gaming`**
   - Trigger: cambio di `input_number.temp_cpu_pc_gaming`
   - Condizioni: `binary_sensor.led_temp_cpu_pc_gaming_state` = ON **e** `light.luce_stanzetta_pp` = OFF
   - Azione: imposta il colore RGB di `light.controller_rgb_bcc74e` con interpolazione:
     - `≤ 30°C` → blu `[0, 0, 255]`
     - `30–57.5°C` → interpolazione blu → verde
     - `57.5–85°C` → interpolazione verde → rosso
     - `> 85°C` → rosso `[255, 0, 0]`

3. **`Gestisci stato controller led cpu pc gaming`**
   - Trigger: cambio di `binary_sensor.led_temp_cpu_pc_gaming_state`
   - Se ON → accende `light.controller_rgb_bcc74e` in bianco `[255, 255, 255]`
   - Se OFF → spegne `light.controller_rgb_bcc74e`

4. **`accendi spegni led gaming cpu`**
   - Trigger: cambio di `light.luce_stanzetta_pp` (luce principale della stanza)
   - Se la luce principale si spegne → accende il LED RGB della CPU
   - Se la luce principale si accende → spegne il LED RGB della CPU
   - Logica: il LED CPU è attivo solo quando la stanza è al buio

**Entità HA coinvolte:**
| Entità | Tipo | Ruolo |
|---|---|---|
| `sensor.temp_cpu_pc_gaming` | sensor | Riceve il valore grezzo dal topic MQTT |
| `input_number.temp_cpu_pc_gaming` | input_number | Intermediario per le automazioni colore |
| `binary_sensor.led_temp_cpu_pc_gaming_state` | binary_sensor | ON/OFF del LED dal topic MQTT |
| `light.controller_rgb_bcc74e` | light | LED RGB fisico da controllare |
| `light.luce_stanzetta_pp` | light | Luce principale stanza (trigger on/off LED) |

### MQTT Payload Formats
- **Raw mode:** publishes just the number string, e.g. `"65.3"`
- **JSON mode:** `{"temperature": 65.3, "state": "warm", "unit": "C"}`
- Optional Home Assistant MQTT Discovery support.
- Configurable: topic, QoS (0/1/2), retain flag, LWT topic/payload, TLS on/off.

### Platform Notes
- **Linux:** `systeminformation` reads from sysfs — handle permission errors gracefully.
- **macOS:** CPU temp may be inaccessible without SMC tools — fall back to CPU load %.
- **Windows:** Icons need `.ico`; macOS needs `.icns` — generate from the PNG sources in `assets/`.
- Autostart uses `app.setLoginItemSettings()` (built-in Electron, no third-party needed).

### Tray
- Tooltip shows current temperature.
- Icon changes based on state (green → normal, yellow → warm, red → hot/critical).
- Left-click opens/focuses the settings window.

## Build Commands

```bash
npm install          # Install all dependencies
npm start            # Run in development (electron .)
npm run build        # Package via electron-builder (all platforms)
npm run build:win    # Windows only
npm run build:mac    # macOS only
npm run build:linux  # Linux only
```

> Scripts above reflect the intended setup from PLAN.md — add them to `package.json` as modules are implemented.
