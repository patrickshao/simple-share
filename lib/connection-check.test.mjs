import test from 'node:test';
import assert from 'node:assert/strict';
import { checkConnection } from './connection-check.ts';

function fake(types, complete = true) {
  const listeners = {};
  return {
    closed: 0,
    addEventListener(name, fn) { listeners[name] = fn; },
    close() { this.closed++; },
    createDataChannel() {},
    async createOffer() { return {}; },
    async setLocalDescription() {
      for (const type of types) listeners.icecandidate({ candidate: { type } });
      if (complete) listeners.icecandidate({ candidate: null });
    },
  };
}
for (const [types, expected] of [[[], 'no-candidates'], [['host'], 'local-only'], [['host', 'srflx'], 'available'], [['srflx'], 'public-only']]) {
  test(`candidate probe reports ${expected} and closes the peer`, async () => {
    const peer = fake(types);
    assert.equal(await checkConnection(() => peer, new AbortController().signal), expected);
    assert.equal(peer.closed, 1);
  });
}
test('blocked WebRTC and offer failures are handled', async () => {
  assert.equal(await checkConnection(() => { throw Error('blocked'); }, new AbortController().signal), 'unavailable');
  const peer = fake([]);
  peer.createOffer = async () => { throw Error('blocked'); };
  assert.equal(await checkConnection(() => peer, new AbortController().signal), 'unavailable');
  assert.equal(peer.closed, 1);
});
test('gathering timeout and cancellation close probe resources', async () => {
  const peer = fake(['host'], false);
  assert.equal(await checkConnection(() => peer, new AbortController().signal, 10), 'local-only');
  assert.equal(peer.closed, 1);
  const pending = fake([], false);
  const controller = new AbortController();
  const result = checkConnection(() => pending, controller.signal);
  controller.abort();
  await result;
  assert.equal(pending.closed, 1);
});
