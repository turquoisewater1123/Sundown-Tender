import { displayStateLabel, displayStateValue, readMeter } from './status.mjs';

const $ = id => document.getElementById(id);
const reading = $('reading');
const composer = $('composer');
const input = $('input');
const recognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
const nativePhone = navigator.userAgent.includes('NightReadPhone/');
window.novelCallInput = text => { if ($('call').open && !turn) void send(text); };
window.novelCallError = text => { $('call').close(); sayStatus(text); };
const mediaType = url => /\.(mp4|webm)$/i.test(url || '') ? 'video' : /\.(mp3|wav|ogg)$/i.test(url || '') ? 'audio' : 'img';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const audio = [new Audio(), new Audio()];
for (const track of audio) track.loop = true;
let musicIndex = 0;
let musicUrl = '';
let musicEnabled = false;
let fade;
let effectKey;
let activeEffects = [];
let library;
let catalogTime = 0;
let inboxCache;
let inboxTime = 0;
let branch;
let turn;
let selectedCard;
let activePortrait;
let recognition;
let speech;
let speechVersion = 0;
let notice = '';
let opening = false;
let pendingPage;
let toastTimer;
let readingReturn = 'chat';
let detailId = null;
let bookReturn;
const drafts = new Map();
function rememberDraft() {
    if (!branch) return;
    const key = 'nightread:draft:'+branch.id;
    if (input.value) drafts.set(key,input.value);
    else drafts.delete(key);
    try {
        if (input.value) sessionStorage.setItem(key,input.value);
        else sessionStorage.removeItem(key);
    } catch { /* The in-memory copy remains available in this tab. */ }
}
window.addEventListener('pagehide',rememberDraft);
const inboxView = {query:'',searchOpen:false,forks:false,top:0};
const sceneJobs = new Map();
const sceneSubmitting = new Set();
const sceneModes = new Map();
let sceneRevision = 0;
let scenePolling = false;

function enlargeImage(media, label, className) {
    const button = element('button','',className);
    button.type = 'button';
    button.setAttribute('aria-label',label);
    button.onclick = () => {
        const full = image(media.currentSrc || media.src);
        full.alt = label;
        $('full-art').replaceChildren(full);
        open($('art-viewer'));
    };
    button.append(media);
    return button;
}

function updateSceneSlot(slot, message, owner) {
    slot.replaceChildren();
    const key=owner+':'+message.position;
    const job=sceneJobs.get(key);
    slot.dataset.signature=JSON.stringify([job,message.media || [],sceneSubmitting.has(key)]);
    const waiting=job && ['queued','preparing','submitting','waiting','rendering'].includes(job.status);
    const state=message.state||{};
    const stage=selectedCard?.assets?.[message.galleryKey] || message.galleryMode!=='scene' && [state.动作,state.当前动作,state.服装阶段,state.表情,state.当前表情]
        .map(value=>typeof value==='string' && !/^插画\d+$/.test(value) ? selectedCard?.assets?.[value] : null)
        .find(url=>url && mediaType(url)==='img');
    const generated=(message.media||[]).filter(item=>item.type==='image');
    const inline=message.galleryMode!=='scene' && !stage && Object.entries(selectedCard?.embeddedArt||{}).find(([url])=>message.text?.includes(url))?.[1];
    const chosen=stage||inline;
    if(chosen) {
        const media = image(chosen,'attachment',mediaType(chosen)==='video');
        slot.append(media.tagName==='IMG' ? enlargeImage(media,'放大剧情配图','scene-enlarge') : media);
    }
    for(const [index,asset] of generated.entries()){
        const figure=element('div','','scene-figure');
        const label='第 '+(index+1)+' 张实况图';
        const remove=element('button','×','scene-delete');
        remove.type='button';
        remove.setAttribute('aria-label','删除'+label);
        remove.onclick=async()=>{
            if(!window.confirm('删除这张实况图？'))return;
            remove.disabled=true;
            try{
                await api('scene-images/'+owner+'/'+asset.id,undefined,undefined,'DELETE');
                sceneRevision++;
                message.media=message.media.filter(item=>item.id!==asset.id);
                if(slot.isConnected)updateSceneSlot(slot,message,owner);
            }catch(error){remove.disabled=false;sayStatus(error.message)}
        };
        figure.append(enlargeImage(image('media/'+asset.id,'attachment'),'放大'+label,'scene-enlarge'),remove);
        slot.append(figure);
    }
    const controls=element('div','','scene-controls');
    const mode=element('select','','scene-mode');
    mode.setAttribute('aria-label','生图通道');
    mode.add(new Option('慢速 · 免费','free'));
    mode.add(new Option('快速 · WAI（付费）','wai'));
    mode.value=waiting?(job.mode||'free'):(sceneModes.get(key)||'free');
    mode.onchange=()=>sceneModes.set(key,mode.value);
    const again=generated.length || ['failed','done'].includes(job?.status);
    const labels={queued:'等待准备画面…',preparing:'正在准备画面…',submitting:'正在提交图片…',waiting:'正在排队生成…',rendering:'WAI 正在生成…'};
    const button=element('button',sceneSubmitting.has(key)?'正在提交…':waiting?labels[job.status]:again?'再生成一张':'生成实况图','button scene-generate');
    mode.disabled=button.disabled=sceneSubmitting.has(key)||Boolean(waiting);
    button.onclick=async()=>{
        sceneSubmitting.add(key);updateSceneSlot(slot,message,owner);
        try{
            const requestId=Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('');
            const result=await request('scene-images/'+owner,{position:message.position,mode:mode.value,requestId});
            sceneRevision++;
            for(const row of result.jobs)sceneJobs.set(owner+':'+row.position,row);
        }catch(error){sceneJobs.set(key,{status:'failed',error:error.message})}
        finally{sceneSubmitting.delete(key);if(slot.isConnected)updateSceneSlot(slot,message,owner)}
    };
    button.prepend(icon('photo'));
    controls.append(mode,button);
    slot.append(controls);
    if(job?.status==='failed')slot.append(element('small',job.error||'生成失败，请重试。','scene-feedback'));
    else if(waiting)slot.append(element('small',job.wait>0?'预计还需约 '+Math.ceil(job.wait/60)+' 分钟，期间可以继续聊天。':'期间可以继续聊天，也可以给其他回复配图。','scene-feedback'));
}

async function pollSceneImages() {
    if(!branch||scenePolling||document.hidden)return;
    scenePolling=true;
    const owner=branch.id;
    const revision=sceneRevision;
    try{
        const result=await request('scene-images/'+owner);
        if(branch?.id!==owner || revision!==sceneRevision)return;
        for(const row of result.jobs)sceneJobs.set(owner+':'+row.position,row);
        const images = new Map();
        for (const asset of result.media) {
            if (!images.has(asset.position)) images.set(asset.position,[]);
            images.get(asset.position).push(asset);
        }
        const slots = new Map(Array.from($('messages').querySelectorAll('[data-scene-position]'),slot=>[Number(slot.dataset.scenePosition),slot]));
        for(const message of branch.messages){
            const slot=slots.get(message.position);
            if(!slot)continue;
            const old=(message.media||[]).filter(m=>m.type!=='image');
            message.media=[...old,...(images.get(message.position)||[])];
            const key=owner+':'+message.position;
            const signature=JSON.stringify([sceneJobs.get(key),message.media,sceneSubmitting.has(key)]);
            if(slot.dataset.signature!==signature)updateSceneSlot(slot,message,owner);
        }
    }catch{/* Keep chat usable while image status is temporarily unavailable. */}
    finally{scenePolling=false}
}
setInterval(()=>{if(document.body.dataset.view==='reading')void pollSceneImages();},5000);

function element(tag, text = '', className = '') {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
}

