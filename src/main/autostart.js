const { app } = require('electron');

function enable() {
  app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
}

function disable() {
  app.setLoginItemSettings({ openAtLogin: false });
}

function isEnabled() {
  return app.getLoginItemSettings().openAtLogin;
}

module.exports = { enable, disable, isEnabled };
