import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDebugLogger } from '../utils/debugLogger.js';

test('connection diagnostics omit tokens, typed text and response bodies', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'firetv-log-test-'));
  const previous = process.env.APP_DATA_DIR;
  process.env.APP_DATA_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.APP_DATA_DIR;
    else process.env.APP_DATA_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  t.mock.method(console, 'info', () => {});
  createDebugLogger('test').info('Received Fire TV HTTPS response.', {
    statusCode: 200, reusedSocket: true, token: 'secret-token', tokenPreview: 'secr',
    responsePreview: 'private-response', text: 'private-text',
  });
  const text = fs.readFileSync(path.join(directory, 'logs/connection.log'), 'utf8');
  const entry = JSON.parse(text);
  assert.equal(entry.statusCode, 200);
  assert.equal(entry.reusedSocket, true);
  assert.ok(!/secret|secr|private|token|text/.test(text));
  assert.equal(console.info.mock.callCount(), 1);
});
