import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedMessageQueue } from './message-queue.ts';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('bounds queued messages while cryptographic verification is pending', async () => {
  let release, errors = 0, handled = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const queue = new BoundedMessageQueue(() => errors++);
  queue.push('hello', () => pending);
  await tick();
  for (let i = 0; i < 300; i++) queue.push('proof', async () => { handled++; });
  assert.equal(errors, 1);
  release(); await tick();
  assert.equal(handled, 0);
});

test('rejects oversized and unsupported frames before processing', () => {
  for (const frame of ['x'.repeat(16385), new ArrayBuffer(16385), new Blob(['x'])]) {
    let errors = 0;
    new BoundedMessageQueue(() => errors++).push(frame, async () => assert.fail());
    assert.equal(errors, 1);
  }
});

test('preserves message order across asynchronous verification', async () => {
  const order = [];
  const queue = new BoundedMessageQueue(error => assert.fail(error.message));
  queue.push('hello', async () => { await tick(); order.push('verified'); });
  queue.push('offer', async () => { order.push('offer'); });
  await tick(); await tick();
  assert.deepEqual(order, ['verified', 'offer']);
});