const strokes = {
    back:'m14 5-7 7 7 7', next:'m9 5 7 7-7 7',
    enter:'M4 12h15m-6-6 6 6-6 6',
    add:'M12 5v14M5 12h14', trash:'M4 6h16M9 6V3h6v3M6 6l1 14h10l1-14M10 10v6m4-6v6',
    chat:'M20 11a8 8 0 0 1-8 8H8l-5 2 1-5a8 8 0 1 1 16-5ZM8 11h1m3 0h1m3 0h.1',
    photo:'M3 5h18v14H3zM4 17l6-6 4 4 3-3 4 4m-5-8h.1',
    fork:'M7 4v16m0-8c6 0 10-2 10-8m-3 3 3-3 3 3',
    state:'M4 6h16M4 12h16M4 18h16M8 4v4m8 2v4m-6 2v4',
    sound:'M3 9h4l5-4v14l-5-4H3zm13-1a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14',
    video:'M3 6h12v12H3zm12 4 6-3v10l-6-3', download:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
    search:'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0Zm-2 5 6 6', close:'m6 6 12 12M18 6 6 18',
    history:'M3 10a9 9 0 1 1 2 8M3 4v6h6m3-4v6l4 2',
};
function icon(name) {
    const ns='http://www.w3.org/2000/svg';
    const svg=document.createElementNS(ns,'svg');
    svg.setAttribute('viewBox','0 0 24 24');
    svg.setAttribute('aria-hidden','true');
    svg.classList.add('glyph');
    const path=document.createElementNS(ns,'path');
    path.setAttribute('d',strokes[name]);
    svg.append(path);
    return svg;
}
function actionButton(label, name, className='') {
    const button=element('button','','action '+className);
    button.type='button';
    button.append(icon(name),element('span',label));
    return button;
}
// Opening a dialog can move focus before the user has touched a control.
// Keep the keyboard indicator tied to keyboard navigation across all views.
const root=document.documentElement;
root.dataset.keyboard='false';
window.addEventListener('keydown',event=>{
    if(event.key==='Tab' || event.key.startsWith('Arrow')) root.dataset.keyboard='true';
},true);
window.addEventListener('pointerdown',()=>{root.dataset.keyboard='false';},true);
for(const close of document.querySelectorAll('.sheet-close')) close.replaceChildren(icon('close'));

async function api(path, data, signal, method = data === undefined ? 'GET' : 'POST') {
    const reply = await fetch('api/' + path, {
        method,
        headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
        body: data === undefined ? undefined : JSON.stringify(data), signal,
    });
    if (!reply.ok) {
        const details = await reply.json().catch(() => ({}));
        throw new Error(details.error || '连接电脑端失败。');
    }
    return reply;
}
const request = async (path, data) => (await api(path, data)).json();

function sayStatus(text = '') {
    if ($('call').open) {
        $('call-status').textContent = text || '通话中';
        return;
    }
    notice = text;
    $('notice').textContent = text;
}

function feedback(text) {
    let toast = $('feedback');
    if (!toast) {
        toast = element('p', '', 'feedback');
        toast.id = 'feedback';
        toast.setAttribute('role', 'status');
        document.body.append(toast);
    }
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 3500);
}

function open(dialog) {
    if (!dialog.open) dialog.showModal();
}

function image(url, className = '', attachment = false) {
    const node = element(attachment ? 'video' : mediaType(url), '', className);
    if (node.tagName === 'VIDEO') {
        node.playsInline = true;
        node.muted = !attachment;
        node.loop = !attachment;
        node.autoplay = !attachment;
        node.preload = attachment ? 'metadata' : 'auto';
        node.controls = attachment;
    } else {
        node.alt = className === 'attachment' ? '剧情配图' : '';
        node.decoding = 'async';
        node.loading = ['attachment','shelf-cover'].includes(className) ? 'lazy' : 'eager';
    }
    node.src = url;
    return node;
}

function avatar(card, label, className = '') {
    const face = element('span', '', 'avatar ' + className);
    face.setAttribute('aria-hidden', 'true');
    face.append(element('span', Array.from(label || '角色')[0], 'initial'));
    const sources = [...new Set([card?.face, card?.portrait].filter(url => url && mediaType(url) === 'img'))];
    if (sources.length) {
        const picture = document.createElement('img');
        picture.alt = '';
        picture.onload = () => { picture.hidden = false; };
        picture.onerror = () => {
            picture.hidden = true;
            if (sources.length) picture.src = sources.shift();
        };
        picture.hidden = true;
        picture.src = sources.shift();
        face.append(picture);
    }
    return face;
}
function readerAvatar() {
    const change = element('button','','change-face message-avatar');
    change.type = 'button';
    change.setAttribute('aria-label','更换我的头像');
    change.onclick = () => $('reader-photo').click();
    change.append(avatar({face:library?.readerFace},'我'));
    return change;
}
$('reader-photo').onchange = async event => {
    const file = event.target.files[0];
    if (!file) return;
    let bitmap;
    try {
        bitmap = await createImageBitmap(file);
        const side = Math.min(bitmap.width,bitmap.height);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 240;
        const context = canvas.getContext('2d');
        context.fillStyle = 'white';
        context.fillRect(0,0,240,240);
        context.drawImage(bitmap,(bitmap.width-side)/2,(bitmap.height-side)/2,side,side,0,0,240,240);
        const blob = await new Promise(done => canvas.toBlob(done,'image/jpeg',.88));
        const res = await fetch('api/reader-avatar',{method:'POST',headers:{'Content-Type':'image/jpeg'},body:blob});
        if (!res.ok) throw new Error();
        library.readerFace = (await res.json()).face;
        for (const button of $('messages').querySelectorAll('.change-face')) button.replaceWith(readerAvatar());
        sayStatus();
    } catch { sayStatus('头像保存失败，请重新选择照片。'); }
    finally { bitmap?.close(); event.target.value = ''; }
};

const latestState = () => branch?.messages.findLast(message => message.state)?.state;
function drawPortrait() {
    const assets = selectedCard?.assets || {};
    const state = latestState() || {};
    const modelSelectedScene=branch?.messages.findLast(row=>row.role==='assistant')?.galleryMode==='scene';
    const variant = !modelSelectedScene && [state.动作, state.当前动作, state.着装, state.服装阶段, state.表情, state.当前表情]
        .map(key => typeof key === 'string' && Object.hasOwn(assets, key) ? assets[key] : null)
        .find(url => url && mediaType(url) !== 'audio');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const latestScene = branch?.messages.findLast(row=>row.role==='assistant')?.galleryKey;
    const openingMotion = (!latestScene && branch?.messages.length === 1 || latestScene === '主线开场') && selectedCard?.openingMotion;
    const sceneVideo = mediaType(assets[latestScene]) === 'video' ? assets[latestScene] : openingMotion;
    const portrait = selectedCard?.scenePosters
        ? (!reduceMotion && sceneVideo ? sceneVideo : selectedCard.scenePosters[latestScene] || (mediaType(assets[latestScene]) === 'img' && assets[latestScene]) || selectedCard.portrait)
        : (variant && (!reduceMotion || mediaType(variant) === 'img') ? variant : null)
        || (!reduceMotion && selectedCard?.motion) || selectedCard?.portrait;
    if (portrait !== activePortrait) {
        activePortrait = portrait;
        const visual = portrait ? image(portrait,mediaType(portrait)==='img' ? 'ambient-still' : '') : null;
        if (visual?.tagName === 'VIDEO' && selectedCard?.portrait) {
            const fallback = selectedCard.scenePosters?.[latestScene] || selectedCard.portrait;
            visual.poster = fallback;
            visual.addEventListener('error', () => {
                if (activePortrait === portrait) $('portrait').replaceChildren(image(fallback));
            }, { once: true });
        }
        $('portrait').replaceChildren(...(visual ? [visual] : []));
    }
    const sources = Object.values(assets).filter(url => mediaType(url) === 'audio');
    $('music').hidden = !sources.length;
    const ambient = typeof state.氛围 === 'string' && Object.hasOwn(assets, state.氛围) ? assets[state.氛围] : null;
    const source = mediaType(ambient) === 'audio' ? ambient : sources[0];
    if (musicEnabled && source !== musicUrl) playMusic(source);
    const effects = (Array.isArray(state.音效) ? state.音效 : [state.音效])
        .map(key => typeof key === 'string' && Object.hasOwn(assets, key) ? assets[key] : null)
        .filter(url => url && mediaType(url) === 'audio').slice(0, 3);
    const cue = musicEnabled && effects.length ? branch.id + ':' + branch.messages.length + ':' + effects.join(',') : '';
    if (effectKey !== cue) {
        effectKey = cue;
        activeEffects.forEach(effect => effect.pause());
        activeEffects = cue ? effects.map(url => {
            const effect = new Audio(url);
            effect.volume = 0.45;
            void effect.play().catch(() => {});
            return effect;
        }) : [];
    }
}

function playMusic(url) {
    clearInterval(fade);
    const previous = audio[musicIndex];
    const nextIndex = 1 - musicIndex;
    const next = audio[nextIndex];
    const previousVolume = previous.volume;
    next.pause();
    if (url) {
        next.src = url;
        next.volume = 0;
        next.play().catch(() => { if (musicUrl === url) sayStatus('点一下背景音按钮启用播放。'); });
    }
    musicUrl = url;
    musicIndex = nextIndex;
    let step = 0;
    fade = setInterval(() => {
        step += 1;
        previous.volume = Math.max(0, previousVolume * (1 - step / 10));
        next.volume = step / 10 * 0.33;
        if (step === 10) {
            previous.pause();
            clearInterval(fade);
        }
    }, 55);
}

