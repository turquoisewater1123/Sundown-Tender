import { createHash } from 'node:crypto';
import { MongoClient, BSON } from 'mongodb';
if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
const source = new MongoClient(process.env.SOURCE_MONGODB_URI || 'mongodb://127.0.0.1:27028/?replicaSet=nightread');
const target = new MongoClient(process.env.MONGODB_URI);
async function digest(db, name) {
    const hash = createHash('sha256');
    let count = 0;
    for await (const row of db.collection(name).find({}, {promoteValues:false}).sort({_id:1})) {
        hash.update(BSON.serialize(row));
        count++;
    }
    return count + ':' + hash.digest('hex');
}
try {
    const a = source.db('nightread'), b = target.db(process.env.MONGODB_DB || 'nightread');
    const names = async db => (await db.listCollections({}, {nameOnly:true}).toArray()).map(c=>c.name).sort();
    const collections = await names(a);
    if (!collections.length || JSON.stringify(collections) !== JSON.stringify(await names(b))) throw new Error('Collection list mismatch');
    for (const name of collections) {
        const [before, after] = await Promise.all([digest(a,name),digest(b,name)]);
        if (before !== after) throw new Error('Data mismatch in '+name);
        console.log(name, before);
    }
} finally {
    await Promise.all([source.close(),target.close()]);
}
