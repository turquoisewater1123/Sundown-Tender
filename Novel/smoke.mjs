import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
if (!process.env.NOVEL_DATA_DIR || process.env.NOVEL_QA_CLEANUP !== '1') throw new Error('An isolated QA database is required');
const {handleNovel,closeNovelData}=await import('./server.mjs');
const {atomic,database}=await import('./mongo.mjs');

const server = http.createServer((req, res) => handleNovel(req, res, true));
try {
    await atomic(session => database.collection('smoke').insertOne({_id:randomUUID()}, {session}));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port + '/novel/';
    assert.equal((await fetch(base)).status, 200);
    const library = await (await fetch(base + 'api/library')).json();
    assert.ok(library.cards?.length >= 6);
    console.log('Verified transaction, mobile page and library with', library.cards.length, 'cards');
} finally {
    server.close();
    await closeNovelData();
}
