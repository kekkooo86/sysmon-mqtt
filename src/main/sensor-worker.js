'use strict';

/**
 * sensor-worker.js
 *
 * Worker Thread that runs systeminformation calls off the Electron main thread.
 * Accepts messages: { id: number, fn: string, args: any[] }
 * Responds with:    { id: number, result: any } | { id: number, error: string }
 */

const { parentPort } = require('worker_threads');
const si = require('systeminformation');

parentPort.on('message', async ({ id, fn, args }) => {
  try {
    const result = await si[fn](...(args || []));
    parentPort.postMessage({ id, result });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});
