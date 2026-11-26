import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { displayStateLabel, isChineseState, parseSceneStatus, stripSceneStatusForDisplay } from '../../assets/scene-status/status.mjs';

const origin = 'http://192.168.3.12:8001';
const login = JSON.parse(await readFile('mobile-access.json', 'utf8'));
const browser = await chromium.launchPersistentContext(resolve('runtime/browser-profile'), {
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, isMobile: true, hasTouch: true,
    viewport: { width: 390, height: 844 },
    httpCredentials: { ...login, origin },
    args: ['--no-proxy-server'],
});

try {
    const page = await browser.newPage();
    page.on('pageerror', error => console.error(error.message));
    await page.route('**/api/chats/save', route => route.fulfill({ status: 200, json: { result: 'ok' } }));
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SillyTavern?.getContext()?.characters?.some(c => c.name === 'Rei Kaito'));
    await page.evaluate(async () => {
        const c = SillyTavern.getContext();
        await c.selectCharacterById(c.characters.findIndex(item => item.name === 'Rei Kaito'), { switchMenu: false });
    });
    const panel = page.locator('#local-scene-status');
    if (!process.argv.includes('--formats-only')) {
    await page.waitForFunction(() => SillyTavern.getContext().onlineStatus === 'roleplay-qwen35:9b-q4');
    const before = await page.evaluate(() => SillyTavern.getContext().chat.length);
    const response = page.waitForResponse(r => r.url().endsWith('/api/backends/text-completions/generate') &&
        r.request().postDataJSON()?.stream === true,
        { timeout: 65000 }).catch(() => null);
    await page.locator('#send_textarea').fill('先留在这个包厢里。Rei，我想听你说说现在的心情和你想怎么继续。正文简短一点，我自己决定下一步。');
    await page.evaluate(() => window.SillyTavern.getContext().generate('normal'));
    const streamed = await response;
    assert.ok(streamed, (await page.locator('.toast-error').allTextContents()).join(' ') || 'No generation response');
    assert.equal(streamed.status(), 200);
    const request = streamed.request().postDataJSON();
    for (const text of ['Rei Kaito', '成人剧本状态面板', '硬性语言要求', '亲密接触或身体反应']) {
        assert.ok(request.prompt.includes(text), `Prompt is missing ${text}`);
    }
    assert.match(await streamed.text(), /data: \[DONE\]/);
    await page.waitForFunction(count => {
        const c = window.SillyTavern.getContext();
        const latest = c.chat.at(-1);
        return c.chat.length > count && !latest?.is_user && Boolean(latest?.mes?.trim());
    }, before, { timeout: 45000 });
    let message = await page.evaluate(() => window.SillyTavern.getContext().chat.at(-1));
    const names = ['Rei Kaito', 'Rei', 'User'];
    const inline = parseSceneStatus(message.mes);
    if (!isChineseState(inline, names)) {
        await page.waitForFunction(() => Boolean(window.SillyTavern.getContext().chat.at(-1).extra?.local_scene_status?.fields),
            undefined, { timeout: 70000 });
        message = await page.evaluate(() => window.SillyTavern.getContext().chat.at(-1));
    }
    const fields = message.extra?.local_scene_status?.fields || inline;
    assert.ok(isChineseState(fields, names), 'The original Rei card must produce Chinese state fields and values');
    assert.ok(isChineseState({ 正文: stripSceneStatusForDisplay(message.mes) }, names), 'Dialogue must be in Chinese');
    const keys = Object.keys(fields).map(displayStateLabel);
    assert.ok(keys.length >= 5, keys.join('、'));
    assert.ok(keys.some(k => /衣|身|亲密|关系|界限|意愿|兴奋|态度/.test(k)), keys.join('、'));
    if (await panel.getAttribute('open') === null) await panel.locator('summary').tap();
    for (const key of keys) await panel.getByText(key, { exact: true }).first().waitFor({ state: 'visible' });
    if (inline) {
        assert.equal(await page.locator('#chat .mes').last().locator('.mes_text pre').count(), 0);
    }
    console.log(JSON.stringify({ character: 'Rei Kaito', model: request.model, fields: keys, mobileStatus: 'visible', source: inline ? 'reply' : 'follow-up extraction' }));
    if (process.argv.includes('--live-screenshot')) {
        const height = await panel.evaluate(node => node.scrollHeight);
        if (height > 540) {
            await page.setViewportSize({ width: 390, height: Math.max(844, height + 80) });
            await panel.evaluate(node => { node.style.maxHeight = 'none'; });
        }
        await panel.screenshot({ path: 'logs/rei-live-status.png' });
    }
    }

    const fixture = {
        场景: '测试用包厢',
        Rei: {
            乳头坚硬程度: { value: 2, max: 5, note: '显示测试' },
            小穴湿润度: '未提及',
            关系变化: '41%',
            当前态度: ['警觉', '试探'],
        },
        其他人物在场: false,
    };
    async function showFixture(sample, bare = false) {
        const state = bare ? JSON.stringify({ scene_status: sample }) :
            '```scene-state\n' + JSON.stringify(sample) + '\n```';
        const mes = '这是一条界面测试。\n\n' + state;
        await page.evaluate(async text => {
            const c = window.SillyTavern.getContext();
            if (c.name2 !== 'Rei Kaito') throw new Error('Wrong character selected');
            const message = { name: c.name2, is_user: false, is_system: false, mes: text,
                send_date: new Date().toISOString(), extra: {} };
            c.chat.push(message);
            c.addOneMessage(message);
            await c.eventSource.emit(c.eventTypes.MESSAGE_RECEIVED, c.chat.length - 1, 'normal');
        }, mes);
        const body = page.locator('#chat .mes').last().locator('.mes_text');
        await body.getByText('这是一条界面测试。', { exact: true }).waitFor({ state: 'visible' });
        assert.equal((await body.innerText()).trim(), '这是一条界面测试。');
        assert.ok(await page.evaluate(text => window.SillyTavern.getContext().chat.at(-1).mes === text, mes));
    }
    await showFixture(fixture);
    if (await panel.getAttribute('open') === null) await panel.locator('summary').tap();
    await panel.getByText('小穴湿润度', { exact: true }).waitFor({ state: 'visible' });
    assert.equal(await panel.getByRole('progressbar', { name: '乳头坚硬程度' }).getAttribute('value'), '2');
    assert.equal(await panel.getByRole('progressbar', { name: '乳头坚硬程度' }).getAttribute('max'), '5');
    assert.equal(await panel.getByRole('progressbar', { name: '关系变化' }).getAttribute('max'), '100');
    for (const label of ['0', '41%', '警觉', '试探', '否']) {
        await panel.getByText(label, { exact: true }).waitFor({ state: 'visible' });
    }
    if (process.argv.includes('--screenshot')) {
        await page.addStyleTag({ content: '#chat .mes:not(:last-child) { visibility: hidden; }' });
        await page.waitForFunction(() => document.querySelector('.scene-avatar')?.naturalWidth > 0);
        await page.screenshot({ path: 'logs/rei-mobile-layout.png' });
    }
    const next = {
        场景: '测试用走廊',
        Rei: { 乳头坚硬程度: { value: 3, max: 5 }, 情绪说明: '第二轮出现的新字段。'.repeat(12) },
    };
    await showFixture(next, true);
    assert.equal(stripSceneStatusForDisplay('剧情。\n\n```scene-state\n{"场景":"更'), '剧情。');
    const ordinary = '代码示例。\n```json\n{"port":8000}\n```';
    assert.equal(stripSceneStatusForDisplay(ordinary), ordinary);
    await panel.getByText('情绪说明', { exact: true }).waitFor({ state: 'visible' });
    assert.equal(await panel.getByText('小穴湿润度', { exact: true }).count(), 0);
    assert.equal(await panel.locator('.scene-up').count(), 1);
    const sizes = [];
    for (const width of [390, 360]) {
        await page.setViewportSize({ width, height: 844 });
        const box = await panel.boundingBox();
        const composer = await page.locator('#send_textarea').boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= width);
        assert.ok(composer && composer.width >= 200 && composer.x + composer.width <= width);
        assert.equal(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
        sizes.push(width);
    }
    await panel.locator('summary').tap();
    assert.equal(await panel.getAttribute('open'), null);
    console.log(JSON.stringify({ character: 'Rei Kaito', fixture: true, viewports: sizes,
        verified: ['text', 'range', 'percentage', 'tags', 'boolean', 'groups', 'field changes', 'direction', 'hidden JSON'] }));
} finally {
    await browser.close();
}