function selectCard(card) {
    if (selectedCard?.id === card?.id) return;
    selectedCard = card;
    $('header-face').replaceChildren(...(card ? [avatar(card,card.name)] : []));
    input.placeholder = card ? '回复' + card.name + '…' : '回复…';
    const key = card?.id || '';
    const hue = Array.from(key).reduce((n,c)=>(n*31+c.codePointAt(0))>>>0,0)%360;
    const applyTheme = h => document.documentElement.style.setProperty('--story-hue',String(Math.round(h)));
    applyTheme(hue);
    if (card?.portrait) {
        const cover = new Image();
        cover.onload = () => {
            if (selectedCard !== card) return;
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 16;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(cover,0,0,16,16);
            const pixels = ctx.getImageData(0,0,16,16).data;
            let x=0,y=0;
            for (let i=0;i<pixels.length;i+=4) {
                const [r,g,b]=pixels.subarray(i,i+3);
                if (!pixels[i+3] || Math.max(r,g,b)-Math.min(r,g,b)<24) continue;
                x+=2*r-g-b; y+=Math.sqrt(3)*(g-b);
            }
            if (Math.hypot(x,y)>0) applyTheme((Math.atan2(y,x)*180/Math.PI+360)%360);
        };
        cover.src=card.portrait;
    }

}

function jump() { reading.scrollTop = reading.scrollHeight; }
const nearBottom = () => reading.scrollHeight - reading.scrollTop - reading.clientHeight < 104;
let lastReadingHeight = reading.clientHeight;
new ResizeObserver(() => {
    const height = reading.clientHeight;
    const wasAtEnd = reading.scrollHeight - reading.scrollTop - lastReadingHeight <= 3;
    if (height < lastReadingHeight && wasAtEnd && document.body.dataset.view === 'reading') jump();
    lastReadingHeight = height;
    $('jump').hidden = nearBottom();
}).observe(reading);
function fitKeyboard() {
    const viewport = window.visualViewport;
    const shell = document.querySelector('.shell');
    if (document.activeElement === input && viewport && viewport.scale === 1 && innerHeight - viewport.height > 80)
        shell.style.height = viewport.height+'px';
    else shell.style.removeProperty('height');
}
window.visualViewport?.addEventListener('resize',fitKeyboard);
input.addEventListener('focus',fitKeyboard);
input.addEventListener('blur',()=>document.querySelector('.shell').style.removeProperty('height'));
reading.addEventListener('scroll', () => { $('jump').hidden = nearBottom(); });
$('jump').onclick = jump;

function renderHeader() {
    $('route').textContent = branch?.customTitle ? branch.title : savedTitle(branch?.title || '夜读');
    $('character').textContent = selectedCard?.name || '互动小说';
    $('welcome-name').textContent = '';
    $('begin').textContent = selectedCard ? '开始阅读' : '选择角色';
    $('inspect').disabled = !latestState();
    $('phone').disabled = !branch;
    $('welcome').hidden = Boolean(branch);
    $('footer').hidden = !branch;
    $('messages').hidden = !branch;
    drawPortrait();
}

function messageNode(message, pending = false, previousState) {
    const article = element('article', '', message.role);
    const isUser = message.role === 'user';
    article.append(isUser ? readerAvatar() : avatar(selectedCard, selectedCard?.name, 'message-avatar'));
    const header = element('div', '', 'message-top');
    header.append(element('span', isUser ? '我' : selectedCard?.name || '角色'));
    if (!pending) {
        const more = element('button', '···', 'more');
        more.setAttribute('aria-label', '打开这条消息的操作');
        more.onclick = () => messageActions(message);
        header.append(more);
        let hold;
        let x;
        let y;
        function clearHold() { clearTimeout(hold); }
        article.addEventListener('pointerdown', event => {
            if (event.target.closest('button,video') || !event.isPrimary || event.button !== 0) return;
            [x, y] = [event.clientX, event.clientY];
            hold = setTimeout(() => messageActions(message), 550);
        });
        article.addEventListener('pointermove', event => {
            if (Math.hypot(event.clientX - x, event.clientY - y) > 10) clearHold();
        });
        for (const name of ['pointerup', 'pointercancel', 'pointerleave']) article.addEventListener(name, clearHold);
    }
    const prose = element('div', message.text, 'prose');
    if (!isUser && selectedCard?.embeddedArt && message.text?.includes('<img')) {
        // Only turn card-specific, locally cached image references into DOM nodes.
        const tags = /(?:<div\b[^>]*>\s*)?<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>(?:\s*<\/div>)?/gi;
        prose.textContent=message.text.replace(tags,'').trim();
    }
    article.append(header, prose);
    if (!pending && message.role === 'assistant') {
        if (message.state && (Object.keys(message.state).length || message.stateDiagnostics)) {
            const panel = element('details', '', 'turn-state');
            panel.open = true;
            const previous=previousState === undefined ? branch?.messages.findLast(row=>row.position<message.position && row.role==='assistant' && row.state)?.state : previousState;
            const changes=message.stateChanges || (previous?Object.keys(message.state).filter(key=>JSON.stringify(message.state[key])!==JSON.stringify(previous[key])):[]);
            const ordered=Object.fromEntries([...changes,...Object.keys(message.state)].map(key=>[key,message.state[key]]));
            const rows=fieldList(ordered,0,previous);
            const heading=message.stateStatus==='carried'?'本轮状态 · 未取得更新，沿用上轮':message.stateStatus==='unchanged'?'本轮状态 · 无变化':'本轮状态';
            panel.append(element('summary', heading), rows);
            if(message.stateDiagnostics?.initial && message.stateStatus==='carried')
                panel.append(element('small',message.stateDiagnostics.initial+'；补全结果：'+message.stateDiagnostics.repair,'meter-note'));
            article.append(panel);
        }
    }
    for (const media of message.media || []) if(media.type!=='image') article.append(image('media/' + media.id, 'attachment', media.type === 'video'));
    if(!pending && message.role==='assistant'){
        const slot=element('div','','scene-images');
        slot.dataset.scenePosition=message.position;
        updateSceneSlot(slot,message,branch.id);
        article.append(slot);
    }
    return article;
}

function renderBranch(scroll = true) {
    let previous = null;
    $('messages').replaceChildren(...(branch?.messages || []).map(message => {
        const node = messageNode(message,false,previous);
        if (message.role==='assistant' && message.state) previous=message.state;
        return node;
    }));
    renderHeader();
    if (scroll) jump();
}

function remember() {
    try { localStorage.setItem('novel-branch', branch.id); } catch { /* Private browser mode. */ }
}

async function loadBranch(next) {
    rememberReadingPosition();
    if (next.id !== branch?.id) {
        rememberDraft();
        const key = 'nightread:draft:'+next.id;
        input.value = drafts.get(key) || '';
        try { input.value = sessionStorage.getItem(key) ?? input.value; } catch {}
        resizeInput();
    }
    branch = next;
    inboxTime = 0;
    if (!library.branches.some(row => row.id === next.id)) {
        const {messages, ...save} = next;
        library.branches.unshift(save);
    }
    selectCard(library.cards.find(item => item.id === branch.card));
    remember();
    const previousPosition = readingPositions.get(next.id);
    renderBranch(previousPosition === undefined);
    if (previousPosition !== undefined) {
        const target = $('messages').children[previousPosition.index];
        if (target) reading.scrollTop += target.getBoundingClientRect().top - reading.getBoundingClientRect().top - previousPosition.offset;
    }
    void pollSceneImages();
}

function option(label, note, action) {
    const button = element('button', '', 'button choice');
    button.append(element('span', label, 'choice-name'), ...(note ? [element('small', note)] : []));
    button.onclick = action;
    return button;
}

