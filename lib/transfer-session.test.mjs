import assert from 'node:assert/strict';
import test from 'node:test';
import { TransferSession } from './transfer-session.ts';
import { CHUNK_PAYLOAD_SIZE, isTransferControlMessage, encodeChunk, MAX_TRANSFER_BYTES, MAX_BATCH_BYTES } from './transfer-protocol.ts';

class Transport extends EventTarget {
  recordBinary = true; readyState = 'open'; bufferedAmount = 0; out = []; other; drop = () => false;
  send(data) {
    if (this.readyState !== 'open') throw new Error('closed');
    const m = typeof data === 'string' ? JSON.parse(data) : data;
    if (this.recordBinary || !(m instanceof ArrayBuffer)) this.out.push(m);
    if (!this.drop(m)) queueMicrotask(() => this.other?.(m));
  }
  close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')); }
}
function setup(timeout = 25, autoApprove = true, options = {}) {
  const a = new Transport(), b = new Transport();
  const result = { files: [], senderDone: 0, receiverDone: 0, senderErrors: [], receiverErrors: [], offered: 0 };
  const noop = () => {};
  const callbacks = { onOffer: noop, onStart: noop, onStatus: noop, onProgress: noop, onFile: noop, onComplete: noop, onError: noop };
  const sender = new TransferSession(a, 'send', { ...callbacks, onComplete: () => result.senderDone++, onError: e => result.senderErrors.push(e) }, timeout);
  const receiver = new TransferSession(b, 'receive', { ...callbacks,
    onOffer: offer => { if (offer) { result.offered++; if (autoApprove) queueMicrotask(() => receiver.approve(options)); } },
    onFile: file => result.files.push(file), onComplete: () => result.receiverDone++, onError: e => result.receiverErrors.push(e),
  }, timeout);
  a.other = m => receiver.receive(m); b.other = m => sender.receive(m);
  return { a, b, sender, receiver, result, cleanup: () => { sender.dispose(); receiver.dispose(); } };
}
const file = (size, name='sample.bin') => new File([new Uint8Array(size).map((_, i) => i % 251)], name);

