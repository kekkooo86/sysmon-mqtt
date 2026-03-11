# Piano: SysMon MQTT

## Problema
Creare un'applicazione Electron professionale che monitora i sensori di sistema (CPU, GPU, RAM, disco, rete) e pubblica i valori tramite MQTT su qualsiasi broker compatibile, con tray icon, autostart e supporto cross-platform (Windows/macOS/Linux).

## Approccio
App Electron con architettura main/renderer ben separata. Il processo principale gestisce il monitoraggio, MQTT e il tray; il renderer mostra l'UI di configurazione e stato.

---

## Struttura Progetto

```
/
├── src/
│   ├── main/
│   │   ├── index.js          # Entry point Electron — finestre, lifecycle
│   │   ├── tray.js           # Tray icon: menu dinamico con temp corrente
│   │   ├── mqtt-client.js    # Connessione MQTT, publish, eventi
│   │   ├── cpu-monitor.js    # Polling temperatura CPU, detect state change
│   │   ├── store.js          # Persistenza impostazioni (electron-store)
│   │   ├── autostart.js      # Gestione avvio automatico cross-platform
│   │   └── ipc-handlers.js   # IPC bridge main ↔ renderer
│   └── renderer/
│       ├── index.html        # Shell HTML
│       ├── app.js            # Logica renderer (vanilla JS)
│       └── styles.css        # UI moderna, dark/light theme
├── assets/
│   ├── icon.png              # App icon (256x256+)
│   ├── tray-icon.png         # Tray icon (16x16, 32x32)
│   └── tray-icon-active.png  # Tray icon quando connesso
├── package.json
└── electron-builder.yml      # Config build cross-platform
```

---

## Stack Tecnologico

| Libreria | Scopo |
|---|---|
| `electron` | Framework app desktop |
| `electron-builder` | Packaging Windows/macOS/Linux |
| `electron-store` | Persistenza settings su disco |
| `mqtt` | Client MQTT (v5 compatible) |
| `systeminformation` | Lettura temperatura CPU cross-platform |
| `electron-updater` | (opzionale) Auto-update futuro |

---

## Funzionalità Core

### 1. Configurazione MQTT
- Host, porta, username, password, client ID
- Topic publish (configurabile, es. `{prefix}/sensor/cpu_temp/state`)
- TLS on/off
- QoS (0/1/2)
- Retain flag
- Last Will Testament topic/payload

### 2. Monitoraggio CPU
- Polling ogni N secondi (configurabile, default 5s)
- Rilevamento cambio di stato (non si pubblica ad ogni tick, solo ai cambi)
- Soglie configurabili: normal / warm / hot / critical
- Temperatura in °C con 1 decimale

### 3. Payload MQTT
- Modalità "valore grezzo": pubblica solo il numero (es. `"65.3"`)
- Modalità "JSON": pubblica `{"temperature": 65.3, "state": "warm", "unit": "C"}`
- Topic prefix globale `{prefix}` con risoluzione al momento del publish

### 4. Tray Icon
- Mostra temperatura corrente nel tooltip
- Menu: temperatura attuale, stato connessione, Apri impostazioni, Separator, Esci
- Icona cambia colore in base allo stato (verde/giallo/rosso)
- Click sull'icona → apre/mostra finestra impostazioni

### 5. Autostart
- Checkbox nelle impostazioni
- Usa `app.setLoginItemSettings()` (built-in Electron, più affidabile)
- Avvio diretto in tray (finestra nascosta)

### 6. Finestra Impostazioni
- Tab "Connessione": parametri MQTT
- Tab "Monitoraggio": soglie, intervallo polling, payload format
- Tab "Applicazione": autostart, minimize to tray, tema
- Status bar: connessione MQTT (connected/disconnected/error), ultima temp pubblicata
- Pulsante "Test connessione"
- Pulsante "Pubblica ora" (manual trigger)

---

## Note Tecniche

- **IPC Security**: `contextIsolation: true`, `nodeIntegration: false`, preload script per esporre API sicure
- **systeminformation** su Linux richiede permessi per leggere la temp (sysfs) — gestire errore gracefully
- Su macOS la temperatura CPU potrebbe non essere accessibile senza tool aggiuntivi (SMC) — fallback a load%
- Electron-builder produce: `.exe` + NSIS installer (Windows), `.dmg` (macOS), `.AppImage` + `.deb` (Linux)
- Icone da generare in formato PNG multi-risoluzione; su Windows serve anche `.ico`, su macOS `.icns`

---

## TODO List

1. **setup-project** — Setup package.json, dipendenze, struttura cartelle
2. **create-assets** — Creare icone placeholder (tray + app icon) in assets/
3. **implement-store** — `src/main/store.js`: schema settings con defaults
4. **implement-cpu-monitor** — `src/main/cpu-monitor.js`: polling + state machine
5. **implement-mqtt-client** — `src/main/mqtt-client.js`: connect/disconnect/publish + events
6. **implement-tray** — `src/main/tray.js`: tray icon, menu dinamico, aggiornamento temp
7. **implement-autostart** — `src/main/autostart.js`: wrapper setLoginItemSettings
8. **implement-ipc** — `src/main/ipc-handlers.js` + `src/main/preload.js`: bridge sicuro
9. **implement-main** — `src/main/index.js`: lifecycle app, finestra principale
10. **implement-renderer** — `src/renderer/`: UI impostazioni a tab, status bar
11. **implement-styles** — CSS moderno, variabili colore, dark/light
12. **configure-builder** — `electron-builder.yml`: target per tutti i platform
13. **test-integration** — Test end-to-end: avvio, connessione, pubblicazione, tray
14. **polish** — Gestione errori, logging, edge cases

---

## Dipendenze

- setup-project → tutti
- implement-store → implement-cpu-monitor, implement-mqtt-client, implement-main
- implement-cpu-monitor → implement-tray, implement-ipc
- implement-mqtt-client → implement-tray, implement-ipc
- implement-tray → implement-main
- implement-ipc → implement-renderer
- implement-main → implement-renderer
- implement-renderer → implement-styles
- implement-main + implement-renderer → configure-builder → test-integration → polish
