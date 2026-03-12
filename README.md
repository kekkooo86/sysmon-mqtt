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

## Windows

### Prerequisites

#### Node.js

Install **Node.js 20 LTS** from https://nodejs.org (use the Windows `.msi` installer).

Verify in PowerShell:
```powershell
node -v   # v20.x.x
npm -v    # 10.x.x
```

#### LibreHardwareMonitor (required for CPU temperature)

On Windows, CPU temperature cannot be read without a companion tool that has ring-0 hardware
access. SysMon-MQTT uses **LibreHardwareMonitor** (free, open source) as its primary backend.

1. Download the latest release from:
   https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases
   → choose `LibreHardwareMonitor-net472.zip` (or the latest available)

2. Extract to any folder (e.g. `C:\Program Files\LibreHardwareMonitor\`)

3. Run **`LibreHardwareMonitor.exe` as Administrator**
   (right-click → *Run as administrator* — required for hardware register access)

4. Enable the HTTP sensor server:
   `Options` → check **"Run remote web server"**

   SysMon-MQTT polls `http://localhost:8085/data.json` automatically while LHM is running.

5. *(Optional but recommended)* Start LHM automatically with Windows:
   `Options` → check **"Start with Windows"**

   To ensure it always runs with administrator privileges at boot, create a scheduled task:
   - Open **Task Scheduler** → *Create Task*
   - General tab: check **"Run with highest privileges"**
   - Trigger: **At log on**
   - Action: start `LibreHardwareMonitor.exe`

> **Without LHM running**, CPU temperature will show as unavailable. All other sensors
> (CPU load, RAM, disk, network, GPU usage) work natively without any companion app.

#### Supported alternative backends (auto-detected, no configuration needed)

SysMon-MQTT tries these backends in order and uses the first one that responds:

| Backend | How to enable |
|---|---|
| **LibreHardwareMonitor HTTP** ✅ *recommended* | Options → "Run remote web server" |
| **OpenHardwareMonitor WMI** | Run OHM as Administrator |
| **HWiNFO64 Shared Memory** | Settings → General → "Shared Memory Support" *(12h limit on free tier)* |
| **Core Temp** | Run Core Temp from https://www.alcpu.com/CoreTemp/ |

---

### Running in development

```powershell
cd path\to\sysmon-mqtt
npm install
npm start
```

> Start LibreHardwareMonitor (as Administrator, with "Run remote web server" enabled) before
> launching SysMon-MQTT so CPU temperature is available immediately.

### Building the Windows installer (`.exe`)

```powershell
npm run build:win
# Output: dist\SysMon-MQTT Setup <version>.exe  (NSIS installer, ~74 MB)
```

No code signing certificate is required. The build script disables signing automatically.

### Installing

Double-click `SysMon-MQTT Setup <version>.exe`. The installer lets you choose the installation
directory and creates a Start Menu shortcut. The app starts minimized to the system tray.

### Sensor availability on Windows

| Sensor | Available | Notes |
|---|---|---|
| CPU Usage | ✅ Always | |
| CPU Temp (max) | ⚠️ Requires LHM | See prerequisites above |
| RAM Used / RAM Used (GB) | ✅ Always | |
| GPU Usage | ✅ Always | Via Windows native performance counters |
| GPU Temperature | ⚠️ Requires LHM | Exposed by LHM if GPU driver supports it |
| Disk Usage / Free | ✅ Always | Per drive |
| Network Upload / Download | ✅ Always | Per interface |

### Autostart on login (Windows)

Autostart is managed directly from the app — no manual setup needed.

1. Open the Settings window (click the tray icon)
2. Toggle **"Start on login"** → ON

The app writes the autostart entry to the Windows registry
(`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`) automatically via the standard
Electron API. It will launch silently to the tray on the next login.

To disable, toggle **"Start on login"** → OFF in the Settings window.

---

## Linux (`.deb`)

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