test('strictly rejects malformed control fields and size/chunk mismatches', () => {
  for (const m of [{type:'file-start'}, {type:'chunk-ack',id:'f',nextChunk:'bad'}, {type:'batch-start',id:'b',count:-1,totalBytes:0}, {type:'file-start',id:'f',name:'../bad',size:1,mime:'',totalChunks:1}, {type:'file-start',id:'f',name:'ok',size:1,mime:'',totalChunks:3}]) assert.equal(isTransferControlMessage(m), false);
});
test('transfers multiple windows and empty files, confirming byte-for-byte receiver completion', async () => {
  const s = setup(200);
  try {
    const original = file(CHUNK_PAYLOAD_SIZE * 70 + 13);
    await s.sender.send([original, file(0, 'empty.txt')]);
    assert.equal(s.result.senderDone, 1); assert.equal(s.result.receiverDone, 1);
    assert.equal(s.result.files.length, 2);
    assert.deepEqual(new Uint8Array(await s.result.files[0].blob.arrayBuffer()), new Uint8Array(await original.arrayBuffer()));
    assert.equal(s.result.files[1].blob.size, 0);
    assert.equal(s.result.senderErrors.length + s.result.receiverErrors.length, 0);
  } finally { s.cleanup(); }
});
test('does not transmit file bytes until the receiver approves', async () => {
  const s = setup(100, false);
  try {
    const sending = s.sender.send([file(20)]);
    await new Promise(r => setTimeout(r, 5));
    assert.equal(s.result.offered, 1); assert.equal(s.a.out.length, 1);
    s.receiver.approve(); await sending; assert.equal(s.result.senderDone, 1);
  } finally { s.cleanup(); }
});
test('re-acknowledges a duplicate window after the first acknowledgment is lost', async () => {
  const s = setup(); let dropped = false;
  s.b.drop = m => { if (m.type === 'chunk-ack' && !dropped) { dropped = true; return true; } return false; };
  try {
    await s.sender.send([file(100)]);
    assert.equal(s.result.senderDone, 1); assert.equal(s.result.files.length, 1);
    assert.equal(s.b.out.filter(m => m.type === 'chunk-ack').length, 2);
  } finally { s.cleanup(); }
});
test('never reports sender success without the final receiver confirmation', async () => {
  const s = setup(); s.b.drop = m => m.type === 'batch-complete';
  try { await s.sender.send([file(20)]); assert.equal(s.result.senderDone, 0); assert.equal(s.result.senderErrors.length, 1); assert.equal(s.result.files.length, 1); }
  finally { s.cleanup(); }
});
test('cancellation aborts waits promptly and preserves a completed earlier file', async () => {
  const s = setup(200);
  s.a.drop = m => { if (m.type === 'file-start' && m.name === 'second.bin') { queueMicrotask(() => s.receiver.cancel()); return true; } return false; };
  try {
    await s.sender.send([file(10, 'first.bin'), file(50, 'second.bin')]);
    assert.equal(s.result.senderDone, 0); assert.equal(s.result.files.length, 1); assert.equal(s.result.files[0].name, 'first.bin'); assert.equal(s.result.senderErrors.length, 1);
  } finally { s.cleanup(); }
});
test('rejects short chunks and never offers a corrupt download', async () => {
  const s = setup(100);
  s.a.drop = m => { if (m instanceof ArrayBuffer) { queueMicrotask(() => s.receiver.receive(encodeChunk(0, new ArrayBuffer(1)))); return true; } return false; };
  try { await s.sender.send([file(20)]); assert.equal(s.result.files.length, 0); assert.equal(s.result.receiverErrors.length, 1); assert.equal(s.result.senderDone, 0); }
  finally { s.cleanup(); }
});
test('channel closure aborts a pending approval promptly', async () => {
  const s = setup(500, false);
  try {
    const sending = s.sender.send([file(20)]);
    s.a.close(); await sending;
    assert.equal(s.result.senderDone, 0); assert.match(s.result.senderErrors[0].message, /disconnected/);
  } finally { s.cleanup(); }
});

test('rejects premature batch completion and chunks before approval', async () => {
  for (const approved of [false, true]) {
    const s = setup(100, false);
    try {
      s.receiver.receive({type:'batch-start',id:'batch',count:1,totalBytes:20});
      await new Promise(setImmediate);
      if (approved) {
        s.receiver.approve();
        s.receiver.receive({type:'batch-end',id:'batch'});
      } else s.receiver.receive(encodeChunk(0,new ArrayBuffer(20)));
      await new Promise(setImmediate);
      assert.equal(s.result.receiverDone,0); assert.equal(s.result.receiverErrors.length,1); assert.equal(s.result.files.length,0);
    } finally { s.cleanup(); }
  }
});
test('forged acknowledgments cannot skip unsent chunks', async () => {
  const s=setup();
  s.b.drop=m=>{
    if(m.type==='chunk-ack') { queueMicrotask(()=>s.sender.receive({...m,nextChunk:m.nextChunk+1})); return true; }
    return false;
  };
  try { await s.sender.send([file(20)]); assert.equal(s.result.senderDone,0); assert.equal(s.result.senderErrors.length,1); }
  finally { s.cleanup(); }
});
test('oversized selections are rejected before sending any metadata', async () => {
  const s=setup();
  try { await s.sender.send([{name:'too-large.bin',size:MAX_TRANSFER_BYTES+1}]); assert.equal(s.a.out.some(m=>m.type==='batch-start'),false); assert.equal(s.result.senderErrors.length,1); }
  finally { s.cleanup(); }
});

const syntheticFile = (size, name = 'large.bin') => ({
  name, size, type: 'application/octet-stream',
  slice(start, end) { return { async arrayBuffer() { return new Uint8Array(Math.max(0, Math.min(end, size) - start)).fill(71).buffer; } }; },
});

