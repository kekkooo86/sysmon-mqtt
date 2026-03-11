const { EventEmitter } = require('events');
const mqtt = require('mqtt');

class MqttClient extends EventEmitter {
  constructor() {
    super();
    this._client = null;
    this._connected = false;
  }

  connect(config) {
    if (this._client) this.disconnect();

    const { host, port, username, password, clientId, tls } = config;
    const protocol = tls ? 'mqtts' : 'mqtt';
    const url = `${protocol}://${host}:${port}`;

    const options = {
      clientId,
      clean: true,
      reconnectPeriod: 5000,
      ...(username && { username }),
      ...(password && { password })
    };

    this._client = mqtt.connect(url, options);

    this._client.on('connect', () => {
      this._connected = true;
      this.emit('connected');
    });

    this._client.on('disconnect', () => {
      this._connected = false;
      this.emit('disconnected');
    });

    this._client.on('error', (err) => {
      this._connected = false;
      this.emit('error', err);
    });

    this._client.on('close', () => {
      this._connected = false;
      this.emit('disconnected');
    });
  }

  disconnect() {
    if (this._client) {
      this._client.end(true);
      this._client = null;
      this._connected = false;
    }
  }

  publish(topic, payload, options = {}) {
    if (!this._client || !this._connected) return;
    this._client.publish(topic, String(payload), options);
  }

  get isConnected() {
    return this._connected;
  }
}

module.exports = new MqttClient();
