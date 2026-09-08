import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { createFireTvRequest } from '../utils/fireTvRequest.js';
import { HybridTransport } from '../transports/hybridTransport.js';
import { FireTvHttpsTransport } from '../transports/firetvHttpsTransport.js';

const quiet = { info() {}, warn() {}, error() {} };
const device = { host: '10.0.0.2', token: 'test-token' };
const store = { findDeviceByHost: () => device, listDevices: () => [device] };
function response(callback, body = '{}') {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  callback(res);
  res.emit('data', body);
  res.emit('end');
}
function mockRequest(t, handler) {
  t.mock.method(https, 'request', (url, options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = error => req.emit('error', error);
    req.end = () => queueMicrotask(() => handler(req, callback, options));
    return req;
  });
}

test('interrupted response releases host queue for the next request', async t => {
  let calls = 0;
  mockRequest(t, (req, callback) => {
    if (++calls === 1) {
      const res = new EventEmitter();
      callback(res);
      res.emit('aborted');
      res.emit('error', new Error('premature close'));
    } else response(callback);
  });
  const request = createFireTvRequest({ devicesStore: store, logger: quiet });
  const first = request(device, '/status');
  const second = request(device, '/status');
  await assert.rejects(first, { code: 'HTTPS_RESPONSE_INTERRUPTED' });
  assert.equal((await second).statusCode, 200);
  assert.equal(calls, 2);
});

test('status timeout retries once on a fresh socket', async t => {
  const attempts = [];
  mockRequest(t, (req, callback, options) => {
    attempts.push(options);
    if (attempts.length === 1) req.emit('error', Object.assign(new Error('idle socket'), { code: 'ETIMEDOUT' }));
    else response(callback);
  });
  const request = createFireTvRequest({ devicesStore: store, logger: quiet });
  assert.equal((await request(device, '/status')).statusCode, 200);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].headers.Connection, 'close');
});

test('a failed fresh POST is not automatically replayed', async t => {
  let calls = 0;
  mockRequest(t, req => {
    calls++;
    req.reusedSocket = false;
    req.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
  });
  const request = createFireTvRequest({ devicesStore: store, logger: quiet });
  await assert.rejects(request(device, '/action', { method: 'POST', body: {} }), { code: 'HTTPS_UNREACHABLE' });
  assert.equal(calls, 1);
});

test('a stale reused socket gets one fresh retry', async t => {
  let calls = 0;
  mockRequest(t, (req, callback) => {
    if (++calls === 1) {
      req.reusedSocket = true;
      req.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
    } else response(callback);
  });
  const request = createFireTvRequest({ devicesStore: store, logger: quiet });
  assert.equal((await request(device, '/action', { method: 'POST' })).statusCode, 200);
  assert.equal(calls, 2);
});

test('an unavailable HTTPS session recovers before the next command', async () => {
  const actions = [];
  const hybrid = new HybridTransport({
    fireTvHttpsTransport: {
      async probe() { return { authenticated: true, tokenValid: true, httpsReachable: true, pairingRequired: false }; },
      async sendRemoteAction(_device, action) { actions.push(action); return { ok: true, transportUsed: 'https' }; },
    },
    adbTransport: { getAvailability() { throw new Error('must not fall back'); } },
    logger: quiet,
  });
  const result = await hybrid.sendRemoteAction(device, { authenticated: false, adbConnected: true }, 'dpad_up');
  assert.equal(result.result.transportUsed, 'https');
  assert.equal(result.session.preferredTransports.remoteControl, 'https');
  assert.deepEqual(actions, ['dpad_up']);
});

test('unreachable HTTPS recovery is rate-limited while ADB remains usable', async () => {
  let probes = 0;
  const hybrid = new HybridTransport({
    fireTvHttpsTransport: { async probe() { probes++; return { authenticated: false, httpsReachable: false }; } },
    adbTransport: {
      getAvailability() { return { adbAvailable: true }; },
      async sendRemoteAction() { return { ok: true, transportUsed: 'adb' }; },
    },
    logger: quiet,
  });
  let session = { authenticated: false, adbConnected: true };
  for (let i = 0; i < 3; i++) {
    const result = await hybrid.sendRemoteAction(device, session, 'dpad_up');
    session = result.session;
    assert.equal(result.result.transportUsed, 'adb');
  }
  assert.equal(probes, 1);
});

test('invalid token status consistently requests pairing', async () => {
  const transport = new FireTvHttpsTransport({ fireTvRequest: async () => ({ statusCode: 401, bodyText: 'invalid token' }) });
  const result = await transport.probe(device);
  assert.equal(result.tokenValid, false);
  assert.equal(result.pairingRequired, true);
  assert.equal(result.authenticated, false);
});

test('concurrent stale sessions share recovery and use the recovered result', async () => {
  let probes = 0;
  const hybrid = new HybridTransport({
    fireTvHttpsTransport: {
      async probe() { probes++; return { authenticated: true, tokenValid: true }; },
      async sendRemoteAction() { return { ok: true, transportUsed: 'https' }; },
    },
    adbTransport: { getAvailability() { throw new Error('must not fall back'); } },
    logger: quiet,
  });
  const stale = { authenticated: false, adbConnected: true };
  const results = await Promise.all([hybrid.sendRemoteAction(device, stale, 'dpad_up'), hybrid.sendRemoteAction(device, stale, 'dpad_down')]);
  results.push(await hybrid.sendRemoteAction(device, stale, 'dpad_up'));
  assert.equal(probes, 1);
  assert.ok(results.every(result => result.result.transportUsed === 'https'));
});