async function activate(operation, dialog) {
    if (turn) { feedback('当前回复正在生成，请完成或停止后再打开另一段对话。'); return; }
    if (opening) return;
    if (dialog === $('shelf') && document.body.dataset.view === 'chat') inboxView.top = dialog.scrollTop;
    opening = true;
    dialog?.setAttribute('aria-busy', 'true');

    sayStatus();
    try {
        const next = await operation();
        await loadBranch(next);
        if (dialog === $('shelf')) {
            readingReturn = ['history','detail'].includes(document.body.dataset.view) ? document.body.dataset.view : 'chat';
            const backLabel = {history:'返回历史剧本',detail:'返回剧本详情',chat:'返回聊天库'}[readingReturn];
            $('library').setAttribute('aria-label',backLabel);
            $('library').title = backLabel;
        } else if (document.body.dataset.view === 'reading') {
            markPage('reading');
        }
        dialog?.close();
    } catch (error) {
        if (dialog === $('shelf') && dialog.open) {
            const errorMessage = element('p','这段对话暂时无法打开，请重试。','import-progress');
            errorMessage.setAttribute('role','alert');
            $('shelf-content').querySelector('[role="alert"]')?.remove();
            $('shelf-content').prepend(errorMessage);
            return;
        }
        dialog?.close();
        sayStatus(error.message);
        if (!branch) $('welcome-name').textContent = error.message;
    } finally {
        opening = false;
        dialog?.removeAttribute('aria-busy');
        if ($('feedback')?.textContent === '正在打开…') $('feedback').hidden = true;
        if (pendingPage) { const page = pendingPage; pendingPage = null; void showShelf(page); }
    }
}

function newBranch(card, opening) {
    if (card) void activate(() => request('branches', { card: card.id, opening }), $('shelf'));
}

const readingPositions = new Map();
function rememberReadingPosition() {
    if (!branch || document.body.dataset.view !== 'reading') return;
    if (nearBottom()) { readingPositions.delete(branch.id); return; }
    const top = reading.getBoundingClientRect().top;
    const rows = Array.from($('messages').children);
    const index = rows.findIndex(row=>row.getBoundingClientRect().bottom>top);
    if (index >= 0) readingPositions.set(branch.id,{index,offset:rows[index].getBoundingClientRect().top-top});
}
function markPage(page) {
    if (page !== 'reading') rememberReadingPosition();
    document.body.dataset.view = page;
    const wallpaper = $('portrait').querySelector('video');
    if (wallpaper && page === 'reading') void wallpaper.play().catch(()=>{});
    else wallpaper?.pause();
    const url=new URL(location.href);
    if(page==='detail') url.searchParams.set('story',detailId);
    else url.searchParams.delete('story');
    if(['books','history'].includes(page)) url.searchParams.set('page',page);
    else url.searchParams.delete('page');
    const previous = history.state;
    const route = {page, story:page === 'detail' ? detailId : null, branch:page === 'reading' ? branch?.id : null, returnPage:readingReturn};
    if (previous?.nightread && previous.page !== page) {
        history.pushState({...route,nightread:true,hasParent:true},'',url);
    } else {
        history.replaceState({...route,nightread:true,hasParent:previous?.hasParent || false},'',url);
    }
    document.querySelector('.shell').inert = page !== 'reading';
    $('find-chats').hidden = page !== 'chat';
    for (const button of $('dock').children) button.setAttribute('aria-current',button.dataset.page===page?'page':'false');
}
function returnTo(page) {
    if (history.state?.hasParent) history.back();
    else void showShelf(page);
}
window.addEventListener('popstate', async ({state}) => {
    if (!state?.nightread) return;
    for (const dialog of document.querySelectorAll('dialog[open]:not(#shelf)')) dialog.close();
    if (state.page === 'reading' && state.branch) {
        try {
            if (branch?.id !== state.branch) await loadBranch(await request('branch/'+state.branch));
            if ($('shelf').open) $('shelf').close();
            markPage('reading');
        } catch { void showShelf('chat'); }
        return;
    }
    if (state.page === 'detail') detailId = state.story;
    void showShelf(state.page);
});
$('dock').onclick = event => {
    const page=event.target.closest('button')?.dataset.page;
    if (!page) return;
    if (!opening && $('shelf').open && document.body.dataset.view === page) return;
    void showShelf(page);
};
$('shelf').onclose = () => {
    if ($('shelf').open) return;
    markPage('reading');
    $('reading').focus({ preventScroll:true });
};
window.novelBack = () => {
    if ($('art-viewer').open) { $('art-viewer').close(); return true; }
    if ($('erase-confirm').open) { if (!$('erase-accept').disabled) $('erase-confirm').close(); return true; }
    for (const id of ['rename-route','story-routes','call','actions','status']) {
        if ($(id).open) { $(id).close(); return true; }
    }
    if (opening) { feedback('正在打开，请稍候…'); return true; }
    const search = $('shelf-content').querySelector('.inbox-search');
    if ($('shelf').open && search && !search.hidden) { $('find-chats').click(); return true; }
    if (history.state?.hasParent) { history.back(); return true; }
    if (document.body.dataset.view==='detail') { void showShelf('books'); return true; }
    if (document.body.dataset.view === 'reading') { void showShelf(readingReturn); return true; }
    if (document.body.dataset.view !== 'chat') { void showShelf('chat'); return true; }
    return false;
};

function dateLabel(date) {
    const current = new Date();
    if (current.toDateString() === date.toDateString()) return date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});
    current.setDate(current.getDate() - 1);
    if (current.toDateString() === date.toDateString()) return '昨天';
    return date.toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'});
}

function savedTitle(title) {
    if (title === '主线') return '初遇';
    const oldFork = /^第 (\d+) 条的分支$/.exec(title);
    if (oldFork) return '另一种可能 · '+oldFork[1];
    const stamp = /(?:^| - )(\d{4})-(\d{2})-(\d{2})@(\d{2})h(\d{2})m\d{2}s\d*ms$/.exec(title);
    return stamp ? `${Number(stamp[2])}月${Number(stamp[3])}日 ${stamp[4]}:${stamp[5]} 的对话` : title;
}

function renderInbox(menu, entries) {
    const search = element('input', '', 'book-search inbox-search');
    search.type = 'search';
    search.hidden = !inboxView.searchOpen;
    search.value = inboxView.query;
    search.placeholder = '搜索角色、剧本或消息';
    search.setAttribute('aria-label', search.placeholder);
    const find = $('find-chats');
    find.setAttribute('aria-expanded',String(!search.hidden));
    find.onclick = () => {
        search.hidden = !search.hidden;
        inboxView.searchOpen = !search.hidden;
        find.setAttribute('aria-expanded', String(!search.hidden));
        if (search.hidden) { search.value = ''; filter(); }
        else search.focus();
    };
    const tabs = element('div', '', 'inbox-tabs');
    const list = element('section', '', 'inbox');
    const empty = element('p', '', 'empty');
    const discover = option('去剧本库', '', () => showShelf('books'));
    discover.classList.add('discover');
    const forks = new Set(library.branches.filter(b => b.parent).map(b => b.card));
    let onlyForks = inboxView.forks;
    for (const [label, forksOnly] of [['全部',false],['有分支',true]]) {
        const tab = element('button', label);
        tab.type = 'button';
        tab.setAttribute('aria-pressed', String(forksOnly === onlyForks));
        tab.onclick = () => {
            onlyForks = forksOnly;
            inboxView.forks = forksOnly;
            for (const other of tabs.children) other.setAttribute('aria-pressed',String(other === tab));
            filter();
        };
        tabs.append(tab);
    }
    for (const entry of entries) {
        const story = library.cards.find(card => card.id === entry.card);
        const name = story?.name || entry.title;
        const preview = (entry.preview || '').replace(/<[^>]*(?:>|$)/g,'').replace(/\*+/g,'').replace(/\s+/g,' ').trim();
        const row = element('button', '', 'inbox-row');
        row.type = 'button';
        row.dataset.forked = String(forks.has(entry.card));
        row.dataset.search = [name, story?.title, preview].filter(Boolean).join(' ').replace(/\s+/g,' ').toLocaleLowerCase();
        row.onclick = () => {
            if (turn && branch?.id === entry.id) {
                readingReturn='chat';
                $('library').setAttribute('aria-label','返回聊天库');
                $('shelf').close();
                return;
            }
            void activate(() => request('branch/' + entry.id), $('shelf'));
        };
        const copy = element('span', '', 'inbox-copy');
        const line = element('span', '', 'inbox-line');
        line.append(element('strong', story?.title || name));
        const saved = library.branches.find(b => b.id === entry.id);
        const date = new Date(saved?.lastActivity ?? saved?.created);
        if (Number.isFinite(date.getTime())) {
            const time = element('time', dateLabel(date), 'inbox-date');
            time.dateTime = date.toISOString();
            line.append(time);
        }
        copy.append(line, element('span',preview || '继续对话','inbox-preview'));
        row.append(avatar(story,name,'inbox-cover'),copy);
        const lineWrap=element('div','','inbox-entry');
        lineWrap.append(row,removeButton('branch',entry.id,(story?.title || name)+' · '+savedTitle(entry.title)));
        list.append(lineWrap);
    }
    function filter() {
        inboxView.query = search.value;
        const term = search.value.trim().replace(/\s+/g,' ').toLocaleLowerCase();
        let visible = 0;
        for (const wrap of list.children) {
            const row=wrap.firstElementChild;
            wrap.hidden = !row.dataset.search.includes(term) || (onlyForks && row.dataset.forked !== 'true');
            if (!wrap.hidden) visible++;
        }
        empty.hidden = visible > 0;
        empty.textContent = term ? '没有找到相关对话' : onlyForks ? '还没有分支对话' : '还没有聊过的剧本';
        discover.hidden = entries.length > 0;
    }
    search.oninput = filter;
    filter();
    menu.replaceChildren(search,tabs,list,empty,discover);
}