test('streams a regular file larger than 256 MiB without retaining a Blob', async () => {
  let bytes = 0, closed = false, maxWrite = 0;
  const s = setup(2000, true, { openFile: async () => ({
    write: async chunk => { bytes += chunk.length; maxWrite = Math.max(maxWrite, chunk.length); assert.equal(chunk[0],71); },
    close: async () => { closed = true; }, abort: async () => {},
  }) });
  s.a.recordBinary = false;
  try {
    await s.sender.send([syntheticFile(MAX_BATCH_BYTES + 17)]);
    assert.equal(bytes, MAX_BATCH_BYTES + 17); assert.ok(maxWrite <= CHUNK_PAYLOAD_SIZE);
    assert.ok(closed); assert.equal(s.result.senderDone,1);
    assert.equal(s.result.files[0].blob, undefined);
    assert.equal(s.result.senderErrors.length + s.result.receiverErrors.length,0);
  } finally { s.cleanup(); }
});

test('pauses a large collection before the next file until saved downloads are released', async () => {
  let pauses = 0;
  const s = setup(2000, true, { beforeFile: async () => {
    pauses++;
    assert.equal(s.result.files.length,1);
    assert.equal(s.a.out.filter(m => m.type === 'file-start').length,2);
    assert.equal(s.b.out.filter(m => m.type === 'file-ready').length,1);
    await new Promise(resolve => setTimeout(resolve,5));
    s.result.files.length=0; // User saved and cleared the first batch.
  } });
  s.a.recordBinary=false;
  try {
    await s.sender.send([syntheticFile(129*1024*1024,'one.bin'),syntheticFile(129*1024*1024,'two.bin')]);
    assert.equal(pauses,1); assert.equal(s.result.senderDone,1);
    assert.equal(s.result.files[0].name,'two.bin');
    assert.equal(s.result.senderErrors.length+s.result.receiverErrors.length,0);
  } finally { s.cleanup(); }
});

test('memory receiving rejects an oversized individual file before bytes arrive', async () => {
  const s=setup();
  try {
    await s.sender.send([syntheticFile(MAX_BATCH_BYTES+1)]);
    assert.equal(s.a.out.filter(m=>m instanceof ArrayBuffer).length,0);
    assert.equal(s.result.senderDone,0); assert.equal(s.result.receiverErrors.length,1);
  } finally {s.cleanup();}
});

test('disk write failures abort the partial file and never acknowledge completion', async () => {
  let aborted=0;
  const s=setup(200,true,{openFile:async()=>({write:async()=>{throw Error('Disk full');},close:async()=>{},abort:async()=>{aborted++;}})});
  try {
    await s.sender.send([file(30)]);
    assert.equal(aborted,1); assert.equal(s.result.files.length,0); assert.equal(s.result.senderDone,0);
    assert.equal(s.b.out.filter(m=>m.type==='chunk-ack').length,0);
  }finally{s.cleanup();}
});

test('disk close must succeed before a file is reported complete', async () => {
  const s=setup(200,true,{openFile:async()=>({write:async()=>{},close:async()=>{throw Error('Could not commit file');},abort:async()=>{}})});
  try{await s.sender.send([file(1)]);assert.equal(s.result.senderDone,0);assert.equal(s.result.files.length,0);}
  finally{s.cleanup();}
});

