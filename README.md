# SysMon MQTT

Electron desktop app that monitors system sensors (CPU, GPU, RAM, disk, network) and publishes their values to an MQTT broker. Configurable topics, thresholds, and polling intervals. No vendor lock-in — works with any MQTT-compatible system.

## Features

- Reads CPU temperature, CPU load, RAM usage, GPU metrics, disk and network stats via `systeminformation`
- Publishes each sensor to its own configurable MQTT topic
- Topic prefix support: set a global prefix (e.g. `pc_gaming`) and all topics are built as `{prefix}/sensor/<name>/state`
- System tray icon with live sensor tooltip
- Settings window: MQTT broker, per-sensor topics, thresholds, polling interval
- Autostart support (Linux, macOS, Windows)

---

## Installation (Linux `.deb`)

### Quick install — first time

If you're building and running for the first time, a single command handles everything: build, install the `.deb`, and launch the app:

```bash
npm run start:linux-deb-first-time
```

This is equivalent to:
1. `npm run build:linux` — builds the `.deb` package
2. `sudo dpkg -i dist/*.deb` — installs it system-wide
3. `sysmon-mqtt --no-sandbox` — launches the app

### Manual steps

Alternatively, run each step individually.

**Build:**
```bash
npm install
npm run build:linux
# output: dist/sysmon-mqtt_<version>_amd64.deb
```

**Install:**
```bash
sudo dpkg -i dist/sysmon-mqtt_1.0.0_amd64.deb
```

If there are missing dependencies, fix them with:

```bash
sudo apt-get install -f
```

**Launch:**

Electron on Linux requires the `--no-sandbox` flag when running as a regular user without kernel-level user namespaces:

```bash
sysmon-mqtt --no-sandbox
```

> The app appears in the system tray. Click the tray icon to open the Settings window and configure your MQTT broker.

### Rebuild and reinstall

To rebuild and reinstall after code changes (skips the first launch):

```bash
npm run install:linux-deb
```

---

## Autostart on Login (Linux)

Autostart is managed directly from the app — no manual setup needed.

### Enable via the Settings window

1. Open the Settings window (click the tray icon)
2. Toggle **"Start on login"** → ON
3. The app writes a `.desktop` file to `~/.config/autostart/` automatically, with `--no-sandbox` already included in the `Exec=` line

### Disable autostart

Toggle **"Start on login"** → OFF in the Settings window, or delete the file manually:

```bash
rm ~/.config/autostart/SysMon-MQTT.desktop
```

### Verify autostart is active

```bash
cat ~/.config/autostart/SysMon-MQTT.desktop
```

Expected output:

```ini
[Desktop Entry]
Name=SysMon-MQTT
Exec=sysmon-mqtt --no-sandbox
Terminal=false
Type=Application
Comment=SysMon-MQTT autostart
X-GNOME-Autostart-enabled=true
```

---

## Development

```bash
npm install       # Install dependencies
npm start         # Run in development mode (electron .)
npm run build     # Package for all platforms
npm run build:linux   # Linux only (.AppImage + .deb)
npm run build:win     # Windows only (.exe / NSIS)
npm run build:mac     # macOS only (.dmg)
```