async function showShelf(page='books') {
    if (opening) { pendingPage = page; return; }
    if ($('shelf').open && document.body.dataset.view === 'chat') inboxView.top = $('shelf').scrollTop;
    opening = true;
    $('shelf').setAttribute('aria-busy','true');

    try {
        const now = Date.now();
        const needCatalog = !library || now - catalogTime > 60000;
        const needInbox = page === 'chat' && (!inboxCache || now - inboxTime > 15000);
        const [catalog, inbox, saves] = await Promise.all([
            needCatalog ? request('library') : null,
            needInbox ? request('inbox') : null,
            !needCatalog && (page === 'history' || needInbox) ? request('branches') : null,
        ]);
        if (catalog) { library = catalog; catalogTime = now; }
        if (saves) library.branches = saves;
        if (inbox) { inboxCache = inbox; inboxTime = now; }
        const menu = $('shelf-content');
        menu.ondragover = menu.ondrop = null;
        if (page==='detail') {
            const card=library.cards.find(item=>item.id===detailId);
            if(card){renderDetail(card); if (!$('shelf').open) $('shelf').show(); return;}
            page='books';
        }
        if (page==='chat') {
            const entries=inboxCache;
            $('shelf').querySelector('h2').textContent='聊天库';
            renderInbox(menu, entries);
            markPage('chat');
            if (!$('shelf').open) $('shelf').show();
            $('shelf').scrollTop=inboxView.top;
            return;
        }
        const showHistory=page==='history';
        $('shelf').querySelector('h2').textContent=showHistory?'历史剧本':'剧本库';
        markPage(showHistory?'history':'books');
        if (showHistory) renderHistory(menu);
        else renderLibrary(menu);
        if (!$('shelf').open) $('shelf').show();
        $('shelf').scrollTop=0;
        if(page==='books' && bookReturn){
            const {query,top,id}=bookReturn;
            bookReturn=null;
            const search=menu.querySelector('.book-search');
            search.value=query;
            search.oninput();
            $('shelf').scrollTop=top;
            [...menu.querySelectorAll('.book-card')].find(row=>row.dataset.id===id)?.focus({preventScroll:true});
        }
    } catch (error) {
        const retry = option('重新加载', '', () => showShelf(page));
        retry.classList.add('discover');
        $('shelf-content').replaceChildren(element('p','暂时无法加载，请检查电脑端连接。','empty'),retry);
        $('shelf').querySelector('h2').textContent = {chat:'聊天库',history:'历史剧本',books:'剧本库'}[page];
        markPage(page);
        $('find-chats').hidden = true;
        if (!$('shelf').open) $('shelf').show();
    } finally {
        opening = false;
        $('shelf').removeAttribute('aria-busy');
        if ($('feedback')?.textContent === '正在加载…') $('feedback').hidden = true;
        if (pendingPage) { const next = pendingPage; pendingPage = null; void showShelf(next); }
    }
}

function renderLibrary(menu) {
    const books = element('section');
    menu.replaceChildren(books);
    const chooser = element('input');
    chooser.type = 'file';
    chooser.accept = '.json,.png';
    chooser.hidden = true;
    const importButton = actionButton('导入剧本','add','import-story');
    importButton.onclick=()=>chooser.click();
    const search = element('input','','book-search');
    search.type='search';
    search.placeholder='搜索剧本或角色';
    search.setAttribute('aria-label',search.placeholder);
    const progress = element('p','','import-progress');
    progress.setAttribute('role','status');
    async function importFile(file) {
        if (!file || importButton.disabled) return;
        importButton.disabled = true;
        progress.textContent = '正在导入原稿…';
        try {
            const response = await fetch('api/import-card',{method:'POST',body:file});
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || '导入失败');
            catalogTime = inboxTime = 0;
            await showShelf();
        } catch { progress.textContent = '无法导入这张剧本卡，请检查文件后重试。'; }
        finally { importButton.disabled = false; chooser.value = ''; }
    }
    chooser.onchange = () => importFile(chooser.files[0]);
    menu.ondragover = event => event.preventDefault();
    menu.ondrop = event => { event.preventDefault(); void importFile(event.dataTransfer.files[0]); };
    const browse = element('div','','book-tools');
    const searchLabel=element('label','','search-field');
    searchLabel.append(icon('search'),search);
    browse.append(searchLabel,importButton,chooser);
    books.append(browse,progress);
    const noResults=element('p','','empty');
    noResults.hidden=library.cards.length>0;
    noResults.textContent='剧本库还是空的，可以导入第一部剧本。';
    books.append(noResults);
    search.oninput=()=>{
        const query=search.value.trim().toLocaleLowerCase();
        for(const item of books.querySelectorAll('.book-card'))
            item.hidden=!item.textContent.toLocaleLowerCase().includes(query);
        noResults.hidden=Boolean(books.querySelector('.book-card:not([hidden])'));
        noResults.textContent=query?'没有找到相关剧本':'剧本库还是空的，可以导入第一部剧本。';
    };
    for (const card of library.cards) {
        const label = card.title ? `${card.title} · ${card.name}` : card.name;
        const item = element('button','','book-card');
        item.type='button';
        item.dataset.id=card.id;
        item.setAttribute('aria-label',label+' 剧本详情');
        item.onclick=()=>{
            bookReturn={query:search.value,top:$('shelf').scrollTop,id:card.id};
            if (opening) { detailId=card.id; pendingPage='detail'; return; }
            renderDetail(card);
        };
        const cover = element('span','','book-cover');
        cover.append(card.portrait && mediaType(card.portrait)==='img' ? image(card.portrait,'shelf-cover') : avatar(card,card.name));
        const copy = element('span','','book-copy');
        item.append(cover,copy);
        copy.append(element('strong',card.title || card.name,'book-title'));
        if (card.title && card.title!==card.name) copy.append(element('span',card.name,'book-character'));
        const teaser=(card.description || card.background || '').trim().split('\n')[0];
        if(teaser) copy.append(element('span',teaser,'book-preview'));
        const read=element('span','查看剧本','book-link');
        read.append(icon('enter'));copy.append(read);
        books.append(item);

    }
}

