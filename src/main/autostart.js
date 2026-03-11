const { app } = require('electron');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// On Linux, Electron's setLoginItemSettings requires the app to already have a
// .desktop file installed in a system/user applications directory, which AppImages
// and dev-mode runs don't have. We manage ~/.config/autostart/ directly instead.
// On macOS/Windows the native Electron API works fine.

function getDesktopFilePath() {
  const name = app.getName().replace(/ /g, '-') + '.desktop';
  return path.join(os.homedir(), '.config', 'autostart', name);
}

// Returns the executable path to embed in Exec=.
// - AppImage: use $APPIMAGE (actual .AppImage file, not the squashfs mount)
// - Packaged .deb/rpm: process.execPath is the installed app binary (no extra args needed)
// - Dev mode: electron binary + app directory path
function getExecLine() {
  if (process.env.APPIMAGE) {
    return process.env.APPIMAGE;
  }
  if (app.isPackaged) {
    return process.execPath;
  }
  return `${process.execPath} "${app.getAppPath()}"`;
}

function buildDesktopEntry() {
  const exec = getExecLine();
  // Quote the executable path if it contains spaces (XDG Desktop Entry spec)
  const execQuoted = exec.includes(' ') ? `"${exec}"` : exec;
  return [
    '[Desktop Entry]',
    `Name=${app.getName()}`,
    `Exec=${execQuoted} --no-sandbox`,
    'Terminal=false',
    'Type=Application',
    `Comment=${app.getName()} autostart`,
    'X-GNOME-Autostart-enabled=true',
  ].join('\n') + '\n';
}

function enable() {
  if (process.platform === 'linux') {
    const dir = path.join(os.homedir(), '.config', 'autostart');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getDesktopFilePath(), buildDesktopEntry(), 'utf8');
  } else {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
  }
}

function disable() {
  if (process.platform === 'linux') {
    try { fs.unlinkSync(getDesktopFilePath()); } catch (_) { /* already gone */ }
  } else {
    app.setLoginItemSettings({ openAtLogin: false });
  }
}

function isEnabled() {
  if (process.platform === 'linux') {
    return fs.existsSync(getDesktopFilePath());
  }
  return app.getLoginItemSettings().openAtLogin;
}

module.exports = { enable, disable, isEnabled };
