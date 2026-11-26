import { MongoClient } from 'mongodb';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('../', import.meta.url));
const envPath = join(root, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);
if (!process.env.MONGODB_URI) throw new Error('请在 .env 中设置 MONGODB_URI，详见 README。');
const client = new MongoClient(process.env.MONGODB_URI, {serverSelectionTimeoutMS:15000});
const scratch = process.env.NOVEL_DATA_DIR;
export const database = client.db(scratch ? 'qa_'+createHash('sha256').update(scratch).digest('hex').slice(0,20) : (process.env.MONGODB_DB || 'nightread'));
await client.connect();
export const branches = database.collection('branches'), messages = database.collection('messages'), media = database.collection('media');
await messages.createIndex({branch:1,position:1},{unique:true});
await media.createIndex({branch:1,position:1});
await branches.createIndex({created:-1});
export async function atomic(fn) { return client.withSession(session=>session.withTransaction(()=>fn(session))); }

// Read the old store once. The marker is committed in the same transaction as the imported records.
const legacy = join(scratch || join(root,'Novel','data'),'novel.sqlite');
if (existsSync(legacy) && !await database.collection('migrations').findOne({_id:'sqlite-v1'})) {
    const old = new DatabaseSync(legacy,{readOnly:true});
    try {
        old.exec('BEGIN');
        await atomic(async session=>{
            for (const table of ['branches','messages','media','chinese_cards','translated_fields']) {
                if (!old.prepare('SELECT name FROM sqlite_master WHERE name=?').get(table)) continue;
                const rows = old.prepare('SELECT rowid AS ordinal,* FROM '+table).all();
                for (const row of rows) {
                    const _id = row.id || row.hash || [row.branch,row.position].join('/');
                    if (row.info) row.info=JSON.parse(row.info);
                    if (row.state) row.state=JSON.parse(row.state);
                    await database.collection(table).updateOne({_id},{$setOnInsert:row},{upsert:true,session});
                }
            }
            await database.collection('migrations').insertOne({_id:'sqlite-v1',date:new Date()},{session});
        });
    } finally { old.close(); }
}
export async function closeMongo() {
    if(scratch && process.env.NOVEL_QA_CLEANUP === '1') await database.dropDatabase();
    await client.close();
}
