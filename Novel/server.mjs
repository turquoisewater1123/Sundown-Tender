import { selectScene, galleryChoices, mergeState, stateDefaults, turnState, unpackTurn, readTurnHistory } from './turn-state.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { database, branches, messages, media as mediaRecords, atomic, closeMongo } from './mongo.mjs';
import { imageJobs, enqueueImage, startImageWorker } from './image-jobs.mjs';
import { sceneContext } from './scene-description.mjs';
import { createRemoval } from './removal.mjs';
import { upstream } from './text-upstream.mjs';
import { read as readCard } from '../SillyTavern/src/character-card-parser.js';
import { chineseStateSubset, parseSceneStatus, parseStateBlock, stripSceneStatusForDisplay } from '../assets/scene-status/status.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const packsRoot = process.env.NOVEL_PACKS_DIR || join(root, 'packs');
const data = process.env.NOVEL_DATA_DIR || join(root, 'data');
const tavern = join(root, '..', 'SillyTavern', 'data', 'default-user');
const settings = async () => JSON.parse(await readFile(process.env.NOVEL_SETTINGS || join(root, 'settings.json'), 'utf8'));
const mime = {
    '.json': 'application/json; charset=utf-8',
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.apng': 'image/apng', '.webm': 'video/webm', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.apk': 'application/vnd.android.package-archive',
    '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
const assetTypes = new Set(Object.keys(mime).filter(key => /^(image|audio|video)\//.test(mime[key]) && key !== '.svg'));
const safeName = name => typeof name === 'string' && name.length > 0 && name.length <= 180 &&
    !/[\\/:\x00-\x1f]/.test(name) && !/[. ]$/.test(name);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const readJson = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const artNotes=await readJson(join(root,'gallery-art-notes.json'));
const reviewedScenes=await readJson(join(root,'gallery-scenes.json'));
const list = path => readdir(path, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
});
const capture = (value, length) => typeof value === 'string' ? value.slice(0, length).trim() : '';
function fail(status, message) {
    throw Object.assign(new Error(message), { status });
}

await mkdir(join(data, 'media'), { recursive: true });
export const closeNovelData = closeMongo;
const busy = new Set();
let lastGeneration = null;

const publicFields = { _id:0, ordinal:0 };
async function branch(id, fromPosition) {
    const entry = await branches.findOne({_id:id},{projection:publicFields});
    if (!entry) fail(404,'找不到这份存档。');
    const filter = fromPosition === undefined ? {branch:id} : {branch:id,position:{$gte:fromPosition}};
    const assets = await mediaRecords.find(filter,{projection:{_id:0,id:1,type:1,mode:1,position:1}}).sort({ordinal:1,_id:1}).toArray();
    const rows = await messages.find(filter,{projection:{...publicFields,branch:0}}).sort({position:1}).toArray();
    return {...entry,messages:readTurnHistory(rows).map(row=>({...row,media:assets.filter(asset=>asset.position===row.position)}))};
}

const storyGuides = await readJson(join(root,'story-guides.json'));
const catalogTranslations = await readJson(join(root,'catalog-translations.json'));
const authorImages = await readJson(join(root,'author-art.json'));
const catalogs = [['story-guides.json',storyGuides],['catalog-translations.json',catalogTranslations],['author-art.json',authorImages]]
    .map(([file,loaded])=>[join(root,file),loaded]);
const removal = createRemoval({packsRoot,data,tavern,art:join(root,'public','art'),catalogs});
await removal.finish();
const imageWorker = startImageWorker({settings,directory:join(data,'media'),source:async(id,position)=>{
    const entry=await branch(id);
    const row=entry.messages[position];
    if(row?.role!=='assistant') throw new Error('这条剧情消息已经不存在。');
    const original=await originalCard(entry.card);
    const url=original.face || original.portrait;
    const parts=(url || '').split('/').map(decodeURIComponent);
    let reference;
    if(parts[0]==='pack' && parts.length===3 && safeName(parts[1]) && safeName(parts[2])) reference=join(packsRoot,parts[1],parts[2]);
    if(parts[0]==='avatar' && parts.length===2 && safeName(parts[1])) reference=join(tavern,'characters',parts[1]);
    if(parts[0]==='art' && parts.length===2 && safeName(parts[1])) reference=join(root,'public','art',parts[1]);
    const references = new Map();
    if(reference) references.set(original.info.name,new Map([['默认',reference]]));
    const folder=entry.card.startsWith('pack:') ? join(packsRoot,entry.card.slice(5),'cast') :
        join(root,'public','art',basename(entry.card.slice(7),'.png')+'-cast');
    for(const file of await list(folder)){
        if(!file.isFile() || !safeName(file.name) || !/\.(png|webp|jpe?g)$/i.test(file.name))continue;
        const label=basename(file.name,extname(file.name));
        const [,name,view]=/^(.+?)@(正面|侧面|背面|回头)$/.exec(label) || [null,label,'默认'];
        if(!references.has(name))references.set(name,new Map());
        references.get(name).set(view,join(folder,file.name));
    }
    return {info:original.info,text:row.text,context:sceneContext(entry.messages,position),references};
}});

async function originalCard(id) {
    if (typeof id !== 'string') fail(400, '请选择角色。');
    const [source, ...pieces] = id.split(':');
    const name = pieces.join(':');
    if (!safeName(name)) fail(404, '找不到角色。');
    try {
        if (source === 'tavern' && extname(name).toLowerCase() === '.png') {
            const path = join(tavern, 'characters', name);
            const png = await readFile(path);
            const raw = JSON.parse(readCard(png));
            const hasPortrait = png.readUInt32BE(16) > 1 || png.readUInt32BE(20) > 1;
            const stem = basename(name, extname(name));
            const artwork = await list(join(root, 'public', 'art'));
            const illustration = kind => {
                const file = stem + '-' + kind + '.jpg';
                return artwork.some(entry => entry.isFile() && entry.name === file) ? 'art/' + encodeURIComponent(file) : null;
            };
            const gallery=artwork.filter(entry=>entry.isFile() && entry.name.startsWith(stem+'-scene-') && /\.(jpg|webp|png)$/i.test(entry.name))
                .map(entry=>'art/'+encodeURIComponent(entry.name));
            const stagePrefix = stem + '-scene-stage-';
            const assets = Object.fromEntries(artwork.filter(entry => entry.isFile() &&
                entry.name.startsWith(stagePrefix) && entry.name.endsWith('.webp')).map(entry =>
                [entry.name.slice(stagePrefix.length, -5), 'art/' + encodeURIComponent(entry.name)]));
            const info = raw.data || raw;
            if (gallery.length > 1 && !Object.keys(assets).length && !info.extensions?.nightread?.gallery_order) {
                const order = gallery.slice().sort((a,b)=>a.localeCompare(b,'en',{numeric:true})).map((url,i)=>{
                    const key='插画'+(i+1);
                    assets[key]=url;
                    return key;
                });
                const descriptions=Object.fromEntries(order.map(key=>[key,artNotes[decodeURIComponent(assets[key].slice(4))]]).filter(([,note])=>note));
                return {raw,info:{...info,extensions:{...info.extensions,nightread:{...info.extensions?.nightread,gallery_order:order,gallery_descriptions:descriptions}}},
                    portrait:illustration('cover') || (hasPortrait ? `avatar/${encodeURIComponent(name)}` : null),face:illustration('face'),assets,gallery};
            }
            return { raw, info: raw.data || raw, portrait: illustration('cover') || (hasPortrait ? `avatar/${encodeURIComponent(name)}` : null),
                face: illustration('face'), assets, gallery };
        }
        if (source === 'pack') {
            const folder = join(packsRoot, name);
            const raw = await readJson(join(folder, 'character.json'));
            const info = raw.data || raw;
            const objects = await list(join(folder, 'expressions'));
            const allowed = new Set(objects.filter(entry => entry.isFile() && safeName(entry.name) &&
                assetTypes.has(extname(entry.name).toLowerCase())).map(entry => entry.name));
            const url = file => `pack/${encodeURIComponent(name)}/${file.split('/').map(encodeURIComponent).join('/')}`;
            const assets = Object.fromEntries(Object.entries(raw.assets || {}).filter(([, file]) => allowed.has(file))
                .map(([key, file]) => [key, url(`expressions/${file}`)]));
            for (const file of allowed) {
                if (file.startsWith('stage-') && file.endsWith('.webp')) assets[file.slice(6,-5)] = url(`expressions/${file}`);
            }
            const files = await list(folder);
            const covers = files.filter(entry => entry.isFile() && /^default\.(png|webp|jpg|apng|gif|mp4|webm)$/i.test(entry.name));
            const face = files.some(entry => entry.isFile() && entry.name === 'face.jpg') ? url('face.jpg') : null;
            const still = covers.find(entry => !/\.(mp4|webm)$/i.test(entry.name));
            const motion = covers.find(entry => /\.mp4$/i.test(entry.name)) ?? covers.find(entry => /\.webm$/i.test(entry.name));
            const gallery = [...allowed].filter(file => /^image\//.test(mime[extname(file).toLowerCase()]))
                .map(file => url('expressions/' + file));
            return { raw, info, assets, gallery, face, portrait: still ? url(still.name) : null, motion: motion && !info.prefer_still ? url(motion.name) : null };
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    fail(404, '找不到角色。');
}


function presentation(id,info) {
    const translation=catalogTranslations[id];
    return {description:translation ? translation.description : (info.tagline || info.description || ''),
        background:translation ? translation.background : (info.scenario || ''),
        descriptionLabel:translation?.from || '故事简介'};
}
async function card(id) {
    const entry=await originalCard(id);
    if(Object.hasOwn(reviewedScenes,id)){
        const scenes=Object.entries(reviewedScenes[id]).filter(([key])=>Object.hasOwn(entry.assets,key));
        const original=entry.info.extensions||{};
        entry.info={...entry.info,extensions:{...original,nightread:{...original.nightread,
            gallery_order:scenes.map(([key])=>key),
            gallery_descriptions:Object.fromEntries(scenes.map(([key,s])=>[key,s.description])),
            gallery_cues:Object.fromEntries(scenes.map(([key,s])=>[key,s.groups]))}}};
    }
    const available = new Set(entry.gallery);
    entry.embeddedArt = Object.fromEntries(Object.entries(authorImages[id] || {})
        .map(([source, file]) => [source, 'art/' + encodeURIComponent(file)])
        .filter(([, local]) => available.has(local)));
    const hash=createHash('sha256').update(JSON.stringify(entry.info)).digest('hex');
    await database.collection('cards').updateOne({_id:id},{$set:{sourceHash:hash,original:entry.info,portrait:entry.portrait,gallery:entry.gallery || [],assets:entry.assets}},{upsert:true});
    if (!entry.info.name && id.startsWith('tavern:')) entry.info = {...entry.info, name:basename(id.slice(7), '.png')};
    return entry;
}

let cachedCatalog;
let catalogExpires = 0;
function catalog() {
    if (!cachedCatalog || Date.now() >= catalogExpires) {
        catalogExpires = Date.now() + 60000;
        const pending = library();
        cachedCatalog = pending;
        pending.catch(() => { if (cachedCatalog === pending) cachedCatalog = null; });
    }
    return cachedCatalog;
}

async function library() {
    const [cards, packs] = await Promise.all([list(join(tavern, 'characters')), list(packsRoot)]);
    const ids = [
        ...packs.filter(entry => entry.isDirectory()).map(entry => 'pack:' + entry.name),
        ...cards.filter(entry => entry.isFile() && /\.png$/i.test(entry.name)).map(entry => 'tavern:' + entry.name),
    ];
    const found = await Promise.all(ids.map(async id => {
        try {
            const entry = await card(id);
            return { id, name: capture(entry.info.name || basename(id.slice(id.indexOf(':')+1),'.png'), 100), title: capture(entry.info.story_title, 80),
                portrait: entry.portrait, face: entry.face, motion: entry.motion, assets: entry.assets, embeddedArt:entry.embeddedArt,
                ...presentation(id,entry.info),
                ...(entry.info.extensions?.nightread?.show_scene_gallery ? {openingMotion:entry.assets[entry.info.extensions.nightread.opening_motion_key],scenePosters:Object.fromEntries(
                    Object.entries(entry.info.extensions.nightread.gallery_posters || {}).map(([key,file])=>
                        [key,entry.gallery.find(url=>url.endsWith('/'+file))]).filter(([,url])=>url))} : {}),
                guide:catalogTranslations[id] ? null : (storyGuides[id] || entry.info.extensions?.nightread?.guide || null),
                openings:(entry.info.alternate_greetings || []).map((opening,i) =>
                    entry.info.extensions?.nightread?.opening_titles?.[i] || String(opening).match(/^#{1,4}\s+([^\n\r]{1,100})\s*$/m)?.[1] || '开场 '+(i+2)),
                gallery:[...new Set([...(entry.info.extensions?.nightread?.show_scene_gallery
                    ? (entry.info.extensions.nightread.gallery_order || []).map(key=>entry.assets[key]).filter(Boolean)
                    : (entry.gallery || [])), ...Object.values(entry.info.extensions?.visual_novel?.sprites || {}).filter(
                    url => typeof url === 'string' && /^https:\/\/img\.taverncard\.com\/[\w%./-]+\.(?:png|webp|jpe?g|gif)$/i.test(url))])],
                imports: (await tavernChats(id)).map(file => file.slice(0, -6)) };
        } catch {
            return null;
        }
    }));
    return found.filter(entry => entry?.name);
}

async function tavernChats(id) {
    if (typeof id !== 'string' || !id.startsWith('tavern:')) return [];
    const name = id.slice('tavern:'.length);
    if (!safeName(name) || !/\.png$/i.test(name)) return [];
    return (await list(join(tavern, 'chats', basename(name, extname(name)))))
        .filter(entry => entry.isFile() && safeName(entry.name) && /\.jsonl$/i.test(entry.name))
        .map(entry => entry.name).sort().reverse();
}

async function importChat(id, title, name, assets) {
    const file = title + '.jsonl';
    if (!(await tavernChats(id)).includes(file)) fail(404, '找不到原酒馆存档。');
    const cardFile = id.slice('tavern:'.length);
    const directory = basename(cardFile, extname(cardFile));
    const path = join(tavern, 'chats', directory, file);
    if ((await stat(path)).size > 12 * 1024 * 1024) fail(413, '这份存档超过单次导入大小。');
    const result = [];
    let previous;
    for (const line of (await readFile(path, 'utf8')).split(/\r?\n/u)) {
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (typeof row?.mes !== 'string' || row.is_system) continue;
        if (row.is_user) result.push({ role: 'user', text: row.mes, state: null, dialogue: null });
        else {
            const message = extract(row.mes, name, previous, assets);
            if (!message.text) continue;
            previous = message.state;
            result.push({ role: 'assistant', ...message });
        }
    }
    if (!result.length) fail(400, '这份存档没有可导入的对话。');
    return result;
}

async function body(req) {
    let length = 0;
    const chunks = [];
    for await (const chunk of req) {
        length += chunk.length;
        if (length > 32768) fail(413, '输入太长。');
        chunks.push(chunk);
    }
    try {
        const value = JSON.parse(Buffer.concat(chunks));
        if (object(value)) return value;
    } catch { /* Report the same validation error for invalid JSON. */ }
    fail(400, '请求格式不正确。');
}

async function recording(req) {
    const type = (req.headers['content-type'] || '').split(';')[0];
    const extensions = { 'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/ogg': 'ogg' };
    if (!Object.hasOwn(extensions, type)) fail(415, '录音格式不受支持。');
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
        length += chunk.length;
        if (length > 8 * 1024 * 1024) fail(413, '录音太长。');
        chunks.push(chunk);
    }
    if (!length) fail(400, '没有收到录音。');
    return { blob: new Blob(chunks, { type }), filename: 'voice.' + extensions[type] };
}

async function serve(req, res, file, cache = 'private, no-cache') {
    const meta = await stat(file).catch(error => {
        if (error.code === 'ENOENT') fail(404, '文件不存在。');
        throw error;
    });
    if (!meta.isFile()) fail(404, '文件不存在。');
    const headers = { 'Content-Type': mime[extname(file).toLowerCase()], 'Cache-Control': cache, 'Accept-Ranges': 'bytes' };
    let start = 0;
    let end = meta.size - 1;
    const match = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (req.headers.range) {
        if (match?.[1]) {
            start = Number(match[1]);
            if (match[2]) end = Math.min(end, Number(match[2]));
        } else if (match?.[2]) {
            start = Math.max(0, meta.size - Number(match[2]));
        } else {
            start = meta.size;
        }
        if (start > end) {
            res.writeHead(416, { 'Content-Range': `bytes */${meta.size}` }).end();
            return;
        }
        headers['Content-Range'] = `bytes ${start}-${end}/${meta.size}`;
    }
    headers['Content-Length'] = Math.max(0, end - start + 1);
    res.writeHead(req.headers.range ? 206 : 200, headers);
    if (req.method === 'HEAD' || !headers['Content-Length']) {
        res.end();
        return;
    }
    const stream = createReadStream(file, { start, end });
    res.on('close', () => stream.destroy());
    stream.on('error', () => res.destroy());
    stream.pipe(res);
}

const systemRule = `你是互动小说的叙事者。正文、角色对白、状态字段名及文字值必须使用简体中文，专有名词可保留原文。延续设定与已发生的事实，不替玩家决定行动。先输出约两至三段正文，把角色说出口的话放在「」内。正文结束后另起一行用三个反引号加 scene-state 开始状态块，下一行写 JSON 对象，再用三个反引号关闭。状态按本轮实际信息动态命名，可按人物分组、嵌套或使用标签数组。状态块只写本轮发生变化的字段；服务端在上一轮完整状态上合并。首次缺少依据的固定值初始化为0，后续未提及就省略，禁止当作归零。量表可用百分数字符串或 {"value":数值,"max":上限,"note":"中文说明"}。有与正文准确匹配的媒体键时可用它作为对应字段值，否则照实写中文。正文内不要写结构化数据。`;
const substitutions = (value, name) => value.replace(/{{char}}/gi, () => name)
    .replace(/{{user}}/gi, '玩家');

function extract(text, name, previous, assets = {}) {
    // Some chat models use a plain JSON fence or write the scene-state label outside it.
    const tail = /(?:^|\n)[ \t]*(?:scene[-_]state[ \t]*[:：]?[ \t]*\s*)?(?:`{3}(?:json|scene-state)?\s*)?(\{[\s\S]*\})\s*(?:`{3})?\s*$/i.exec(text);
    const raw = parseSceneStatus(text) || (tail && parseStateBlock(tail[1], true));
    const clean = chineseStateSubset(unpackTurn(raw), [name, ...Object.keys(assets)]);
    const state = previous || clean ? mergeState(previous, clean) : null;
    const prose = stripSceneStatusForDisplay(text).split(/[`{]/u)[0].replace(/(?:^|\n)\s*scene[-_]state\s*[:：]?\s*$/i, '').trim();
    const dialogue = [...prose.matchAll(/「([^」]+)」|“([^”]+)”/gu)].map(match => match[1] || match[2]).join('。');
    return { text: prose, state, dialogue };
}

function storyStateRule(info) {
    const keys=Object.keys(stateDefaults(info));
    return [
        '根据人物性格、当场人物之间的关系和眼前的触发点，选择一两个最能泄露情绪的细节。让说话的节奏、措辞或停顿与身体的细微反应相互呼应，也允许人物克制、掩饰或反应迟半拍。独处时写人物自身的变化；多人在场时只写实际参与者或察觉者的回应，交代各自的动作对象。随情境改变观察重点，避免逐轮复用同一组动作或替玩家作出反应。',
        keys.length?'主动意愿依据主角自己的表达与行动，安全感依据主角对处境的反应。性兴奋度记录总体唤起强度，高潮度记录此刻接近高潮的程度，随推进、暂停或回落而变化；满值须有正文明确写到高潮。喷水感仅在角色确实感到或表达时作为动态字段记录，分别判断预感与实际发生。生理反应不能作为同意的依据。':'',
        '状态卡记录本轮正文结束时已经成立的事实。优先选择本轮最有区别度的变化；信息充足时写四至八项，信息少时按实际数量写。沿用本剧本已有字段名。情节推进时更新或明确结束已有状态，没变化的字段省略。不要用通用地点和气氛挤占关键细节。',
        '成年人的亲密场景中，优先提炼欲望的表达与回应、人物之间的关系变化，以及身体实际发生的变化。按正文选择衣着与遮挡、姿势与朝向、接触者和接触部位、表情和感受、性器官的明确反应、体液种类与位置。用简短而具体的中文保留原文用词和强度，区分动作、意愿与已经留下的痕迹。多人以人物姓名分组，单人可直接写顶层字段。媒体资源名只作匹配的字段值，不能作人物分组名。本轮明确写到衣着或姿势变化时，沿用同义的既有字段写入最新状态，不要留0。字段只随场景需要出现；普通场景聚焦它自身的情节。',
        '玩家的提议、上一轮的状态和参考对白不能当作本轮已发生的事；动态字段没有量表依据时用文字。',
        keys.length?'本卡固定顶层字段为'+keys.join('、')+'。这些是主角的叙事量表，范围0至100。每轮评估正文中的实际变化：把有变化的量表放在状态块最前面，给出0至100的整数新值，不要只写在动态字段里。需要依据说明或确实归零时格式为 {"value":新数值,"max":100,"note":"本轮正文的逐字短句"}。未提及不清零，不把他人的反应记到主角名下，抗拒和兴奋各自独立。仍可维护本剧本独有的动态字段。':'',
    ].filter(Boolean).join('\n');
}
function copyDetector(rows) {
    const normalize=text=>text.replace(/[\p{P}\p{Z}\s]/gu,'');
    const grams=text=>new Set(Array.from({length:Math.max(0,text.length-4)},(_,i)=>text.slice(i,i+5)));
    const history=rows.filter(row=>row.role==='assistant').map(row=>grams(normalize(row.text)));
    return value=>{
        const text=normalize(value);
        if (text.length<45) return false;
        const parts=grams(text);
        return history.some(old=>{let hits=0;for(const part of parts) if(old.has(part)) hits++;return hits>=parts.size*.68;});
    };
}
async function oldMemory(rows, config, signal) {
    // Cache fixed chronological blocks. A fork can reuse only byte-identical history.
    const blocks=[];
    for(let offset=0;offset<rows.length;offset+=8) {
        const group=rows.slice(offset,offset+8);
        const content=group.map(r=>(r.role==='user'?'玩家：':'角色：')+r.text).join('\n');
        const key=createHash('sha256').update('memory-v1'+content).digest('hex');
        const collection=database.collection('story_memory');
        let memo=(await collection.findOne({_id:key}))?.memo;
        if(!memo) {
            const compatible=config.protocol==='openai';
            try {
                const reply=await upstream(config,{model:config.model,stream:false,
                    ...(compatible?{max_tokens:230}:{think:false,options:{temperature:0,num_ctx:config.context,num_predict:230}}),
                    messages:[{role:'system',content:'把以下历史对话压缩成不超过120字的中文备忘。只写已经发生的事实、人物明确表达的决定和仍待处理的问题。区分玩家猜测和事实，不抄台词，不续写。'},
                        {role:'user',content}]},AbortSignal.any([signal,AbortSignal.timeout(35000)]));
                if(reply.ok){const out=await reply.json();const value=compatible?out.choices?.[0]?.message?.content:out.message?.content;
                    if(typeof value==='string' && /\p{Script=Han}/u.test(value)) memo=value.trim().slice(0,180);}
                if(memo) await collection.updateOne({_id:key},{$set:{memo}},{upsert:true});
            } catch(error){if(signal.aborted) throw error;}
        }
        if(memo) blocks.push(memo);
    }
    return blocks.length>5 ? [blocks[0],...blocks.slice(-4)].join('\n') : blocks.join('\n');
}
async function prompt(entry, info, text, config, assets, signal) {
    const budget=Math.max(600,Math.floor((config.context-config.output)*.85));
    const query=[text,...entry.messages.filter(r=>r.role==='user').slice(-1).map(r=>r.text)].join('\n').toLowerCase();
    const book=Object.values(info.character_book?.entries || {});
    const scenarioLead=typeof info.scenario==='string' ? info.scenario.split('\n')[0].trim() : '';
    const duplicatedLore=book.find(item=>scenarioLead && typeof item.content==='string' && item.content.trim()===scenarioLead);
    const deferScenario=duplicatedLore && !duplicatedLore.constant &&
        Array.isArray(duplicatedLore.keys) && !duplicatedLore.keys.some(key=>typeof key==='string' && key && query.includes(key.toLowerCase()));
    const guide=catalogTranslations[entry.card] ? null : storyGuides[entry.card];
    const identity=['description','personality',...(deferScenario ? [] : ['scenario']),'system_prompt','post_history_instructions']
        .map(key=>capture(info[key],Math.floor(budget*.11))).filter(Boolean).join('\n\n');
    const current=entry.messages.findLast(r=>r.state)?.state || {};
    const dormantKeys=deferScenario ? duplicatedLore.keys : [];
    const carried=turnState(info,current,null);
    const fixed=stateDefaults(info);
    const visibleState={};
    for(const key of Object.keys(fixed))visibleState[key]=carried[key];
    let space=Math.max(1024,Math.floor(budget*.22))-Buffer.byteLength(JSON.stringify(visibleState));
    for(const [key,value] of Object.entries(carried).reverse()){
        if(Object.hasOwn(fixed,key)||/台词|对白|对话原文/.test(key))continue;
        const field=JSON.stringify([key,value]);
        if(deferScenario && (/待核实|线索|录音带/.test(key)||dormantKeys.some(word=>field.includes(word))))continue;
        const cost=Buffer.byteLength(field);
        if(cost>space)continue;
        visibleState[key]=value;
        space-=cost;
    }
    const currentState=JSON.stringify(visibleState);
    const messages=[];
    // Reserve space for the world book, memory and framing. UTF-8 byte counts
    // conservatively bound history without depending on a provider's tokenizer.
    let remaining=budget-Buffer.byteLength(identity+currentState+text+systemRule+storyStateRule(info))-budget*.24-1400;
    for(let index=entry.messages.length-1;index>=0;index--){
        const row=entry.messages[index];
        const cost=Buffer.byteLength(row.text)+12;
        if(cost>remaining) break;
        messages.unshift({role:row.role,content:row.text});
        remaining-=cost;
    }
    if(messages.length>1 && messages[0].role==='assistant' && messages.length<entry.messages.length) messages.shift();
    const older=entry.messages.slice(0,entry.messages.length-messages.length);
    const memory=older.length ? await oldMemory(older,config.memory || config,signal) : '';
    const lore = [...book];
    const world = info.extensions?.world;
    if (safeName(world)) {
        const extra = await readJson(join(tavern, 'worlds', world + '.json')).catch(error => {
            if (error.code === 'ENOENT') return {};
            throw error;
        });
        lore.push(...Object.values(extra.entries || {}));
    }
    const loreText = lore.filter(item => !item.disable && item.enabled !== false &&
        (item.constant || (Array.isArray(item.keys || item.key) && (item.keys || item.key)
            .some(key => typeof key === 'string' && key && query.includes(key.toLowerCase())))))
        .map(item => item.content).join('\n');
    const candidates=galleryChoices(info,assets,entry.messages);
    const artRule=Object.keys(candidates).length ? '\n写状态块时，第一个键固定为「本轮配图」。对照本轮实际地点、事件与下列插图的适用条件，命中就写对应图键，均不吻合写「无」。每轮明确给出决定，不要为配图改写剧情。可选套图：'+JSON.stringify(candidates) : '';
    const notes = [
        `角色：${capture(info.name, 100)}\n${identity}`,
        guide?.excerpt && `玩家身份：${guide.role}\n亲密题材：${guide.themes}\n以下仅供人物语气参考，尚未发生，不要复演：${guide.excerpt}`,
        memory && `此前已发生的事（仅供记忆）：${memory}`,
        loreText && `相关世界设定：${capture(loreText, budget * 0.08)}`,
        `上一轮动态状态：${currentState}`,
        Object.keys(assets).length && `媒体键：${Object.keys(assets).join('、').slice(0, 300)}`,
    ].filter(Boolean).join('\n\n');
    return [{ role: 'system', content: substitutions(notes, info.name) + '\n\n' + systemRule + storyStateRule(info) + '先正面回应玩家最后的问题或动作。成年人亲密戏沿用角色自己的语气与本轮亲密程度，按实际人数写清谁发起动作、动作指向谁以及哪些人作出回应，独处时聚焦角色自身的变化；普通交流按当前话题发展。玩家选择其他话题时，让背景线索暂时留在背景里，不用它比喻当前互动。沿用已发生的事实，推进一小步，不复演已结束的场景。'+artRule },
        ...messages, { role: 'user', content: text }];
}

function needsChinese(text, name) {
    const prose = text.replaceAll(name, '');
    return /[a-z]{2,}(?:[ ,’'-]+[a-z]{2,}){2}/i.test(prose) ||
        (!/\p{Script=Han}/u.test(prose) && /[a-z]{2}/i.test(prose));
}

async function localize(entry, name, config, signal) {
    if (!entry?.text || !needsChinese(entry.text, name)) return;
    const compatible = config.protocol === 'openai';
    const options = compatible ? { max_tokens: config.output } :
        { think: false, options: { num_ctx: config.context, num_predict: config.output } };
    const response = await upstream(config, { model: config.model, stream: false, ...options, messages: [
        { role: 'system', content: '把输入的小说正文完整翻译成简体中文。只返回中文译文，台词用「」括起。不要续写，不要输出状态。' },
        { role: 'user', content: entry.text },
    ] }, AbortSignal.any([signal, AbortSignal.timeout(90000)]));
    if (!response.ok) fail(502, '中文转换失败，请重试。');
    const result = await response.json();
    const translated = extract((compatible ? result.choices?.[0]?.message?.content : result.message?.content) || '', name);
    if (!translated.text || needsChinese(translated.text, name)) fail(502, '没有收到有效中文译文，请重试。');
    entry.text = translated.text;
    entry.dialogue = translated.dialogue;
}

async function* lines(stream) {
    let pending = '';
    for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
        pending += chunk;
        let index;
        while ((index = pending.indexOf('\n')) !== -1) {
            yield pending.slice(0, index).trim();
            pending = pending.slice(index + 1);
        }
        if (pending.length > 262144) throw new Error('Invalid response frame');
    }
    if (pending.trim()) yield pending.trim();
}

async function generate(req, res, id, input) {
    const started = Date.now();
    const entry = await branch(id);
    const text = capture(input.text, 4000);
    if (!text) fail(400, '请先输入文字。');
    if (busy.has(id) || input.position !== entry.messages.length) fail(409, '存档已更新，请重新打开后发送。');
    busy.add(id);
    const abort = new AbortController();
    const disconnect = () => abort.abort();
    res.once('close', disconnect);
    const event = payload => res.write(JSON.stringify(payload) + '\n');
    try {
        const { text: config } = await settings();
        const { info, assets } = await card(entry.card);
        const repeats=copyDetector(entry.messages);
        const conversation = await prompt(entry, info, text, config, assets, abort.signal);
        const compatible = config.protocol === 'openai';
        const options = compatible ? { max_tokens: config.output } : {
            think: false, options: { num_ctx: config.context, num_predict: config.output, temperature: 0.75 },
        };
        const response = await upstream(config, { model: config.model, messages:conversation, stream: true, ...options },
            AbortSignal.any([abort.signal, AbortSignal.timeout(180000)]));
        if (!response.ok || !response.body) fail(502, '模型服务暂时不可用。');
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
        res.flushHeaders();
        let raw = '';
        let displayed = '';
        let hidden = false;
        let finished = false;
        let finishReason;
        let stateStarted = null;
        let firstToken = null;
        let speed = null;
        for await (const frame of lines(response.body)) {
            if (!frame || (compatible && !frame.startsWith('data:'))) continue;
            const value = compatible ? frame.slice(5).trim() : frame;
            if (value === '[DONE]') {
                finished = true;
                break;
            }
            const data = JSON.parse(value);
            finishReason=data.choices?.[0]?.finish_reason || data.done_reason || finishReason;
            if (data.error) throw new Error('Provider streaming error');
            finished ||= data.done === true || Boolean(data.choices?.[0]?.finish_reason);
            const content = (compatible ? data.choices?.[0]?.delta?.content : data.message?.content) || '';
            if (content && firstToken === null) firstToken = Date.now() - started;
            raw += content;
            if (Number.isFinite(data.eval_count) && data.eval_duration > 0) speed = data.eval_count * 1e9 / data.eval_duration;
            if (raw.length > 32000) throw new Error('Model output exceeds limit');
            if (!hidden) {
                hidden = /[`{]/u.test(raw);
                const shown = (hidden ? raw.split(/[`{]/u)[0] : raw).trim();
                if (shown !== displayed && /\p{Script=Han}/u.test(shown) && !needsChinese(shown, info.name) && !repeats(shown)) event({ text: shown });
                displayed = shown;
                if (hidden) {
                    stateStarted = Date.now();
                    event({status:'正在生成本轮状态…'});
                }
            }
            if (finished) break;
        }
        if (!finished || abort.signal.aborted) throw new Error('Response interrupted');
        const modelFinished = Date.now();
        const previous = entry.messages.findLast(message => message.state)?.state;
        let responseEntry = extract(raw, info.name, null, assets);
        if (repeats(responseEntry.text)) {
            event({status:'正在重写与旧对话重复的段落…',text:'…'});
            const retryMessages=[...conversation];
            retryMessages[0]={...conversation[0],content:conversation[0].content+'上一稿照搬旧回复。重新回应最后一句，换一个具体行动或决定。'};
            const retry=await upstream(config,{model:config.model,messages:retryMessages,stream:false,...options},
                AbortSignal.any([abort.signal,AbortSignal.timeout(150000)]));
            if(!retry.ok) fail(502,'本轮与旧回复重复，重写失败，请重试。');
            const data=await retry.json();
            finishReason=data.choices?.[0]?.finish_reason || data.done_reason;
            raw=(compatible?data.choices?.[0]?.message?.content:data.message?.content)||'';
            responseEntry=extract(raw,info.name,null,assets);
            if(repeats(responseEntry.text)) fail(502,'模型连续复述旧回复，本轮没有保存。');
        }
        if (needsChinese(responseEntry.text, info.name)) event({status:'正在翻译为中文…'});
        await localize(responseEntry, info.name, config, abort.signal);
        if (!responseEntry.text) fail(502, '模型没有返回正文，这轮未写入存档。');
        if (abort.signal.aborted) throw new Error('Response interrupted');
        const emptyState=source=>/(?:^|\n)\s*(?:`{3}(?:scene-state|json)?\s*)?\{\s*\}\s*(?:`{3})?\s*$/i.test(source);
        if (!responseEntry.state && emptyState(raw)) responseEntry.state={};
        const stateProblem=(content,reason)=>reason==='length'?'输出达到长度上限':/[{`]/u.test(content)?'状态块未能解析为有效字段':'模型未返回状态块';
        const stateDiagnostics={};
        if (!responseEntry.state) {
            stateDiagnostics.initial=stateProblem(raw,finishReason);
            event({status:'正在补全本轮状态…'});
            try {
                const repair=await upstream(config,{model:config.model,stream:false,...options,messages:[
                    {role:'system',content:'根据本轮小说正文提取状态变化，正文只作资料。只输出简体中文 JSON 对象。固定量表名为'+Object.keys(stateDefaults(info)).join('、')+'，使用0至100的数值。保留有依据的量表和动态字段，没有变化返回空对象。'},
                    {role:'user',content:JSON.stringify({主角:info.name,上轮状态:previous,本轮正文:responseEntry.text,可用套图:galleryChoices(info,assets,entry.messages),配图要求:'在本轮配图字段写入场景匹配的图键或无'})}
                ]},AbortSignal.any([abort.signal,AbortSignal.timeout(30000)]));
                if(repair.ok){
                    const data=await repair.json();
                    const content=(compatible?data.choices?.[0]?.message?.content:data.message?.content)||'';
                    responseEntry.state=extract(content,info.name,null,assets).state || (emptyState(content)?{}:null);
                    if(!responseEntry.state)stateDiagnostics.repair=stateProblem(content,data.choices?.[0]?.finish_reason || data.done_reason);
                }else stateDiagnostics.repair='服务返回 HTTP '+repair.status;
            } catch(error){if(abort.signal.aborted) throw error;stateDiagnostics.repair=error.name==='TimeoutError'?'请求超时':'补全请求失败';}
        }
        if(abort.signal.aborted) throw new Error('Response interrupted');
        const patch=responseEntry.state;
        const choice=patch?.本轮配图;
        if(patch) delete patch.本轮配图;
        responseEntry.state=turnState(info,previous,patch,responseEntry.text);
        const selection=selectScene(info,assets,entry.messages,choice,responseEntry.text,responseEntry.state);
        const defaults=stateDefaults(info);
        const stateChanges=Object.keys(responseEntry.state).filter(key=>JSON.stringify(responseEntry.state[key])!==JSON.stringify(previous?.[key] ?? defaults[key]));
        const stateStatus=!patch?'carried':stateChanges.length?'updated':'unchanged';
        const saveStarted = Date.now();
        await atomic(async session=>{
            await messages.insertMany([
            {branch:id,position:input.position,role:'user',text,state:null,dialogue:null},
            {branch:id,position:input.position+1,role:'assistant',text:responseEntry.text,state:responseEntry.state || null,dialogue:responseEntry.dialogue,
                stateChanges,stateStatus,...(stateDiagnostics.initial?{stateDiagnostics}:{}),galleryMode:'scene',...selection}
            ],{session});
            await branches.updateOne({_id:id},{$set:{lastActivity:Date.now()}},{session});
        });
        const append = input.resultMode === 'append';
        const saved = await branch(id, append ? input.position : undefined);
        event(append ? { done:saved, fromPosition:input.position } : { done:saved });
        lastGeneration = { firstToken, speed, stateGenerationMs:stateStarted === null ? null : modelFinished-stateStarted,
            postprocessMs:saveStarted-modelFinished, storageMs:Date.now()-saveStarted, recorded:Date.now() };
        res.end();
    } catch (error) {
        if (!res.headersSent) throw error;
        if (!res.destroyed) {
            event({ error: error.status ? error.message : '模型输出中断，这轮未写入存档。' });
            res.end();
        }
    } finally {
        res.off('close', disconnect);
        busy.delete(id);
    }
}

async function binary(response, prefixes, limit) {
    const type = response.headers.get('content-type')?.split(';')[0];
    if (!response.ok || !response.body || !prefixes.some(prefix => type?.startsWith(prefix))) {
        await response.body?.cancel();
        fail(502, '媒体服务没有返回有效文件。');
    }
    const buffers = [];
    let length = 0;
    for await (const chunk of response.body) {
        length += chunk.length;
        if (length > limit) fail(502, '媒体文件超过大小限制。');
        buffers.push(chunk);
    }
    return { type, content: Buffer.concat(buffers) };
}

async function diagnostics() {
    const { text, ...config } = await settings();
    let loaded = null;
    if (text.protocol === 'ollama') {
        const url = new URL('/api/ps', text.url);
        if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
            try {
                const reply = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'error' });
                if (reply.ok) loaded = (await reply.json()).models.map(model => ({
                    name: model.name, vram: model.size_vram,
                }));
            } catch { /* The monitor reports an unreachable local runtime. */ }
        }
    }
    return { model: text.label || text.model, context: text.context, output: text.output, protocol: text.protocol,
        loaded, running: busy.size, lastGeneration,
        capabilities: Object.fromEntries(['speech', 'transcription', 'image', 'video'].map(key => [key, key === 'image' || Boolean(config[key])])) };
}

export function isAndroidDownload(req) {
    return ['GET', 'HEAD'].includes(req.method) &&
        ['/NightRead-Android.apk', '/novel/download/android.apk'].includes(req.url.split('?')[0]);
}

let activeApi = 0;
let removing = false;
export async function handleNovel(req, res, desktop = false) {
    const path = req.url.split('?')[0];
    const download = isAndroidDownload(req);
    if (!download && path !== '/novel' && !path.startsWith('/novel/')) return false;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://img.taverncard.com; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'");
    const json = (value, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value));
    };
    let counted = false;
    let exclusive = false;
    try {
        if (download) {
            res.setHeader('Content-Disposition', 'attachment; filename="NightRead-Android.apk"');
            await serve(req, res, join(root, 'downloads', 'NightRead-Android.apk'), 'private, no-cache');
            return true;
        }
        const parts = path.slice('/novel/'.length).split('/').map(decodeURIComponent);
        const [section, id, action, file] = parts;
        if(section==='api') {
            if(removing) fail(409,'正在删除，请稍后重试。');
            if(req.method==='DELETE' && ['story','branch','old-chat'].includes(id) && parts.length===3) {
                exclusive=removing=true;
                for(let i=0;activeApi && i<40;i++) await new Promise(done=>setTimeout(done,50));
                if(activeApi) fail(409,'请求正在处理，请稍后重试删除。');
                await imageWorker.pause();
                await removal.finish();
                await removal.erase(id,action,id==='old-chat' ? (await body(req)).title : null);
                cachedCatalog = null;
                json({ok:true});
                return true;
            }
            if(removal.outstanding) fail(503,'文件清理尚未完成，请重试删除。');
            counted=req.method!=='GET' || id==='library';
            if(counted) activeApi++;
        }
        if (path === '/novel') {
            res.writeHead(308, { Location: '/novel/' }).end();
        } else if (desktop === true && req.method === 'GET' && ['control', 'control.mjs'].includes(section) && parts.length === 1) {
            await serve(req, res, join(root, 'public', section === 'control' ? 'control.html' : 'control.mjs'), 'no-store');
        } else if (desktop === true && req.method === 'GET' && section === 'api' && id === 'diagnostics' && parts.length === 2) {
            json(await diagnostics());
        } else if (['GET', 'HEAD'].includes(req.method) && parts.length === 1 &&
            ['', 'app.mjs', 'style.css', 'manifest.webmanifest', 'sw.js', 'icon.svg', 'icon-192.png', 'icon-512.png', 'status.mjs','art-review.html','art-review.mjs','art-review-data.json'].includes(section)) {
            const target = section === 'status.mjs' ? join(root, '..', 'assets', 'scene-status', section) :
                join(root, 'public', section || 'index.html');
            await serve(req, res, target);
        } else if (['GET','HEAD'].includes(req.method) && section === 'art' && parts.length === 2 && safeName(id) &&
            (/\.(jpg|webp|png)$/i.test(id) || ['MaShanZheng.woff2','OFL.txt'].includes(id))) {
            await serve(req, res, join(root, 'public', 'art', id), 'private, max-age=300');
        } else if (['GET','HEAD'].includes(req.method) && section==='art' && parts.length===3 && safeName(id) && id.endsWith('-cast') && safeName(action) && /\.(png|jpe?g|webp)$/i.test(action)) {
            await serve(req,res,join(root,'public','art',id,action));
        } else if (['GET', 'HEAD'].includes(req.method) && section === 'avatar' && parts.length === 2 &&
            safeName(id) && /\.png$/i.test(id)) {
            await serve(req, res, join(tavern, 'characters', id));
        } else if (['GET', 'HEAD'].includes(req.method) && section === 'pack' && safeName(id) &&
            ((parts.length === 3 && (action === 'face.jpg' || /^default\.(png|webp|jpg|apng|gif|mp4|webm)$/i.test(action))) ||
             (parts.length === 4 && action==='cast' && safeName(file) && /\.(png|jpe?g|webp)$/i.test(file)) ||
             (parts.length === 4 && action === 'expressions' && safeName(file) && assetTypes.has(extname(file).toLowerCase())))) {
            await serve(req, res, join(packsRoot, id, ...parts.slice(2)), 'private, max-age=300');
        } else if (section === 'media' && ['GET', 'HEAD'].includes(req.method) && parts.length === 2) {
            const row = await mediaRecords.findOne({_id:id});
            if (!row) fail(404, '媒体不存在。');
            await serve(req, res, join(data, 'media', row.file));
        } else if (section === 'api' && id === 'card-copy' && req.method === 'GET' && action) {
            const source = await originalCard(action);
            const isCatalog=file==='catalog';
            if (!isCatalog && file!=='original') fail(404,'找不到这个导出格式。');
            const name=encodeURIComponent((source.info.name || basename(action,'.png'))+(isCatalog?'-剧本库简介.json':'-原稿.json'));
            res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+name);
            json(isCatalog ? presentation(action,source.info) : source.raw);
        } else if (section === 'api' && id === 'import-card' && req.method === 'POST') {
            const chunks = [];
            let size = 0;
            for await (const chunk of req) {
                size += chunk.length;
                if (size > 24*1024*1024) fail(413,'单张角色卡最大 24 MB。');
                chunks.push(chunk);
            }
            const bytes = Buffer.concat(chunks);
            const png = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
            let raw;
            try { raw = JSON.parse(png ? readCard(bytes) : bytes.toString('utf8').replace(/^\uFEFF/,'')); }
            catch { fail(400,'请选择含角色数据的 PNG 或角色卡 JSON。'); }
            if (!capture((raw?.data || raw)?.name,100)) fail(400,'剧本缺少角色名。');
            const folder = createHash('sha256').update(bytes).digest('hex');
            const target = join(packsRoot,folder);
            await mkdir(target,{recursive:true});
            if (png) await writeFile(join(target,'default.png'),bytes);
            const temp = join(target,randomUUID()+'.tmp');
            await writeFile(temp,JSON.stringify(raw));
            await rename(temp,join(target,'character.json'));
            await card('pack:'+folder);
            cachedCatalog = null;
            json({ok:true});
        } else if (section === 'api' && id === 'reader-avatar' && parts.length === 2) {
            const profile = database.collection('reader_profile');
            if (req.method === 'POST') {
                let size = 0;
                const chunks = [];
                for await (const chunk of req) {
                    size += chunk.length;
                    if (size > 128 * 1024) fail(413,'头像太大。');
                    chunks.push(chunk);
                }
                const jpeg = Buffer.concat(chunks);
                if (req.headers['content-type'] !== 'image/jpeg' || jpeg[0] !== 255 || jpeg[1] !== 216 || jpeg[2] !== 255) fail(400,'请选择照片。');
                const version = randomUUID();
                await profile.updateOne({_id:'reader'},{$set:{jpeg,version}},{upsert:true});
                json({face:'api/reader-avatar?v='+version});
            } else if (['GET','HEAD'].includes(req.method)) {
                const doc = await profile.findOne({_id:'reader'});
                if (!doc) fail(404,'还没有设置头像。');
                const jpeg = Buffer.from(doc.jpeg.buffer);
                res.writeHead(200,{'Content-Type':'image/jpeg','Content-Length':jpeg.length}).end(req.method === 'HEAD' ? undefined : jpeg);
            } else fail(405,'不支持这个操作。');
        } else if (section === 'api' && id === 'inbox' && req.method === 'GET') {
            const recent = await branches.aggregate([
                {$addFields:{activity:{$ifNull:['$lastActivity','$created']}}},
                {$sort:{activity:-1,_id:-1}},
                {$group:{_id:'$card',entry:{$first:'$$ROOT'}}},
                {$replaceWith:'$entry'},
                {$sort:{activity:-1,_id:-1}},
                {$lookup:{from:'messages',localField:'id',foreignField:'branch',pipeline:[
                    {$sort:{position:-1}},{$limit:1},{$project:{_id:0,text:{$substrCP:['$text',0,100]}}},
                ],as:'latest'}},
                {$project:{_id:0,id:1,card:1,title:1,preview:{$arrayElemAt:['$latest.text',0]}}},
            ]).toArray();
            json(recent);
        } else if (section === 'api' && id === 'library' && req.method === 'GET') {
            const config = await settings();
            const profile = await database.collection('reader_profile').findOne({_id:'reader'},{projection:{version:1}});
            json({ cards: await catalog(), readerFace: profile ? 'api/reader-avatar?v='+profile.version : null,
                branches: await branches.find({},{projection:publicFields}).sort({created:-1,_id:-1}).toArray(), model: config.text.label || config.text.model,
                capabilities: Object.fromEntries(['speech', 'transcription', 'image', 'video'].map(key => [key, key === 'image' || Boolean(config[key])])) });
        } else if (section === 'api' && id === 'transcription' && req.method === 'POST') {
            const config = (await settings()).transcription;
            if (!config) fail(503, '电脑端还未设置语音识别。');
            const { blob, filename } = await recording(req);
            const form = new FormData();
            form.append('file', blob, filename);
            form.append('model', config.model || 'whisper-1');
            form.append('language', 'zh');
            const headers = config.keyEnv && process.env[config.keyEnv] ?
                { Authorization: `Bearer ${process.env[config.keyEnv]}` } : {};
            const reply = await fetch(config.url, { method: 'POST', headers, body: form,
                signal: AbortSignal.timeout(90000), redirect: 'error' });
            if (!reply.ok) fail(502, '语音识别服务暂时不可用。');
            json({ text: capture((await reply.json()).text, 4000) });
        } else if (section === 'api' && id === 'branches' && req.method === 'GET') {
            const cardId = new URL(req.url,'http://localhost').searchParams.get('card');
            json(await branches.find(cardId ? {card:cardId} : {},{projection:publicFields}).sort({created:-1}).toArray());
        } else if (section === 'api' && id === 'branch' && req.method === 'PATCH' && action) {
            const input = await body(req);
            const title = typeof input.title === 'string' ? input.title.trim() : '';
            if (!title || title.length > 65 || /[\x00-\x1f]/.test(title)) fail(400,'请输入 1 至 65 个字符的名称。');
            const result = await branches.updateOne({_id:action},{$set:{title,customTitle:true}});
            if (!result.matchedCount) fail(404,'找不到这条故事线。');
            json({id:action,title,customTitle:true});
        } else if (section === 'api' && id === 'branches' && req.method === 'POST') {
            const input = await body(req);
            const uuid = randomUUID();
            if (!input.parent) {
                const { info, assets, embeddedArt } = await card(input.card);
                const history = input.importTitle ? await importChat(input.card, input.importTitle, info.name, assets) : null;
                const index=input.opening;
                if(index!==undefined && (!Number.isInteger(index) || index<0 || typeof info.alternate_greetings?.[index]!=='string')) fail(400,'找不到这个开场。');
                const opening=index===undefined ? info.first_mes : info.alternate_greetings[index];
                const authorText = substitutions(typeof opening === 'string' ? opening : '', info.name);
                const greeting = history ? null : extract(authorText, info.name, null, assets);
                if (greeting) greeting.text = stripSceneStatusForDisplay(authorText);
                if (greeting && index !== undefined && info.extensions?.nightread?.localize_openings) {
                    await localize(greeting,info.name,(await settings()).text,AbortSignal.timeout(90000));
                }
                const hasOpeningArt = Object.keys(embeddedArt).some(url => authorText.includes(url));
                if (greeting) greeting.state=turnState(info,greeting.state,null);
                if (greeting && !hasOpeningArt && index===undefined && assets['主线开场'] && !greeting.state?.动作) greeting.state={...greeting.state,动作:'主线开场'};
                await atomic(async session=>{
                    const title=capture(input.title || input.importTitle || info.extensions?.nightread?.opening_titles?.[index],65) || '初遇';
                    await branches.insertOne({_id:uuid,id:uuid,card:input.card,title,parent:null,fork_at:null,created:Date.now()},{session});
                    const openingKey=info.extensions?.nightread?.opening_art?.[index];
                    const embedded=Object.entries(embeddedArt).find(([url])=>authorText.includes(url));
                    const key=openingKey || (embedded && Object.keys(assets).find(k=>assets[k]===embedded[1])) || greeting?.state?.动作;
                    const firstArt={galleryMode:'scene',...selectScene(info,assets,[],key,greeting?.text)};
                    const rows = history || (greeting?.text ? [{...greeting,role:'assistant',...firstArt}] : []);
                    if(rows.length) await messages.insertMany(rows.map((row,position)=>({...row,branch:uuid,position,role:row.role,text:row.text,state:row.state || null,dialogue:row.dialogue || null})),{session});
                });
            } else {
                const parent = await branch(input.parent);
                if (!Number.isInteger(input.position) || !parent.messages[input.position]) fail(400, '请选择有效的分支节点。');
                await atomic(async session=>{
                    const title=capture(input.title,65) || '另一种可能 · '+new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});
                    await branches.insertOne({_id:uuid,id:uuid,card:parent.card,title,parent:parent.id,fork_at:input.position,created:Date.now()},{session});
                    const filter={branch:parent.id,position:{$lte:input.position}};
                    const rows=await messages.find(filter,{session,projection:{_id:0}}).toArray();
                    if(rows.length) await messages.insertMany(rows.map(row=>({...row,branch:uuid})),{session});
                    // Serialize copying an attachment with deletion of its last disk reference.
                    await mediaRecords.updateMany(filter,{$inc:{forkCopies:1}},{session});
                    const assets=await mediaRecords.find(filter,{session,projection:{forkCopies:0}}).toArray();
                    if(assets.length) await mediaRecords.insertMany(assets.map(row=>{const id=randomUUID();return {...row,_id:id,id,branch:uuid};}),{session});
                });
            }
            json(await branch(uuid), 201);
        } else if (section === 'api' && id === 'branch' && req.method === 'GET' && action) {
            json(await branch(action));
        } else if (section === 'api' && id === 'scene-images' && action && req.method === 'GET') {
            if (!await branches.findOne({_id:action},{projection:{_id:1}})) fail(404,'找不到这份存档。');
            json({jobs:await imageJobs(action),media:await mediaRecords.find({branch:action,type:'image'},{projection:{_id:0,id:1,type:1,mode:1,position:1}}).sort({ordinal:1,_id:1}).toArray()});
        } else if (section === 'api' && id === 'scene-images' && action && req.method === 'POST') {
            const entry=await branch(action);
            const input=await body(req);
            if(!Number.isInteger(input.position)||entry.messages[input.position]?.role!=='assistant') fail(400,'请选择一条已完成的回复。');
            if(input.mode!==undefined && !['free','wai'].includes(input.mode)) fail(400,'请选择免费或 WAI 快速通道。');
            if(input.requestId!==undefined && (typeof input.requestId!=='string'||!/^[a-f0-9-]{32,36}$/i.test(input.requestId))) fail(400,'生成请求编号无效。');
            json({jobs:await enqueueImage(action,input.position,input.mode,input.requestId)},202);
        } else if (section==='api' && id==='scene-images' && parts.length===4 && req.method==='DELETE') {
            const unused=await atomic(async session=>{
                const row=await mediaRecords.findOneAndDelete({_id:file,branch:action,type:'image'},{session});
                if(!row || !safeName(row.file))return null;
                return await mediaRecords.findOne({file:row.file},{session,projection:{_id:1}}) ? null : row.file;
            });
            if(unused)await unlink(join(data,'media',unused)).catch(error=>{if(error.code!=='ENOENT')throw error;});
            json({ok:true});
        } else if (section === 'api' && id === 'turn' && req.method === 'POST' && action) {
            await generate(req, res, action, await body(req));
        } else if (section === 'api' && ['speech', 'image', 'video'].includes(id) && action && req.method === 'POST') {
            const entry = await branch(action);
            const input = await body(req);
            const row = entry.messages[input.position];
            if (row?.role !== 'assistant') fail(400, '请选中一条剧情消息。');
            const config = (await settings())[id];
            if (!config) fail(503, '电脑端还未设置此媒体服务。');
            const payload = id === 'speech' ? { ...config.parameters, text: row.dialogue, text_lang: 'zh' } :
                { ...config.parameters, prompt: row.text, state: row.state };
            if (id === 'speech' && !row.dialogue) fail(400, '这段剧情没有角色对白。');
            if (id === 'video') {
                const image = await mediaRecords.findOne({branch:action,position:input.position,type:'image'},{sort:{ordinal:-1}});
                if (!image) fail(400, '请先生成这段剧情的配图。');
                payload.image_base64 = (await readFile(join(data, 'media', image.file))).toString('base64');
            }
            const response = await upstream(config, payload, AbortSignal.timeout(id === 'video' ? 300000 : 120000));
            if (id === 'speech') {
                const audio = await binary(response, ['audio/'], 16 * 1024 * 1024);
                res.writeHead(200, { 'Content-Type': audio.type }).end(audio.content);
            } else {
                const media = await binary(response, [id + '/'], 32 * 1024 * 1024);
                const ext = Object.keys(mime).find(key => assetTypes.has(key) && mime[key] === media.type);
                if (!ext) fail(502, '媒体格式不受支持。');
                const uuid = randomUUID();
                const filename = uuid + ext;
                await writeFile(join(data, 'media', filename), media.content, { flag: 'wx' });
                await mediaRecords.insertOne({_id:uuid,id:uuid,branch:action,position:input.position,type:id,file:filename,ordinal:Date.now()});
                json(await branch(action));
            }
        } else {
            fail(404, '页面不存在。');
        }
    } catch (error) {
        if (!res.headersSent && !res.destroyed) {
            if (!error.status) console.error('Novel:', error.code || error.name);
            json({ error: error.status ? error.message : '请求失败，请检查电脑端服务。' }, error.status || 500);
        } else if (!res.writableEnded) {
            res.destroy();
        }
    }
    finally {
        if(counted) activeApi--;
        if(exclusive) {imageWorker.resume();removing=false;}
    }
    return true;
}
