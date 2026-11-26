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
let branch;
let turn;
let selectedCard;
let activePortrait;
let recognition;
let speech;
let speechVersion = 0;
let notice = '';
let opening = false;
let readingReturn = 'chat';

function element(tag, text = '', className = '') {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
}

async function api(path, data, signal) {
    const reply = await fetch('api/' + path, {
        method: data === undefined ? 'GET' : 'POST',
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
        node.loading = className === 'attachment' ? 'lazy' : 'eager';
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
    const variant = [state.动作, state.当前动作, state.着装, state.服装阶段, state.表情, state.当前表情]
        .map(key => typeof key === 'string' && Object.hasOwn(assets, key) ? assets[key] : null)
        .find(url => url && mediaType(url) !== 'audio');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const portrait = (reduceMotion ? null : variant || selectedCard?.motion) || selectedCard?.portrait;
    if (portrait !== activePortrait) {
        activePortrait = portrait;
        const visual = portrait ? image(portrait) : null;
        if (visual?.tagName === 'VIDEO' && selectedCard?.portrait) {
            const fallback = selectedCard.portrait;
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
    // Decode image variants during idle time and preload short video metadata.
    const assets = Object.values(card?.assets || {}).slice(0, 24);
    setTimeout(() => {
        if (selectedCard !== card) return;
        for (const url of assets) {
            if (mediaType(url) === 'img') new Image().src = url;
            else if (mediaType(url) === 'video') {
                const video = document.createElement('video');
                video.preload = 'metadata';
                video.src = url;
            }
        }
    }, 450);
}

function jump() { reading.scrollTop = reading.scrollHeight; }
const nearBottom = () => reading.scrollHeight - reading.scrollTop - reading.clientHeight < 104;
reading.addEventListener('scroll', () => { $('jump').hidden = nearBottom(); });
$('jump').onclick = jump;

function renderHeader() {
    $('route').textContent = branch?.title === '主线' && selectedCard?.title ? selectedCard.title : savedTitle(branch?.title || '夜读');
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

function messageNode(message, pending = false) {
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
    article.append(header, prose);
    if (!pending && message.role === 'assistant') {
        if (message.state && Object.keys(message.state).length) {
            const panel = element('details', '', 'turn-state');
            panel.open = true;
            panel.append(element('summary', '本轮状态'), fieldList(message.state));
            article.append(panel);
        }
    }
    for (const media of message.media || []) article.append(image('media/' + media.id, 'attachment', media.type === 'video'));
    return article;
}

function renderBranch(scroll = true) {
    $('messages').replaceChildren(...(branch?.messages || []).map(message => messageNode(message)));
    renderHeader();
    if (scroll) jump();
}

function remember() {
    try { localStorage.setItem('novel-branch', branch.id); } catch { /* Private browser mode. */ }
}

async function loadBranch(next) {
    branch = next;
    selectCard(library.cards.find(item => item.id === branch.card));
    remember();
    renderBranch();
}

function option(label, note, action) {
    const button = element('button', '', 'button choice');
    button.append(element('span', label, 'choice-name'), ...(note ? [element('small', note)] : []));
    button.onclick = action;
    return button;
}

async function activate(operation, dialog) {
    if (turn || opening) return;
    opening = true;
    sayStatus();
    try {
        const next = await operation();
        await loadBranch(next);
        if (dialog === $('shelf')) {
            readingReturn = document.body.dataset.view === 'history' ? 'history' : 'chat';
            const backLabel = readingReturn === 'history' ? '返回历史剧本' : '返回聊天库';
            $('library').setAttribute('aria-label',backLabel);
            $('library').title = backLabel;
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
    }
}

function newBranch(card) {
    if (card) void activate(() => request('branches', { card: card.id }), $('shelf'));
}

function markPage(page) {
    document.body.dataset.view = page;
    document.querySelector('.shell').inert = page !== 'reading';
    $('find-chats').hidden = page !== 'chat';
    for (const button of $('dock').children) button.setAttribute('aria-current',button.dataset.page===page?'page':'false');
}
$('dock').onclick = event => {
    const page=event.target.closest('button')?.dataset.page;
    if (!page) return;
    void showShelf(page);
};
$('shelf').onclose = () => {
    if ($('shelf').open) return;
    markPage('reading');
    $('reading').focus({ preventScroll:true });
};
window.novelBack = () => {
    for (const id of ['call','actions','status']) {
        if ($(id).open) { $(id).close(); return true; }
    }
    if (turn || opening) return true;
    if (document.body.dataset.view === 'reading') { void showShelf(readingReturn); return true; }
    if (document.body.dataset.view !== 'chat') { void showShelf('chat'); return true; }
    const search = $('shelf-content').querySelector('.inbox-search');
    if (search && !search.hidden) { $('find-chats').click(); return true; }
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
    const stamp = /(?:^| - )(\d{4})-(\d{2})-(\d{2})@(\d{2})h(\d{2})m\d{2}s\d*ms$/.exec(title);
    return stamp ? `${Number(stamp[2])}月${Number(stamp[3])}日 ${stamp[4]}:${stamp[5]} 的对话` : title;
}

function renderInbox(menu, entries) {
    const search = element('input', '', 'book-search inbox-search');
    search.type = 'search';
    search.hidden = true;
    search.placeholder = '搜索角色、剧本或消息';
    search.setAttribute('aria-label', search.placeholder);
    const find = $('find-chats');
    find.setAttribute('aria-expanded','false');
    find.onclick = () => {
        search.hidden = !search.hidden;
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
    let onlyForks = false;
    for (const [label, forksOnly] of [['全部',false],['有分支',true]]) {
        const tab = element('button', label);
        tab.type = 'button';
        tab.setAttribute('aria-pressed', String(!forksOnly));
        tab.onclick = () => {
            onlyForks = forksOnly;
            for (const other of tabs.children) other.setAttribute('aria-pressed',String(other === tab));
            filter();
        };
        tabs.append(tab);
    }
    for (const entry of entries) {
        const story = library.cards.find(card => card.id === entry.card);
        const name = story?.name || entry.title;
        const preview = (entry.preview || '').replace(/\*+/g,'').replace(/\s+/g,' ').trim();
        const row = element('button', '', 'inbox-row');
        row.type = 'button';
        row.dataset.forked = String(forks.has(entry.card));
        row.dataset.search = [name, story?.title, preview].filter(Boolean).join(' ').toLocaleLowerCase();
        row.onclick = () => activate(() => request('branch/' + entry.id), $('shelf'));
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
        list.append(row);
    }
    function filter() {
        const term = search.value.trim().toLocaleLowerCase();
        let visible = 0;
        for (const row of list.children) {
            row.hidden = !row.dataset.search.includes(term) || (onlyForks && row.dataset.forked !== 'true');
            if (!row.hidden) visible++;
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
    if (turn || opening) return;
    opening = true;
    try {
        library = await request('library');
        const menu = $('shelf-content');
        menu.ondragover = menu.ondrop = null;
        if (page==='chat') {
            const entries=await request('inbox');
            $('shelf').querySelector('h2').textContent='聊天库';
            renderInbox(menu, entries);
            markPage('chat');
            if (!$('shelf').open) $('shelf').show();
            $('shelf').scrollTop=0;
            return;
        }
        const showHistory=page==='history';
        $('shelf').querySelector('h2').textContent=showHistory?'历史剧本':'剧本库';
        markPage(showHistory?'history':'books');
        if (showHistory) renderHistory(menu);
        else renderLibrary(menu);
        if (!$('shelf').open) $('shelf').show();
        $('shelf').scrollTop=0;
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
    }
}

function renderLibrary(menu) {
    const books = element('section');
    menu.replaceChildren(books);
    const chooser = element('input');
    chooser.type = 'file';
    chooser.accept = '.json,.png';
    chooser.hidden = true;
    const management = element('details','','library-management');
    management.append(element('summary','管理剧本'));
    const importButton = option('导入剧本', '', () => chooser.click());
    management.append(chooser,importButton);
    const search = element('input','','book-search');
    search.type='search';
    search.placeholder='搜索剧本或角色';
    search.setAttribute('aria-label',search.placeholder);
    const progress = element('p','','import-progress');
    progress.setAttribute('role','status');
    async function importFile(file) {
        if (!file || importButton.disabled) return;
        importButton.disabled = true;
        progress.textContent = '正在读入原稿并翻译，请稍候…';
        try {
            const response = await fetch('api/import-card',{method:'POST',body:file});
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || '导入失败');
            await showShelf();
        } catch { progress.textContent = '无法导入这张剧本卡，请检查文件后重试。'; }
        finally { importButton.disabled = false; chooser.value = ''; }
    }
    chooser.onchange = () => importFile(chooser.files[0]);
    menu.ondragover = event => event.preventDefault();
    menu.ondrop = event => { event.preventDefault(); void importFile(event.dataTransfer.files[0]); };
    const browse = element('div','','book-tools');
    browse.append(search,management);
    books.append(browse,progress);
    search.oninput=()=>{
        const query=search.value.trim().toLocaleLowerCase();
        for(const item of books.querySelectorAll('.book-card'))
            item.hidden=!item.textContent.toLocaleLowerCase().includes(query);
    };
    if (!library.cards.length) menu.append(element('p', '在电脑端导入角色卡后，角色会显示在这里。'));
    for (const card of library.cards) {
        const label = card.title ? `${card.title} · ${card.name}` : card.name;
        const button = option(label, '', () => newBranch(card));
        button.setAttribute('aria-label', label+' 新故事');
        button.querySelector('.choice-name').textContent=card.title || card.name;
        const item = element('section','','book-card');
        const cover = element('button','','book-cover');
        cover.setAttribute('aria-label','开始阅读' + (card.title || card.name));
        cover.onclick = () => newBranch(card);
        cover.append(card.portrait && mediaType(card.portrait)==='img' ? image(card.portrait) : avatar(card,card.name));
        const copy = element('div','','book-copy');
        item.append(cover,copy);
        copy.append(button);
        if (card.title) copy.append(element('p',card.name,'book-character'));
        const info = element('details','','book-details');
        info.append(element('summary','故事简介'));
        const teaser = () => (card.background || card.description || '').split('\n')[0];
        const description = element('p',card.needsTranslation ? '正在翻译剧本…' : teaser());
        description.className='book-preview';
        copy.append(description);
        const fullDescription = element('p');
        const background = element('p');
        function updateDetails() {
            fullDescription.textContent = card.needsTranslation ? '' : card.description;
            background.textContent = card.needsTranslation ? '' : card.background;
            background.hidden = !background.textContent;
        }
        updateDetails();
        info.append(fullDescription,background);
        const copies = element('div','','book-copies');
        for (const [kind,label] of [['original','导出原文'],['zh','导出中文版']]) {
            const link = element('a',(card.title || card.name)+' · '+label);
            link.href = 'api/card-copy/'+encodeURIComponent(card.id)+'/'+kind;
            link.download = '';
            copies.append(link);
        }
        management.append(copies);
        const gallery = element('div','','book-gallery');
        info.ontoggle = () => {
            if (!info.open || gallery.childElementCount) return;
            for (const url of [card.portrait,...(card.gallery || []),card.motion].filter(Boolean)) {
                gallery.append(image(url,'',mediaType(url) === 'video'));
            }
        };
        info.append(gallery);
        copy.append(info);
        books.append(item);
        if (card.needsTranslation) request('translate',{card:card.id}).then(async () => {
            if (!item.isConnected) return;
            const updated = (await request('library')).cards.find(row => row.id === card.id);
            if (!updated) return;
            Object.assign(card,updated);
            button.setAttribute('aria-label',(card.title ? card.title+' · '+card.name : card.name)+' 新故事');
            button.querySelector('.choice-name').textContent=card.title || card.name;
            const character=copy.querySelector('.book-character');
            if(character) character.textContent=card.name;
            description.textContent = teaser();
            updateDetails();
        }).catch(error => { description.textContent = error.message; });
    }
}

function renderHistory(menu) {
    const list = element('section');
    menu.replaceChildren(list);
    const order = [...library.branches].sort((a,b) => (b.lastActivity ?? b.created) - (a.lastActivity ?? a.created));
    const ids = new Set([...order.map(row => row.card), ...library.cards.filter(card => card.imports.length).map(card => card.id)]);
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
            const button = option(savedTitle(saved.title),when,() => activate(() => request('branch/' + saved.id),$('shelf')));
            button.setAttribute('aria-label',[savedTitle(saved.title),name,when].filter(Boolean).join(' · '));
            button.style.setProperty('--depth', Math.min(depth,4));
            if (saved.id === branch?.id) button.setAttribute('aria-current','true');
            group.append(button);
            pending.push(...(children.get(saved.id) || []).map(child => [child,depth + 1]).reverse());
        }
        if (older.length) group.append(element('h3','旧酒馆记录','history-subheading'));
        for (const title of older) {
            group.append(option(savedTitle(title),'导入',() => activate(
                () => request('branches',{card:id,importTitle:title}),$('shelf'))));
        }
    }
}

function fieldList(value, level = 0) {
    const list = element('div', '', 'fields');
    if (level > 12) return list;
    for (const [name, entry] of Object.entries(value)) {
        const label = displayStateLabel(name);
        const meter = readMeter(name, entry);
        if (!meter && isObject(entry)) {
            const group = element('fieldset', '', 'field-group');
            group.append(element('legend', label), fieldList(entry, level + 1));
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
    if (turn || opening || $('actions').open) return;
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
    open($('actions'));
}

async function createMedia(kind, message) {
    if (opening) return;
    $('actions').close();
    sayStatus(kind === 'image' ? '正在生成配图…' : '正在生成视频…');
    await activate(() => request(kind + '/' + branch.id, { position: message.position }));
}

function updateControls() {
    for(const button of $('dock').children) button.disabled=Boolean(turn);
    input.readOnly = Boolean(turn);
    $('send').hidden = Boolean(turn);
    $('stop').hidden = !turn;
    $('dictate').disabled = Boolean(turn);
    $('listen').disabled = Boolean(turn);
}

async function send(text) {
    if (!text.trim() || !branch || turn || opening) return;
    const abort = new AbortController();
    turn = abort;
    updateControls();
    sayStatus('正在续写…');
    const target = $('messages');
    const user = messageNode({ role: 'user', text }, true);
    const reply = messageNode({ role: 'assistant', text: '…' }, true);
    target.append(user, reply);
    const prose = reply.querySelector('.prose');
    jump();
    try {
        const response = await api('turn/' + branch.id, { text, position: branch.messages.length }, abort.signal);
        const frames = response.body.pipeThrough(new TextDecoderStream());
        let pending = '';
        let complete;
        for await (const chunk of frames) {
            const lines = (pending + chunk).split('\n');
            pending = lines.pop();
            for (const line of lines) {
                if (!line) continue;
                const event = JSON.parse(line);
                if (event.error) throw new Error(event.error);
                if (event.status) sayStatus(event.status);
                if (typeof event.text === 'string') {
                    const follow = nearBottom();
                    prose.textContent = event.text;
                    if (follow) jump();
                }
                if (event.done) complete = event.done;
            }
        }
        if (!complete) throw new Error('连接中断，请重试。');
        const follow = nearBottom();
        branch = complete;
        input.value = '';
        resizeInput();
        renderBranch(follow);
        sayStatus();
        if ($('call').open) {
            const last = branch.messages.at(-1);
            if (nativePhone) location.href = 'nightread-call://reply?text=' + encodeURIComponent(last.dialogue || last.text);
            else await readDialogue(last);
        }
    } catch (error) {
        user.remove();
        reply.remove();
        input.value = text;
        resizeInput();
        try {
            const latest = await request('branch/' + branch.id);
            if (latest.messages.length > branch.messages.length) {
                branch = latest;
                input.value = '';
                renderBranch();
            }
        } catch { /* Keep the draft and branch visible if reconnection fails. */ }
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

$('library').onclick = () => showShelf(readingReturn);
$('story-history-link').onclick = () => showShelf('history');
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

await showShelf(new URLSearchParams(location.search).get('page') === 'history' ? 'history' : 'chat');
if (window.isSecureContext && navigator.serviceWorker) void navigator.serviceWorker.register('sw.js').catch(() => {});