function renderDetail(card) {
    detailId=card.id;
    markPage('detail');
    const menu=$('shelf-content');
    menu.ondrop=menu.ondragover=null;
    $('shelf').querySelector('h2').textContent='剧本详情';
    const story=element('article','','story-detail');
    const back=actionButton('剧本库','back','detail-back');
    back.onclick=()=>returnTo('books');
    const heading=element('header','','detail-heading');
    heading.append(element('h1',card.title || card.name));
    heading.firstChild.tabIndex=-1;
    if(card.title && card.title!==card.name) heading.append(element('p',card.name));
    const recent = library.branches.filter(row=>row.card===card.id)
        .sort((a,b)=>(b.lastActivity ?? b.created)-(a.lastActivity ?? a.created))[0];
    const start=actionButton(recent ? '另起故事' : '开聊','chat','start-story');
    let opening;
    start.onclick=()=>newBranch(card,opening?.value==='' ? undefined : opening ? Number(opening.value) : undefined);
    const nav=element('nav','','detail-nav');
    nav.append(back,removeButton('story',card.id,card.title || card.name));
    story.append(nav);
    if(card.portrait) story.append(image(card.portrait,'detail-hero'));
    story.append(heading);
    const controls=element('div','','story-controls');
    if (recent) {
        const resume = actionButton('继续阅读','chat','resume-story');
        resume.onclick = ()=>activate(()=>request('branch/'+recent.id),$('shelf'));
        controls.append(resume);
    }
    controls.append(start);
    if(card.openings?.length) {
        opening=element('select');
        opening.setAttribute('aria-label','选择开场');
        opening.add(new Option('默认开场',''));
        card.openings.forEach((label,i)=>opening.add(new Option(label,String(i))));
        controls.append(opening);
    }
    story.append(controls);
    const section=(label,value)=>{
        if(value) story.append(element('h3',label),element('p',value,'detail-prose'));
    };
    const gallery=element('div','','detail-gallery');
    for(const url of new Set([...(card.gallery || []),card.motion].filter(url=>url && url!==card.portrait))) {
        const media=image(url,'',mediaType(url)==='video');
        if(media.tagName==='IMG') {
            media.loading='lazy';
            gallery.append(enlargeImage(media,'放大剧照 '+(gallery.childElementCount+1),'gallery-image'));
        } else {
            media.preload = 'none';
            const scene = Object.keys(card.assets || {}).find(key => card.assets[key] === url);
            if (card.scenePosters?.[scene]) media.poster = card.scenePosters[scene];
            gallery.append(media);
        }
    }
    if(gallery.childElementCount) {
        const bar=element('div','','gallery-heading');
        bar.append(element('h3','剧本图集'));
        if(gallery.childElementCount>1) {
            for(const [direction,name,label] of [[-1,'back','上一张图'],[1,'next','下一张图']]) {
                const step=actionButton(label,name,'compact-action');
                step.onclick=()=>{
                    const frames=[...gallery.children];
                    const left=gallery.getBoundingClientRect().left;
                    const next=direction>0 ? frames.find(frame=>frame.getBoundingClientRect().left>left+2) : frames.reverse().find(frame=>frame.getBoundingClientRect().left<left-2);
                    if(next) gallery.scrollBy({left:next.getBoundingClientRect().left-left,behavior:'instant'});
                };
                bar.append(step);
            }
            const update=()=>{
                bar.children[1].disabled=gallery.scrollLeft<=1;
                bar.children[2].disabled=gallery.scrollLeft+gallery.clientWidth>=gallery.scrollWidth-1;
            };
            gallery.onscroll=update;
            gallery.addEventListener('load',update,true);
            requestAnimationFrame(update);
        }
        story.append(bar,gallery);
    }
    section('故事背景',card.background);
    section(card.descriptionLabel || '故事简介',card.description);
    section('你的角色',card.guide?.role);
    section('故事主题',card.guide?.themes);
    section('剧情试读',card.guide?.excerpt);
    const copies=element('details','','story-downloads');
    const summary=element('summary','导出剧本');summary.prepend(icon('download'));copies.append(summary);
    for(const [kind,label] of [['original','剧本原文'],['catalog','剧本简介']]){
        const link=element('a',label);
        link.href='api/card-copy/'+encodeURIComponent(card.id)+'/'+kind;
        link.download='';copies.append(link);
    }
    story.append(copies);
    menu.replaceChildren(story);
    $('shelf').scrollTop=0;
    requestAnimationFrame(()=>{if(heading.isConnected)heading.firstChild.focus({preventScroll:true});});
}

function removeButton(kind,id,label,oldTitle) {
    const story=kind==='story';
    const text=story?'删除剧本':'删除聊天';
    const trigger=actionButton(text,'trash','remove-link'+(story?'':' compact-action'));
    trigger.title=text;
    trigger.setAttribute('aria-label',text+' · '+label);
    trigger.onclick=()=>{
        const dialog=$('erase-confirm'), yes=$('erase-accept'), cancel=$('erase-cancel');
        $('erase-title').textContent=text;
        $('erase-note').textContent=story ? '永久删除《'+label+'》、全部聊天分支、旧酒馆记录和关联图片？' : '永久删除「'+label+'」的这份聊天记录？剧本和其他独立存档仍可打开。';
        $('erase-error').textContent='';
        cancel.onclick=()=>dialog.close();
        dialog.oncancel=e=>{if(yes.disabled)e.preventDefault();};
        yes.onclick=async()=>{
            yes.disabled=cancel.disabled=true;
            yes.textContent='正在删除…';
            try {
                const res=await fetch('api/'+kind+'/'+encodeURIComponent(id),{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:oldTitle})});
                if(!res.ok && res.status!==404) throw new Error((await res.json()).error);
                if(branch && (story ? branch.card===id : kind==='branch' && branch.id===id)) {
                    input.value=''; rememberDraft();
                    branch=null;selectCard(null);renderBranch();localStorage.removeItem('novel-branch');
                }
                dialog.close();
                catalogTime = inboxTime = 0;
                await showShelf(story?'books':document.body.dataset.view==='history'?'history':'chat');
            } catch(e) { $('erase-error').textContent=e.message || '删除未完成，请重试。'; }
            finally {yes.disabled=cancel.disabled=false; yes.textContent='永久删除';}
        };
        open(dialog);
    };
    return trigger;
}

