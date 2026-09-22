import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseReceiveFolder } from './receive-folder.ts';

test('folder receiving isolates transfers, numbers duplicate names, and removes aborted files', async () => {
  const names=[], removed=[], directories=[];
  const original=globalThis.window;
  globalThis.window={showDirectoryPicker:async()=>({getDirectoryHandle:async(name)=>{
    directories.push(name);
    return {getFileHandle:async(name)=>{names.push(name);return {createWritable:async()=>({write:async()=>{},close:async()=>{},abort:async()=>{}})};},removeEntry:async(name)=>{removed.push(name);}};
  }})};
  try {
    const folder=await chooseReceiveFolder();
    const controller=new AbortController();
    const first=await folder.openFile({name:'photo.jpg'},controller.signal);
    await first.close(); await first.abort();
    const second=await folder.openFile({name:'photo.jpg'},controller.signal); await second.abort();
    const long=await folder.openFile({name:'📷'.repeat(120)},controller.signal); await long.abort();
    assert.notEqual(names[0],names[1]); assert.match(names[0],/photo.jpg$/);
    assert.ok(new TextEncoder().encode(names[2]).length<=255);
    assert.deepEqual(removed,[names[1],names[2]]);
    assert.match(directories[0],/^Simple Share /);
    controller.abort(); await assert.rejects(folder.openFile({name:'cancelled'},controller.signal));
    assert.equal(names.length,3);
  }finally{if(original===undefined)delete globalThis.window;else globalThis.window=original;}
});
