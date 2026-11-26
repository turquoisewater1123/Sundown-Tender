import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const live = process.argv.includes('--live');
const scratch = await mkdtemp(resolve('logs/novel-qa-'));
process.env.NOVEL_DATA_DIR = scratch;
process.env.NOVEL_QA_CLEANUP = '1';
const settings = JSON.parse(await readFile('Novel/settings.json', 'utf8'));
const mock = createServer(async (req, res) => {
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    const input = Buffer.concat(buffers);
    if (req.url === '/transcribe') {
        assert.match(input.toString(), /filename="voice.webm"/);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"text":"收到录音"}');
        return;
    }
    if (req.url === '/image') {
        res.writeHead(200, { 'Content-Type': 'image/png' }).end(await readFile('Novel/public/icon-192.png'));
        return;
    }
    if (req.url === '/video') {
        assert.ok(JSON.parse(input).image_base64);
        res.writeHead(200, { 'Content-Type': 'video/mp4' }).end(Buffer.from('mock video'));
        return;
    }
    if (req.url === '/tts') {
        assert.match(JSON.parse(input).text, /我听见了/);
        res.writeHead(200, { 'Content-Type': 'audio/wav' }).end(Buffer.from('mock audio'));
        return;
    }
    assert.match(JSON.parse(input).messages[0].content, /必须使用简体中文/);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    for (const chunk of ['窗外传来声响。', '\n「我听见了。」\n', '`', '``scene-state\n',
        '{"线索":{"旧录音带":"待检查"},"信任":"40%","气氛":["紧张","寂静"]}', '\n```']) {
        res.write(JSON.stringify({ message: { content: chunk } }) + '\n');
        await delay(170);
    }
    res.end('{"done":true}\n');
});
await new Promise(done => mock.listen(0, '127.0.0.1', done));
if (!live) {
    const base = 'http://127.0.0.1:' + mock.address().port;
    settings.text = {protocol:'ollama',url:base + '/chat',model:'test',context:8192,output:512};
    settings.transcription = { url: base + '/transcribe' };
    settings.image = { url: base + '/image' };
    settings.video = { url: base + '/video' };
    settings.speech = { url: base + '/tts' };
}
process.env.NOVEL_SETTINGS = join(scratch, 'settings.json');
await writeFile(process.env.NOVEL_SETTINGS, JSON.stringify(settings));
const { handleNovel, closeNovelData } = await import('../../Novel/server.mjs');
const server = createServer(handleNovel);
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
    args: ['--no-proxy-server', '--disable-background-networking'],
});
try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true,
        hasTouch: true, deviceScaleFactor: 2 });
    const page = await context.newPage();
    // Card translation is exercised against the local model in a separate import test.
    await page.route('**/api/translate', route => route.fulfill({json:{ok:true}}));
    page.on('pageerror', error => console.error('Browser:', error.message));
    await page.goto(origin + '/novel/');
    await page.locator('#shelf').getByRole('heading',{name:'聊天库'}).waitFor();
    await page.getByRole('button',{name:'剧本库',exact:true}).click();
    if (live) await page.screenshot({ path: resolve('logs/novel-mobile-home.png') });
    await page.locator('#shelf').getByRole('heading', { name: '剧本库' }).waitFor();
    await page.getByRole('button', { name: '历史剧本',exact:true }).click();
    await page.locator('#shelf').getByRole('heading', { name: '历史剧本' }).waitFor();
    await page.getByRole('button', { name: '聊天库',exact:true }).click();
    await page.locator('#shelf').getByRole('heading', { name:'聊天库' }).waitFor();
    await page.getByRole('button', { name: '剧本库',exact:true }).click();
    await page.locator('#shelf').getByRole('heading', { name: '剧本库' }).waitFor();
    await page.screenshot({path:resolve('logs/novel-library-navigation.png')});
    assert.equal(await page.getByRole('button', {name:'导入剧本',exact:true}).isVisible(),false);
    await page.getByRole('searchbox').fill('林岚');
    assert.equal(await page.getByRole('button', {name:/最后一次广播/}).isVisible(),false);
    await page.getByRole('button', { name: '林岚 新故事' }).click();
    await page.locator('.messages article').first().waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('.assistant .message-avatar img')?.naturalWidth === 240);
    assert.equal(await page.locator('#dock').isVisible(),false);
    assert.doesNotMatch(await page.locator('.messages').innerText(), /`{3}|\{"好感度/);
    await page.getByRole('button', { name: '剧情状态' }).click();
    assert.match(await page.locator('#fields').innerText(), /好感度\s+35%/);
    await page.locator('#status').getByRole('button', { name: '关闭' }).click();
    await page.evaluate(() => {
        window.novelStreamSamples = [];
        const messages = document.querySelector('#messages');
        new MutationObserver(() => window.novelStreamSamples.push(messages.innerText)).observe(messages,
            { childList: true, subtree: true, characterData: true });
    });
    await page.locator('#input').fill('我听见有人在念旧台呼。你先告诉我，那台旧录音机还能用吗？');
    await page.getByRole('button', { name: '发送' }).click();
    await page.getByRole('button', { name: '停止' }).waitFor({ state: 'hidden', timeout: 180000 });
    assert.equal(await page.locator('.messages article').count(), 3, await page.locator('#notice').innerText());
    assert.equal(await page.locator('.messages article.assistant .turn-state').count(), 2);
    assert.equal(await page.getByRole('button',{name:'更换我的头像'}).innerText(),'我');
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({path:resolve('logs/novel-conversation-mobile.png')});
    if (!live) {
        await page.locator('#reader-photo').setInputFiles('Novel/packs/01-last-broadcast/face.jpg');
        await page.waitForFunction(() => document.querySelector('.change-face img')?.naturalWidth === 240);
        const profile = await (await context.request.get(origin + '/novel/api/library')).json();
        assert.match(profile.readerFace,/api\/reader-avatar/);
    }
    const samples = await page.evaluate(() => window.novelStreamSamples);
    assert.ok(samples.length > 3, 'Browser received multiple streaming updates');
    assert.ok(samples.every(sample => !/`{2,}|scene-state|\{"[^"]+"\s*:/u.test(sample)), 'Raw state never rendered');
    assert.match(await page.locator('.messages article').last().innerText(), /\p{Script=Han}/u);
    await page.getByRole('button', { name: '剧情状态' }).click();
    const fields = await page.locator('#fields').innerText();
    if (!live) assert.match(fields, /旧录音带\s+待检查[\s\S]+信任\s+40%[\s\S]+紧张/);
    else assert.ok(await page.locator('#fields .field').count() > 4, 'Local AI generated new story fields');
    if (live) await page.screenshot({ path: resolve('logs/novel-mobile-state.png') });
    await page.locator('#status').getByRole('button', { name: '关闭' }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    const original = await page.evaluate(() => localStorage.getItem('novel-branch'));
    if (!live) {
        const post = async (route, data) => context.request.post(origin + '/novel/api/' + route, { data });
        assert.equal((await post('speech/' + original, { position: 2 })).headers()['content-type'], 'audio/wav');
        const image = await (await post('image/' + original, { position: 2 })).json();
        assert.equal(image.messages[2].media[0].type, 'image');
        const video = await (await post('video/' + original, { position: 2 })).json();
        const asset = video.messages[2].media.at(-1);
        const ranged = await context.request.get(origin + '/novel/media/' + asset.id, { headers: { Range: 'bytes=0-3' } });
        assert.equal(ranged.status(), 206);
        assert.equal(await ranged.text(), 'mock');
        const stt = await context.request.post(origin + '/novel/api/transcription', {
            headers: { 'Content-Type': 'audio/webm' }, data: Buffer.from('mock recording'),
        });
        assert.equal((await stt.json()).text, '收到录音');
        assert.equal((await post('turn/' + original, { text: '旧页面重复发送', position: 1 })).status(), 409);
        const library = await (await context.request.get(origin + '/novel/api/library')).json();
        const card = library.cards.find(item => item.name === '林岚');
        const imported = await post('branches', { card: card.id, importTitle: card.imports[0] });
        assert.equal(imported.status(), 201);
        assert.ok((await imported.json()).messages.length > 0);
        await page.setViewportSize({ width: 320, height: 640 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);
    }
    await page.locator('.messages article').first().getByRole('button').click();
    await page.getByRole('button', { name: '从这里新建分支' }).click();
    await page.getByText('第 1 条的分支', { exact: true }).waitFor();
    assert.equal(await page.locator('.messages article').count(), 1);
    await page.reload();
    await page.locator('.inbox-row').first().click();
    await page.getByText('第 1 条的分支', { exact: true }).waitFor();
    await page.getByRole('button', { name:'查看当前剧本的历史' }).click();
    await page.locator('#shelf').getByRole('heading', {name:'历史剧本'}).waitFor();
    await page.screenshot({path:resolve('logs/novel-history-mobile.png')});
    await page.getByRole('button', { name: '主线 · 林岚' }).click();
    await page.locator('.messages article').nth(2).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('novel-branch')), original);
    await page.getByRole('button',{name:'返回历史剧本'}).click();
    await page.locator('#shelf').getByRole('heading',{name:'历史剧本'}).waitFor();
    await page.getByRole('button',{name:'聊天库',exact:true}).click();
    const inboxRow=page.locator('.inbox-row').filter({hasText:'林岚'});
    await inboxRow.waitFor();
    assert.equal(await inboxRow.count(),1);
    await page.screenshot({path:resolve('logs/novel-inbox-mobile.png')});
    await inboxRow.click();
    await page.locator('#shelf').waitFor({state:'hidden'});
    if (!live && process.argv.includes('--packs')) {
        const catalog = await (await context.request.get(origin + '/novel/api/library')).json();
        const packs = catalog.cards.filter(card => card.id.startsWith('pack:'));
        assert.equal(packs.length, 6);
        for (const pack of packs) {
            assert.ok(pack.title && pack.portrait && pack.motion);
            assert.equal((await context.request.head(origin + '/novel/' + pack.portrait)).status(), 200);
            const loaded = await page.evaluate(source => new Promise((done, reject) => {
                const player = document.createElement('video');
                const timer = setTimeout(() => reject(new Error('Media verification timed out')), 8000);
                player.onerror = () => { clearTimeout(timer); reject(player.error); };
                player.onloadeddata = () => {
                    clearTimeout(timer);
                    done({ width: player.videoWidth, height: player.videoHeight, duration: player.duration });
                    player.removeAttribute('src');
                    player.load();
                };
                player.src = source;
                player.load();
            }), pack.motion);
            assert.equal(loaded.height, 1080);
            assert.ok(loaded.duration >= 3.5 && loaded.duration < 4.5, JSON.stringify(loaded));
        }
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole('button', { name:'返回聊天库' }).click();
        await page.getByRole('button', { name: '剧本库',exact:true }).click();
        await page.getByRole('button', { name: '借我一场流星雨 · 孟星慈 新故事' }).click();
        await page.locator('#portrait video').waitFor();
        await page.waitForFunction(() => document.querySelector('#portrait video').currentTime > 0.2);
        await page.screenshot({ path: resolve('logs/novel-pack-mobile.png') });
        await page.getByRole('button', { name: '剧情状态' }).click();
        assert.match(await page.locator('#fields').innerText(), /音频异常[\s\S]+未来日期/);
        console.log('Passed six pack covers and animated MP4s, mobile playback, and dynamic opening state.');
    }
    console.log(`Passed ${live ? 'local AI' : 'mock providers'}: character cards, streaming, styled state, branch reload, 390px viewport.`);
} finally {
    await browser.close();
    server.close();
    mock.close();
    await closeNovelData();
    if (dirname(scratch) === resolve('logs') && basename(scratch).startsWith('novel-qa-')) {
        await rm(scratch, { recursive: true, force: true });
    }
}