function renderHistory(menu) {
    const list = element('section');
    const search = element('input','','book-search');
    search.type = 'search';
    search.placeholder = '搜索剧本、角色或故事线';
    search.setAttribute('aria-label',search.placeholder);
    const empty = element('p','没有找到相关记录','empty');
    empty.hidden = true;
    search.oninput = () => {
        const term = search.value.trim().toLocaleLowerCase();
        const groups = Array.from(list.querySelectorAll('.story-history'));
        for (const group of groups) group.hidden = !group.textContent.toLocaleLowerCase().includes(term);
        empty.hidden = !term || groups.some(group=>!group.hidden);
    };
    menu.replaceChildren(search,list,empty);
    const order = [...library.branches].sort((a,b) => (b.lastActivity ?? b.created) - (a.lastActivity ?? a.created));
    const ids = new Set([...order.map(row => row.card), ...library.cards.filter(card => card.imports.length).map(card => card.id)]);
    search.hidden = !ids.size;
    if (!ids.size) list.append(element('p', '读过的剧本会出现在这里。','empty'));
    const stamp = new Intl.DateTimeFormat('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
    for (const id of ids) {
        const story = library.cards.find(card => card.id === id);
        const name = story?.name || '角色';
        const saves = order.filter(row => row.card === id);
        const older = story?.imports || [];
        const forks = saves.filter(row => row.parent).length;
        const info = [];
        if (story?.title && story.title !== name) info.push(name);
        if (saves.length > forks) info.push((saves.length - forks) + ' 条主线');
        if (forks) info.push(forks + ' 个分支');
        if (older.length) info.push(older.length + ' 份旧记录');
        const group = element('details', '', 'story-history');
        const summary = element('summary');
        const title = element('span', story?.title || name);
        title.append(element('small',info.join(' · ')));
        summary.append(avatar(story,name),title);
        group.append(summary);
        group.open = branch?.card === id;
        list.append(group);
        const savedIds = new Set(saves.map(row => row.id));
        const children = new Map();
        for (const saved of saves) {
            const parent = savedIds.has(saved.parent) ? saved.parent : null;
            if (!children.has(parent)) children.set(parent, []);
            children.get(parent).push(saved);
        }
        const pending = (children.get(null) || []).map(saved => [saved,0]).reverse();
        while (pending.length) {
            const [saved,depth] = pending.pop();
            const date = new Date(saved.created);
            const when = Number.isFinite(date.getTime()) ? stamp.format(date) : '';
            const button = option((saved.customTitle ? saved.title : savedTitle(saved.title)),when,() => activate(() => request('branch/' + saved.id),$('shelf')));
            button.setAttribute('aria-label',[(saved.customTitle ? saved.title : savedTitle(saved.title)),name,when].filter(Boolean).join(' · '));
            button.style.setProperty('--depth', Math.min(depth,4));
            if (saved.id === branch?.id) button.setAttribute('aria-current','true');
            const line=element('div','','saved-line');
            line.append(button,removeButton('branch',saved.id,name+' · '+(saved.customTitle ? saved.title : savedTitle(saved.title))+' '+when));
            group.append(line);
            pending.push(...(children.get(saved.id) || []).map(child => [child,depth + 1]).reverse());
        }
        if (older.length) group.append(element('h3','旧酒馆记录','history-subheading'));
        for (const title of older) {
            const line=element('div','','saved-line');
            line.append(option(savedTitle(title),'导入',() => activate(
                () => request('branches',{card:id,importTitle:title}),$('shelf'))),removeButton('old-chat',id,savedTitle(title),title));
            group.append(line);
        }
    }
}

function fieldList(value, level = 0, previous) {
    const list = element('div', '', 'fields');
    if (level > 12) return list;
    for (const [name, entry] of Object.entries(value)) {
        const label = displayStateLabel(name);
        const meter = readMeter(name, entry);
        if (!meter && isObject(entry)) {
            const group = element('fieldset', '', 'field-group');
            group.append(element('legend', label), fieldList(entry, level + 1,previous?.[name]));
            list.append(group);
            continue;
        }
        const row = element('div', '', 'field');
        const content = element('div');
        row.append(element('span', label, 'field-name'), content);
        if (meter) {
            const wrap = element('div', '', 'meter');
            const fill = element('progress');
            fill.max = meter.max;
            fill.value = meter.value;
            fill.setAttribute('aria-label', label);
            const number = meter.max === 100 ? meter.value + '%' : `${meter.value}/${meter.max}`;
            wrap.append(fill, element('span', number));
            const old=readMeter(name,previous?.[name]) || (previous?.[name]===0?{value:0,max:100}:null);
            if(old){
                const delta=Math.round(100*(meter.value/meter.max-old.value/old.max));
                if(delta){
                    wrap.classList.add('meter-changed');
                    const badge=element('small',(delta>0?'↑':'↓')+Math.abs(delta),'meter-delta');
                    badge.title='比上轮'+(delta>0?'上升':'下降')+Math.abs(delta)+'个百分点';
                    wrap.append(badge);
                }
            }
            content.append(wrap);
            if (meter.note) content.append(element('div', meter.note, 'meter-note'));
        } else if (Array.isArray(entry)) {
            content.className = 'tags';
            for (const item of entry) {
                if (item && typeof item === 'object') content.append(fieldList(item, level + 1));
                else content.append(element('span', displayStateValue(item), 'tag'));
            }
            if (!entry.length) content.textContent = '0';
        } else {
            content.textContent = displayStateValue(entry);
        }
        list.append(row);
    }
    return list;
}

function showState(state) {
    $('fields').replaceChildren(fieldList(state));
    open($('status'));
}

function messageActions(message) {
    if (opening || $('actions').open) return;
    const slot = $('message-actions');
    slot.replaceChildren(option('从这里新建分支', '', () => activate(
        () => request('branches', { parent: branch.id, position: message.position }), $('actions'))));
    if (message.state) slot.append(option('查看当时的状态', '', () => {
        $('actions').close();
        showState(message.state);
    }));
    if (message.dialogue) slot.append(option('朗读角色对白', '', () => {
        $('actions').close();
        void readDialogue(message);
    }));
    if (library.capabilities.image && message.role === 'assistant') slot.append(option('生成剧情配图', '', () => createMedia('image', message)));
    if (library.capabilities.video && message.media.some(item => item.type === 'image')) {
        slot.append(option('用配图生成短视频', '', () => createMedia('video', message)));
    }
    const names={'从这里新建分支':'fork','查看当时的状态':'state','朗读角色对白':'sound','生成剧情配图':'photo','用配图生成短视频':'video'};
    for(const button of slot.children) {
        button.prepend(icon(names[button.textContent]));
        button.append(icon('next'));
    }
    open($('actions'));
}

async function createMedia(kind, message) {
    if(kind==='image'){
        $('actions').close();
        const mode=$('messages').querySelector('[data-scene-position="'+message.position+'"] .scene-mode');
        mode?.scrollIntoView({block:'center'});
        mode?.focus();
        return;
    }
    if (opening) return;
    $('actions').close();
    sayStatus(kind === 'image' ? '正在生成配图…' : '正在生成视频…');
    await activate(() => request(kind + '/' + branch.id, { position: message.position }));
}

function updateControls() {
    $('send').hidden = Boolean(turn);
    $('stop').hidden = !turn;
    $('dictate').disabled = Boolean(turn);
    $('listen').disabled = Boolean(turn);
}

async function send(text) {
    if (!text.trim() || !branch || turn || opening) return;
    const abort = new AbortController();
    turn = abort;
    if (input.value === text) {
        input.value = '';
        rememberDraft();
        resizeInput();
    }
    updateControls();
    sayStatus();
    const target = $('messages');
    const user = messageNode({ role: 'user', text }, true);
    const reply = messageNode({ role: 'assistant', text: '…' }, true);
    target.append(user, reply);
    const prose = reply.querySelector('.prose');
    const waiting = element('span','','typing-indicator');
    waiting.setAttribute('role','status');
    const dots = element('span','','typing-dots');
    dots.setAttribute('aria-hidden','true');
    dots.append(element('i'),element('i'),element('i'));
    const phrases = ['话到了唇边…','心跳漏了一拍…','贴近些，听我说…'];
    waiting.append(dots,element('span',phrases[Math.floor(branch.messages.length/2)%phrases.length],'typing-copy'));
    prose.replaceChildren(waiting);
    jump();
    try {
        const position = branch.messages.length;
        const response = await api('turn/' + branch.id, { text, position, resultMode:'append' }, abort.signal);
        const frames = response.body.pipeThrough(new TextDecoderStream());
        let pending = '';
        let complete;
        receive: for await (const chunk of frames) {
            const lines = (pending + chunk).split('\n');
            pending = lines.pop();
            for (const line of lines) {
                if (!line) continue;
                const event = JSON.parse(line);
                if (event.error) throw new Error(event.error);
                if (event.status && !/正在(?:续写|生成|思考)/.test(event.status)) sayStatus(event.status);
                if (typeof event.text === 'string' && event.text.length) {
                    const follow = nearBottom();
                    prose.textContent = event.text;
                    if (follow) jump();
                }
                if (event.done) {
                    complete = event;
                    break receive;
                }
            }
        }
        if (!complete) throw new Error('连接中断，请重试。');
        const follow = nearBottom();
        if (complete.fromPosition === position && complete.done.messages.length === 2) {
            const [sent, received] = complete.done.messages;
            branch = {...complete.done, messages:branch.messages.concat(sent, received)};
            user.replaceWith(messageNode(sent));
            reply.replaceWith(messageNode(received));
            renderHeader();
            if (follow) jump();
        } else {
            branch = complete.fromPosition === undefined ? complete.done : await request('branch/' + branch.id);
            renderBranch(follow);
        }
        inboxTime = 0;
        sayStatus();
        if ($('call').open) {
            const last = branch.messages.at(-1);
            if (nativePhone) location.href = 'nightread-call://reply?text=' + encodeURIComponent(last.dialogue || last.text);
            else await readDialogue(last);
        }
    } catch (error) {
        user.remove();
        reply.remove();
        let saved = false;
        try {
            const latest = await request('branch/' + branch.id);
            if (latest.messages.length > branch.messages.length) {
                branch = latest;
                saved = true;
                renderBranch();
            }
        } catch { /* Keep the draft and branch visible if reconnection fails. */ }
        if (!saved && !input.value) {
            input.value = text;
            resizeInput();
        }
        sayStatus(error.name === 'AbortError' ? '已停止续写。' : error.message);
        if ($('call').open && nativePhone) $('call').close();
    } finally {
        turn = null;
        updateControls();
    }
}

function resizeInput() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight + 2, window.innerHeight * 0.2) + 'px';
}

function stopSpeech() {
    speechVersion++;
    window.speechSynthesis?.cancel();
    if (speech) {
        speech.pause();
        URL.revokeObjectURL(speech.src);
        speech = null;
    }
}

async function readDialogue(message) {
    if (!message?.dialogue) {
        sayStatus('本轮没有需要朗读的角色对白。');
        return;
    }
    stopSpeech();
    const version = speechVersion;
    try {
        if (library.capabilities.speech) {
            const response = await api('speech/' + branch.id, { position: message.position });
            const blob = await response.blob();
            if (speechVersion !== version) return;
            const voice = new Audio(URL.createObjectURL(blob));
            speech = voice;
            voice.onended = () => {
                if (speech === voice) stopSpeech();
            };
            await voice.play();
        } else if (window.speechSynthesis) {
            const voice = new SpeechSynthesisUtterance(message.dialogue);
            voice.lang = 'zh-CN';
            window.speechSynthesis.speak(voice);
        } else {
            sayStatus('当前浏览器没有可用的中文语音。');
        }
    } catch (error) {
        if (version === speechVersion) sayStatus(error.message || '无法播放语音。');
    }
}

