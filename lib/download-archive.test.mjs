import assert from 'node:assert/strict';
import test from 'node:test';
import { createDownloadArchive } from './download-archive.ts';

test('ZIP preserves bytes, UTF-8 filenames, empty files, and duplicate names', async () => {
  const files = [
    {name:'résumé.txt', blob:new Blob(['123456789'])},
    {name:'résumé.txt', blob:new Blob(['second'])},
    {name:'empty.txt', blob:new Blob([])},
    {name:'../outside.txt', blob:new Blob([new Uint8Array([0,255,7])])},
  ];
  const zip = await createDownloadArchive(files);
  assert.equal(zip.type, 'application/zip');
  const buffer = await zip.arrayBuffer(), v = new DataView(buffer), bytes = new Uint8Array(buffer);
  let offset=0;
  const names=[], offsets=[];
  for (const [index,file] of files.entries()) {
    offsets.push(offset);
    assert.equal(v.getUint32(offset,true),0x04034b50);
    assert.equal(v.getUint16(offset+6,true),0x0800);
    assert.equal(v.getUint16(offset+8,true),0);
    if(index===0) assert.equal(v.getUint32(offset+14,true),0xcbf43926);
    const size=v.getUint32(offset+18,true), length=v.getUint16(offset+26,true);
    names.push(new TextDecoder().decode(bytes.slice(offset+30,offset+30+length)));
    assert.deepEqual(bytes.slice(offset+30+length,offset+30+length+size),new Uint8Array(await file.blob.arrayBuffer()));
    offset+=30+length+size;
  }
  assert.deepEqual(names,['résumé.txt','2-résumé.txt','empty.txt','.._outside.txt']);
  const directoryOffset=offset;
  for(const fileOffset of offsets){
    assert.equal(v.getUint32(offset,true),0x02014b50);
    assert.equal(v.getUint32(offset+42,true),fileOffset);
    offset+=46+v.getUint16(offset+28,true);
  }
  assert.equal(v.getUint32(offset,true),0x06054b50);
  assert.equal(v.getUint16(offset+10,true),files.length);
  assert.equal(v.getUint32(offset+16,true),directoryOffset);
});

test('ZIP rejects collections beyond the retained-download limit',async()=>{
  await assert.rejects(createDownloadArchive([]));
  await assert.rejects(createDownloadArchive([{name:'large',blob:{size:257*1024*1024}}]));
});

test('archives files retained across multiple maximum-size selections', async () => {
  const zip=await createDownloadArchive(Array.from({length:1001},(_,i)=>({name:`${i}.txt`,blob:new Blob([])})));
  const buffer=await zip.arrayBuffer();
  assert.equal(new DataView(buffer).getUint16(buffer.byteLength-12,true),1001);
});
