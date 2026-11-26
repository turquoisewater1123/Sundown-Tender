import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const scratch = await mkdtemp(resolve('logs/import-qa-'));
process.env.NOVEL_DATA_DIR = scratch;
process.env.NOVEL_PACKS_DIR = join(scratch,'packs');
process.env.NOVEL_QA_CLEANUP = '1';
const {handleNovel,closeNovelData} = await import('../../Novel/server.mjs');
const server = createServer(handleNovel);
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const base = 'http://127.0.0.1:'+server.address().port+'/novel/api/';
const original = {spec:'chara_card_v3',spec_version:'3.0',data:{
    name:'Mira',description:'She keeps exactly 17 blue keys.',scenario:'At the railway station.',
    first_mes:'{{user}}, did you hear the bell?',alternate_greetings:['The midnight train has arrived.'],
    extensions:{visual_novel:{activeSetId:'default',sprites:{}}}
}};
async function importFile() {
    const res = await fetch(base+'import-card',{method:'POST',body:JSON.stringify(original)});
    assert.equal(res.status,200,await res.text());
}
try {
    await importFile();
    const library = await (await fetch(base+'library')).json();
    const entry = library.cards.find(row=>row.id.startsWith('pack:'));
    assert.equal(entry.needsTranslation,false);
    const copy = async kind => (await fetch(base+'card-copy/'+encodeURIComponent(entry.id)+'/'+kind)).json();
    assert.deepEqual(await copy('original'),original);
    const translated = await copy('zh');
    assert.equal(translated.spec,original.spec);
    const info = translated.data;
    assert.match(info.description,/17/);
    assert.match(info.description,/蓝/);
    assert.match(info.description,/钥匙/);
    assert.match(info.first_mes,/\{\{user\}\}/);
    assert.match(info.alternate_greetings[0],/午夜|半夜|子夜/);
    assert.deepEqual(info.extensions,original.data.extensions);
    const start = Date.now();
    await importFile();
    console.log(info.description,info.alternate_greetings[0], '重复导入耗时', Date.now()-start,'毫秒');
} finally {
    server.closeAllConnections();
    server.close();
    await closeNovelData();
    await rm(scratch,{recursive:true,force:true});
}