function startListening(call = false) {
    if (turn) return;
    if (recognition) {
        recognition.stop();
        return;
    }
    if (library?.capabilities.transcription && window.MediaRecorder && navigator.mediaDevices?.getUserMedia) {
        void recordVoice(call);
        return;
    }
    if (!recognitionClass || !window.isSecureContext) {
        sayStatus('语音输入需要 HTTPS 和支持语音识别的手机浏览器。');
        return;
    }
    const recognizer = new recognitionClass();
    recognition = recognizer;
    recognizer.lang = 'zh-CN';
    recognizer.continuous = true;
    recognizer.interimResults = false;
    let spoken = '';
    let submitTimer;
    let failed = false;
    recognizer.onresult = event => {
        spoken += Array.from(event.results).slice(event.resultIndex).filter(result => result.isFinal)
            .map(result => result[0].transcript).join('');
        clearTimeout(submitTimer);
        submitTimer = setTimeout(() => recognizer.stop(), 650);
    };
    recognizer.onerror = () => {
        failed = true;
        sayStatus('语音识别失败，请检查麦克风权限或试用文字输入。');
    };
    recognizer.onend = () => {
        clearTimeout(submitTimer);
        if (recognition !== recognizer) return;
        recognition = null;
        $('listen').textContent = '开始说话';
        if (!failed) sayStatus();
        applySpeech(spoken, call);
    };
    try {
        if (call) stopSpeech();
        recognizer.start();
        $('listen').textContent = call ? '说完了' : '结束并发送';
        sayStatus('正在听你说话…');
    } catch {
        recognition = null;
        sayStatus('暂时无法打开语音识别。');
    }
}

function applySpeech(spoken, call) {
    if (!spoken.trim()) return;
    if (call && $('call').open) void send(spoken);
    else if (!call) {
        input.setRangeText(spoken, input.selectionStart, input.selectionEnd, 'end');
        resizeInput();
    }
}

async function recordVoice(call) {
    const type = ['audio/webm', 'audio/mp4', 'audio/ogg'].find(value => MediaRecorder.isTypeSupported(value));
    if (!type) {
        sayStatus('浏览器不支持可识别的录音格式。');
        return;
    }
    let stream;
    let recorder;
    let released = false;
    let cancelled = false;
    let timer;
    const finish = () => {
        released = true;
        if (recorder?.state === 'recording') recorder.stop();
    };
    const control = {
        stop: finish,
        abort: () => {
            cancelled = true;
            finish();
        },
    };
    recognition = control;
    try {
        if (call) stopSpeech();
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (released) {
            stream.getTracks().forEach(track => track.stop());
            if (recognition === control) recognition = null;
            return;
        }
        const chunks = [];
        recorder = new MediaRecorder(stream, { mimeType: type });
        recorder.ondataavailable = event => chunks.push(event.data);
        recorder.onstop = async () => {
            clearTimeout(timer);
            stream.getTracks().forEach(track => track.stop());
            if (recognition === control) recognition = null;
            $('listen').textContent = '开始说话';
            if (cancelled) return;
            sayStatus('正在转写…');
            try {
                const response = await fetch('api/transcription', { method: 'POST', body: new Blob(chunks, { type }) });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || '语音转写失败。');
                sayStatus();
                applySpeech(result.text, call);
            } catch (error) {
                sayStatus(error.message);
            }
        };
        recorder.start();
        timer = setTimeout(finish, 60000);
        $('listen').textContent = '结束并发送';
        sayStatus('正在录音…');
    } catch {
        stream?.getTracks().forEach(track => track.stop());
        if (recognition === control) recognition = null;
        if (!cancelled) sayStatus('无法录音，请检查麦克风权限。');
    }
}

$('library').onclick = () => returnTo(readingReturn);
function displayRoutes(rows) {
    const list = $('route-list');
    list.replaceChildren();
    for (const row of rows) {
        const line = element('div','','route-row');
        const label = row.customTitle ? row.title : savedTitle(row.title);
        const current = row.id === branch.id;
        const select = option(label,[current && '正在阅读',row.parent ? '分支' : '起点',dateLabel(new Date(row.created))].filter(Boolean).join(' · '),()=>{
            if (current) $('story-routes').close();
            else void activate(()=>request('branch/'+row.id),$('story-routes'));
        });
        select.classList.add('route-select');
        if (current) select.setAttribute('aria-current','true');
        const rename = element('button','改名','route-rename');
        rename.setAttribute('aria-label','重命名'+label);
        rename.onclick = () => {
            const field = $('route-name');
            field.value = label;
            $('route-form').dataset.id = row.id;
            $('route-error').textContent = '';
            open($('rename-route')); field.focus(); field.select();
        };
        line.append(select,rename); list.append(line);
    }
}
let routeVersion = 0;
$('story-history-link').onclick = async () => {
    if (!branch) return;
    const card = branch.card;
    const version = ++routeVersion;
    $('routes-title').textContent = selectedCard.title || selectedCard.name;
    displayRoutes(library.branches.filter(row=>row.card===card));
    open($('story-routes'));
    try {
        const rows = await request('branches?card='+encodeURIComponent(card));
        if (version!==routeVersion || card!==branch.card || !$('story-routes').open) return;
        library.branches = library.branches.filter(row=>row.card!==card).concat(rows);
        displayRoutes(rows);
    } catch (error) { feedback(error.message); }
};
$('rename-cancel').onclick = ()=>$('rename-route').close();
$('route-form').onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const field = $('route-name');
    if (!field.value.trim()) { $('route-error').textContent='请输入名称。'; field.focus(); return; }
    const save = form.querySelector('[type=submit]');
    save.disabled = true;
    try {
        const result = await (await api('branch/'+form.dataset.id,{title:field.value.trim()},undefined,'PATCH')).json();
        ++routeVersion;
        if (branch.id===result.id) { Object.assign(branch,result); renderHeader(); }
        Object.assign(library.branches.find(row=>row.id===result.id) || {},result);
        inboxTime = 0;
        displayRoutes(library.branches.filter(row=>row.card===branch.card));
        $('rename-route').close();
    } catch (error) { $('route-error').textContent=error.message; }
    finally { save.disabled=false; }
};
$('begin').onclick = () => selectedCard ? newBranch(selectedCard) : void showShelf();
$('inspect').onclick = () => showState(latestState());
$('phone').onclick = () => {
    $('call-name').textContent = selectedCard?.name || '角色';
    $('call-face').replaceChildren(avatar(selectedCard,selectedCard?.name));
    open($('call'));
    $('listen').hidden = nativePhone;
    if (nativePhone) {
        sayStatus('通话中，说完后对方会回答。');
        location.href = 'nightread-call://start';
    } else startListening(true);
};
$('call').onclose = () => {
    if (nativePhone) location.href = 'nightread-call://end';
    const previous = recognition;
    recognition = null;
    previous?.abort();
    stopSpeech();
    $('listen').textContent = '开始说话';
};
$('listen').onclick = () => startListening(true);
$('stop').onclick = () => turn?.abort();
$('music').onclick = () => {
    musicEnabled = !musicEnabled;
    $('music').setAttribute('aria-pressed', String(musicEnabled));
    $('music').textContent = musicEnabled ? '关闭背景音' : '背景音';
    if (!musicEnabled) playMusic('');
    drawPortrait();
};

let holdMic;
let held = false;
$('dictate').onpointerdown = event => {
    if (!event.isPrimary || event.button !== 0) return;
    $('dictate').setPointerCapture(event.pointerId);
    held = false;
    holdMic = setTimeout(() => {
        held = true;
        startListening();
    }, 350);
};
function releaseMic() {
    clearTimeout(holdMic);
    if (held) recognition?.stop();
}
$('dictate').onpointerup = releaseMic;
$('dictate').onpointercancel = releaseMic;
$('dictate').onclick = () => {
    if (!held) startListening();
    held = false;
};
input.addEventListener('input', resizeInput);
composer.addEventListener('submit', event => {
    event.preventDefault();
    void send(input.value);
});

const initialRoute=new URLSearchParams(location.search);
detailId=initialRoute.get('story');
const savedPage = history.state;
if (savedPage?.nightread && savedPage.page === 'reading' && savedPage.branch) {
    try {
        const [catalog,saved] = await Promise.all([request('library'),request('branch/'+savedPage.branch)]);
        library = catalog; catalogTime = Date.now();
        readingReturn = savedPage.returnPage || 'chat';
        detailId = saved.card;
        await loadBranch(saved); markPage('reading');
    } catch {
        history.replaceState(null,'',location.href);
        await showShelf('chat');
    }
} else {
    await showShelf(detailId ? 'detail' : ['history','books'].includes(initialRoute.get('page')) ? initialRoute.get('page') : 'chat');
}
if (window.isSecureContext && navigator.serviceWorker) void navigator.serviceWorker.register('sw.js').catch(() => {});