test('slow storage bounds queued bytes and cancellation aborts the sink', async () => {
  let release, aborted=0;
  const s=setup(1000,false);
  try {
    s.receiver.receive({type:'batch-start',id:'b',count:1,totalBytes:CHUNK_PAYLOAD_SIZE*200,version:2,largestFile:CHUNK_PAYLOAD_SIZE*200});
    await new Promise(setImmediate);
    s.receiver.approve({openFile:async()=>({write:()=>new Promise(r=>release=r),close:async()=>{},abort:async()=>{aborted++;release?.();}})});
    s.receiver.receive({type:'file-start',id:'f',name:'f',mime:'',size:CHUNK_PAYLOAD_SIZE*200,totalChunks:200});
    await new Promise(setImmediate);
    s.receiver.receive(encodeChunk(0,new ArrayBuffer(CHUNK_PAYLOAD_SIZE)));
    await new Promise(setImmediate);
    for(let i=1;i<150;i++)s.receiver.receive(encodeChunk(i,new ArrayBuffer(CHUNK_PAYLOAD_SIZE)));
    await new Promise(setImmediate);
    assert.equal(aborted,1); assert.equal(s.result.receiverErrors.length,1);
    assert.equal(s.result.files.length,0);
  } finally{s.cleanup();}
});

test('reuses a connection but requires fresh approval for every collection', async () => {
  const s = setup(200, false);
  try {
    const first = s.sender.send([file(12, 'first.txt')]);
    await new Promise(setImmediate); s.receiver.approve(); await first;
    assert.equal(s.sender.canSendMore, true);
    const frames = s.a.out.filter(m => m instanceof ArrayBuffer).length;
    const second = s.sender.send([file(23, 'second.txt'), file(0, 'empty.txt')]);
    await new Promise(setImmediate);
    assert.equal(s.result.offered, 2);
    assert.equal(s.result.senderDone, 1);
    assert.equal(s.a.out.filter(m => m instanceof ArrayBuffer).length, frames);
    s.receiver.approve(); await second;
    assert.equal(s.result.senderDone, 2); assert.equal(s.result.receiverDone, 2);
    assert.deepEqual(s.result.files.map(f => f.name), ['first.txt', 'second.txt', 'empty.txt']);
    assert.equal(s.result.senderErrors.length + s.result.receiverErrors.length, 0);
  } finally { s.cleanup(); }
});

test('does not offer connection reuse to receivers without repeat support', async () => {
  const s = setup(200);
  s.b.other = message => {
    if (message.type === 'batch-accept') { const {repeat, ...legacy} = message; s.sender.receive(legacy); }
    else s.sender.receive(message);
  };
  try {
    await s.sender.send([file(12)]);
    assert.equal(s.sender.canSendMore, false);
    const count = s.a.out.length;
    await s.sender.send([file(15)]);
    assert.equal(s.a.out.length, count);
  } finally { s.cleanup(); }
});

test('declining a second collection preserves the completed first collection', async () => {
  const s = setup(200, false);
  try {
    const first = s.sender.send([file(12)]);
    await new Promise(setImmediate); s.receiver.approve(); await first;
    const second = s.sender.send([file(23)]);
    await new Promise(setImmediate); s.receiver.decline(); await second;
    assert.equal(s.result.senderDone, 1); assert.equal(s.result.files.length, 1);
    assert.equal(s.sender.canSendMore, false);
    assert.equal(s.result.senderErrors.length, 1);
  } finally { s.cleanup(); }
});

test('counts retained downloads when approving a new collection', async () => {
  let release;
  const pause = new Promise(resolve => { release=resolve; });
  let paused=false;
  const s=setup(200,false);
  try {
    const sending=s.sender.send([file(1)]);
    await new Promise(setImmediate);
    s.receiver.approve({retainedBytes:MAX_BATCH_BYTES,beforeFile:async()=>{paused=true;await pause;}});
    await new Promise(setImmediate);
    assert.equal(paused,true);
    assert.equal(s.a.out.some(m=>m instanceof ArrayBuffer),false);
    release();await sending;
    assert.equal(s.result.senderDone,1);
  } finally {release();s.cleanup();}
});

test('received active content is exposed only as a generic download', async () => {
  const s = setup(200);
  try {
    await s.sender.send([new File(['<script>alert(1)</script>'], 'untrusted.html', { type: 'text/html' })]);
    assert.equal(s.result.files[0].blob.type, 'application/octet-stream');
    assert.equal(await s.result.files[0].blob.text(), '<script>alert(1)</script>');
  } finally { s.cleanup(); }
});
