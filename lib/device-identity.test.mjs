import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionBinding, generateIdentity, signProof, verifyProof, randomToken, hashToken } from './device-identity.ts';
import { createSafetyCode } from './peer.ts';

test('device proof binds the saved public key, fresh challenge and current connection', async () => {
  const identity = await generateIdentity(), impostor = await generateIdentity();
  const challenge = randomToken();
  const binding = connectionBinding('v=0\r\na=fingerprint:sha-256 AA:BB\r\n', 'v=0\r\na=fingerprint:sha-256 CC:DD\r\n');
  const signature = await signProof(identity, challenge, binding);
  assert.equal(identity.privateKey.extractable, false);
  assert.equal(await verifyProof(identity.publicKey, signature, challenge, binding), true);
  assert.equal(await verifyProof(impostor.publicKey, signature, challenge, binding), false);
  assert.equal(await verifyProof(identity.publicKey, signature, randomToken(), binding), false);
  assert.equal(await verifyProof(identity.publicKey, signature, challenge, binding+'changed'), false);
});
test('pair tokens have 256 bits and hash consistently', async () => {
  const token = randomToken(); assert.match(token, /^[A-Za-z0-9_-]{43}$/); assert.equal((await hashToken(token)).length,64);
});
test('safety code reads fingerprints from serialized descriptions and ignores ICE changes', async () => {
  const offer = JSON.stringify({type:'offer',sdp:'v=0\r\na=fingerprint:sha-256 AA:BB\r\na=candidate:one\r\n'});
  const answer = JSON.stringify({type:'answer',sdp:'v=0\r\na=fingerprint:sha-256 CC:DD\r\n'});
  assert.equal(await createSafetyCode(offer, answer), await createSafetyCode(offer.replace('candidate:one','candidate:two'), answer));
});
