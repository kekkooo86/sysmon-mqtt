#!/usr/bin/env node
/**
 * Test subscriber: reads broker credentials from electron-store
 * and subscribes to all topics (#) to verify messages arrive.
 * Run with: node test-subscriber.js
 */

const Store = require('electron-store');
const mqtt  = require('mqtt');

const store = new Store();
const cfg   = store.get('mqtt');

if (!cfg || !cfg.host) {
  console.error('No MQTT config found. Open the app and save settings first.');
  process.exit(1);
}

const protocol = cfg.tls ? 'mqtts' : 'mqtt';
const url       = `mqtt://mqtt:1883`;
const options   = {
  clientId: 'cpu-temp-test-subscriber',
  clean: true,
  reconnectPeriod: 0,
  username: 'kekko',
  password: '261101Genny!'
};

console.log(`Connecting to ${url} ...`);
const client = mqtt.connect(url, options);

client.on('connect', () => {
  console.log('Connected.\n');

  const topics = [
    cfg.topic,              // pc_gaming/sensor/cpu_temperature/state
    'cpu-temp-monitor/test' // self-test
  ];

  client.subscribe(topics, { qos: 1 }, (err, granted) => {
    if (err) {
      console.error('Subscribe error:', err.message);
      return;
    }
    granted.forEach(({ topic, qos }) => {
      if (qos === 128) console.warn(`[WARN] Subscription DENIED by broker: ${topic}`);
      else console.log(`[OK] Subscribed to "${topic}" (QoS ${qos})`);
    });

    // Self-test
    console.log(`\n[SELF-TEST] Publishing to "cpu-temp-monitor/test" with QoS 1 ...`);
    client.publish('cpu-temp-monitor/test', `selftest-${Date.now()}`, { qos: 1 }, (err) => {
      if (err) console.error('[SELF-TEST] Publish error:', err.message);
      else console.log('[SELF-TEST] Published ok — waiting for echo (3s)...');
      setTimeout(() => {
        console.log('\nListening for app messages on:', cfg.topic);
        console.log('(Ctrl+C to stop)\n');
      }, 3000);
    });
  });
});

client.on('message', (topic, payload) => {
  console.log(`[${new Date().toISOString()}] TOPIC: ${topic}  PAYLOAD: ${payload.toString()}`);
});

client.on('error', (err) => {
  console.error('Connection error:', err.message);
  process.exit(1);
});

process.on('SIGINT', () => {
  client.end();
  process.exit(0);
});
