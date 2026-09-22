import assert from 'node:assert/strict';
import test from 'node:test';
import { DeviceHandshake } from './device-handshake.ts';
import { generateIdentity, randomToken } from './device-identity.ts';
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const descriptions = {localDescription:{sdp:'v=0\r\na=fingerprint:sha-256 A\r\n'},remoteDescription:{sdp:'v=0\r\na=fingerprint:sha-256 B\r\n'}};

test('handshake start is idempotent and both device keys are verified', async () => {
 const aKey=await generateIdentity(), bKey=await generateIdentity();
 let a, b, hellos=0, ready=0; const errors=[];
 const callbacks={onReady:()=>ready++,onError:e=>errors.push(e),onPairOffer:()=>{},onPairResult:()=>{}};
 const aChannel={readyState:'open',send:s=>{ if(JSON.parse(s).type==='device-hello') hellos++; queueMicrotask(()=>b.receive(JSON.parse(s))); }};
 const bChannel={readyState:'open',send:s=>queueMicrotask(()=>a.receive(JSON.parse(s)))};
 a=new DeviceHandshake(aChannel,descriptions,aKey,'A',null,callbacks);
 b=new DeviceHandshake(bChannel,descriptions,bKey,'B',null,callbacks);
 try { a.start(); a.start(); b.start(); b.start(); await tick(); assert.equal(hellos,1); assert.equal(ready,2); assert.deepEqual(errors,[]); }
 finally { a.stop(); b.stop(); }
});
test('a remembered device cannot substitute a new key', async () => {
 const key=await generateIdentity(); let error;
 const handshake=new DeviceHandshake({readyState:'open',send:()=>{}},descriptions,key,'A',{publicKey:'pinned-key'}, {onReady:()=>assert.fail('must not verify'),onError:e=>error=e,onPairOffer:()=>{},onPairResult:()=>{}});
 try { handshake.start(); handshake.receive({type:'device-hello',version:1,name:'B',publicKey:key.publicKey,challenge:randomToken()}); await tick(); assert.match(error.message,/identity changed/); }
 finally { handshake.stop(); }
});

test('automatic offers wait for queued device verification and still require receiver approval', async () => {
 const { TransferSession } = await import('./transfer-session.ts');
 const { isDeviceMessage } = await import('./device-handshake.ts');
 const identities = await Promise.all([generateIdentity(), generateIdentity()]);
 const errors = [], received = [];
 let offers = 0, binaryFrames = 0, sending;
 let offerReady;
 const offered = new Promise(resolve => { offerReady = resolve; });
 const channels = [new EventTarget(), new EventTarget()];
 const handshakes = [], sessions = [], queues = [Promise.resolve(), Promise.resolve()];
 const callbacks = { onOffer:()=>{}, onStart:()=>{}, onStatus:()=>{}, onProgress:()=>{}, onFile:()=>{}, onComplete:()=>{}, onError:e=>errors.push(e) };
 channels.forEach((channel, i) => {
   channel.readyState = 'open'; channel.bufferedAmount = 0;
   channel.send = data => {
     if (data instanceof ArrayBuffer) binaryFrames++;
     const message = typeof data === 'string' ? JSON.parse(data) : data;
     const other = 1-i;
     queues[other] = queues[other].then(async () => {
       if (isDeviceMessage(message)) await handshakes[other].receive(message);
       else {
         assert.equal(handshakes[other].verified, true, 'offer must follow async verification');
         sessions[other].receive(message);
       }
     }).catch(e => errors.push(e));
   };
   sessions[i] = new TransferSession(channel, i===0 ? 'send' : 'receive', { ...callbacks,
     onOffer: offer => { if (offer) { offers++; offerReady(); } }, onFile: file => received.push(file),
   }, 200);
   handshakes[i] = new DeviceHandshake(channel, descriptions, identities[i], `Device ${i}`, null, {
     onReady: () => { if(i===0) sending=sessions[0].send([new File(['hello'], 'hello.txt')]); },
     onError:e=>errors.push(e), onPairOffer:()=>{}, onPairResult:()=>{},
   });
 });
 try {
   handshakes.forEach(h=>h.start());
   await offered;
   assert.equal(offers, 1); assert.equal(binaryFrames, 0);
   sessions[1].approve(); await sending;
   assert.deepEqual(errors, []);
   assert.equal(await received[0].blob.text(), 'hello');
 } finally { handshakes.forEach(h=>h.stop()); sessions.forEach(s=>s.dispose()); }
});
