import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { database, branches, messages, media, atomic } from './mongo.mjs';

const journal = database.collection('pending_erasure');
const jobs = database.collection('image_jobs');
const safe = value => typeof value === 'string' && value.length > 0 && value !== '.' && !/[<>:"/\\|?*\x00-\x1f]|[ .]$/.test(value);
function missing() { throw Object.assign(new Error('记录已经不存在。'),{status:404}); }
function strings(value, result) {
    if (typeof value === 'string') result.add(value);
    else if(value && typeof value === 'object') for(const item of Object.values(value)) strings(item,result);
}

// Old translations have a content hash but no card ID. Match unchanged source
// fields (including author metadata and lore) only when they identify one card.
function anchors(value, result, path='') {
    if(typeof value==='string' && value.length>=14) result.add(JSON.stringify([path,value]));
    else if(value && typeof value==='object') for(const [key,item] of Object.entries(value)) anchors(item,result,path+'/'+key);
}
async function retireTranslations(original,others,opts) {
    const translations=database.collection('chinese_cards'), fragments=database.collection('translated_fields');
    const owned=new Set(), elsewhere=new Set(), retained=new Set(), removed=new Set();
    anchors(original.original,owned);
    for(const other of others) {anchors(other.original,elsewhere);strings(other.original,retained);}
    for(const key of [...owned]) if(elsewhere.delete(key)) owned.delete(key);
    const hashes=[];
    for(const doc of await translations.find({},opts).toArray()) {
        const keys=new Set();anchors(doc.info,keys);
        if(doc._id===original.sourceHash || (doc.info.creator===original.original.creator &&
            [...keys].some(key=>owned.has(key)) && ![...keys].some(key=>elsewhere.has(key)) && !others.some(other=>other.sourceHash===doc._id))) {
            hashes.push(doc._id);
            strings(doc.info,removed);
        }
        else strings(doc.info,retained);
    }
    if(!hashes.length) return {hashes,fields:[]};
    await translations.deleteMany({_id:{$in:hashes}},opts);
    // This retired cache stores individual translated chunks. Keep chunks used by
    // surviving cards or translations, including chunks shared between stories.
    const corpus=[...retained].join('\u0000');
    const deletedText=[...removed].join('\u0000');
    const fields=(await fragments.find({},opts).toArray()).filter(doc=>typeof doc.value==='string' && deletedText.includes(doc.value) && !corpus.includes(doc.value)).map(doc=>doc._id);
    await fragments.deleteMany({_id:{$in:fields}},opts);
    return {hashes,fields};
}
function eraseLegacy(path, plan) {
    if(!existsSync(path)) return;
    const db=new DatabaseSync(path);
    try {
        db.exec('PRAGMA secure_delete=ON; BEGIN IMMEDIATE');
        const ids=new Set(plan.ids);
        if(plan.card) for(const row of db.prepare('SELECT id FROM branches WHERE card=?').all(plan.card)) ids.add(row.id);
        for(const id of ids) {
            db.prepare('UPDATE branches SET parent=NULL,fork_at=NULL WHERE parent=?').run(id);
            for(const table of ['messages','media']) db.prepare('DELETE FROM '+table+' WHERE branch=?').run(id);
            db.prepare('DELETE FROM branches WHERE id=?').run(id);
        }
        for(const [table,hashes] of [['chinese_cards',plan.hashes],['translated_fields',plan.fields]]) {
            if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
            for(const hash of hashes) db.prepare('DELETE FROM '+table+' WHERE hash=?').run(hash);
        }
        db.exec('COMMIT');
    } finally { db.close(); }
}

export function createRemoval({packsRoot,data,tavern,art,catalogs}) {
    let outstanding=false;
    const roots={pack:packsRoot,character:join(tavern,'characters'),chat:join(tavern,'chats'),thumbnail:join(tavern,'thumbnails','avatar'),art,media:join(data,'media')};
    async function finish() {
        for(const plan of await journal.find().toArray()) {
            for(const [kind,...names] of plan.files) {
                if(!roots[kind] || !names.length || !names.every(safe)) throw new Error('文件路径无效');
                const root=resolve(roots[kind]);
                const target=resolve(root,...names);
                if(!target.startsWith(root+sep)) throw new Error('删除目录无效');
                if(!existsSync(target)) continue;
                const parent=await realpath(dirname(target)), base=await realpath(root);
                if(parent!==base && !parent.startsWith(base+sep)) throw new Error('文件位于剧本目录外');
                const castFolder=kind==='art' && names.length===1 && names[0].endsWith('-cast');
                await rm(target,{recursive:kind==='pack' || kind==='chat' && names.length===1 || castFolder,force:true,maxRetries:3});
            }
            eraseLegacy(join(data,'novel.sqlite'),plan);
            if(plan.card) for(const [path,loaded] of catalogs) {
                const entries=JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
                if(Object.hasOwn(entries,plan.card)) {
                    delete entries[plan.card];
                    const temporary=path+'.erase.tmp';
                    await writeFile(temporary,JSON.stringify(entries,null,2)+'\n');
                    await rename(temporary,path);
                }
                delete loaded[plan.card];
            }
            await journal.deleteOne({_id:plan._id});
        }
        outstanding=false;
    }

    async function erase(kind,target,title) {
        const files=[];
        const card=kind==='story' ? target : null;
        if(kind!=='branch') {
            const match=/^(pack|tavern):(.+)$/.exec(target);
            if(!match || !safe(match[2])) missing();
            const [,source,name]=match;
            const dir=source==='pack' ? roots.pack : roots.character;
            const entries=await readdir(dir,{withFileTypes:true});
            if(!entries.some(e=>e.name===name && (source==='pack'?e.isDirectory():e.isFile() && /\.png$/i.test(name)))) missing();
            const stem=basename(name,'.png');
            if(kind==='old-chat') {
                if(source!=='tavern' || !safe(title)) missing();
                if(!(await readdir(join(roots.chat,stem))).includes(title+'.jsonl')) missing();
                files.push(['chat',stem,title+'.jsonl']);
            } else if(source==='pack') files.push(['pack',name]);
            else {
                files.push(['character',name],['chat',stem],['thumbnail',name]);
                for(const file of await readdir(art)) if(file===stem+'-cast' || file===stem+'-face.jpg' || file===stem+'-cover.jpg' || (file.startsWith(stem+'-scene-') && /\.(jpg|webp|png)$/i.test(file))) files.push(['art',file]);
            }
        }
        await atomic(async session=>{
            const opts={session};
            const ids=kind==='branch'?[target]:card?await branches.distinct('id',{card},opts):[];
            if(kind==='branch' && !await branches.findOne({_id:target},opts)) missing();
            const filter={branch:{$in:ids}};
            const candidates=new Set(await media.distinct('file',filter,opts));
            for(const job of await jobs.find(filter,opts).toArray()) {
                candidates.add(job.id+'.reference.png'); candidates.add(job.id+'.png');
                if(job.reference)candidates.add(job.reference);
            }
            const memories=new Set();
            for(const id of ids) {
                const rows=await messages.find({branch:id},opts).sort({position:1}).toArray();
                for(let i=0;i<rows.length;i+=8) {
                    let content='';
                    for(const row of rows.slice(i,i+8)) {
                        content+=(content?'\n':'')+(row.role==='user'?'玩家：':'角色：')+row.text;
                        memories.add(createHash('sha256').update('memory-v1'+content).digest('hex'));
                    }
                }
            }
            await database.collection('story_memory').deleteMany({_id:{$in:[...memories]}},opts);
            await jobs.deleteMany(filter,opts);
            await media.deleteMany(filter,opts);
            await messages.deleteMany(filter,opts);
            await branches.deleteMany({_id:{$in:ids}},opts);
            if(kind==='branch') await branches.updateMany({parent:target},{$set:{parent:null,fork_at:null}},opts);
            let hashes=[],fields=[];
            if(card) {
                const cards=database.collection('cards');
                const original=await cards.findOne({_id:card},opts);
                await cards.deleteOne({_id:card},opts);
                if(original?.sourceHash && !await cards.findOne({sourceHash:original.sourceHash},opts)) {
                    ({hashes,fields}=await retireTranslations(original,await cards.find({},opts).toArray(),opts));
                }
            }
            const retained=new Set(await media.distinct('file',{file:{$in:[...candidates]}},opts));
            const garbage=[...candidates].filter(file=>safe(file)&&!retained.has(file)).map(file=>['media',file]);
            await journal.insertOne({_id:randomUUID(),card,ids,hashes,fields,files:[...files,...garbage]},opts);
        });
        outstanding=true;
        await finish();
    }
    return {finish,erase,get outstanding(){return outstanding;}};
}
