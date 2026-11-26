import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { stripSceneStatusForDisplay } from '../../assets/scene-status/status.mjs';

const historyDir = 'SillyTavern/data/default-user/chats/Rei Kaito';
const file = (await readdir(historyDir)).find(name => name.endsWith('23h46m18s545ms.jsonl'));
assert.ok(file, 'Expected the saved Rei chat where the old display leaked JSON');
const path = resolve(historyDir, file);
const original = await readFile(path, 'utf8');
const messages = original.trim().split(/\r?\n/).map(JSON.parse).slice(1);
const leaking = messages.flatMap((message, index) => {
    const marker = message.mes?.indexOf('```scene-state ');
    return !message.is_user && marker >= 0 ? [{ index, source: message.mes, marker }] : [];
});
assert.ok(leaking.some(item => item.source.indexOf('```', item.marker + 3) === -1), 'Missing the unclosed inline fence');
assert.ok(leaking.some(item => item.source.indexOf('```', item.marker + 3) >= 0), 'Missing the closed inline fence');
for (const { source, marker } of leaking) {
    const prose = source.slice(0, marker).trimEnd();
    assert.equal(stripSceneStatusForDisplay(source), prose);
    for (let end = marker + '```scene-state'.length; end <= source.length; end++) {
        assert.equal(stripSceneStatusForDisplay(source.slice(0, end)), prose, `Streaming leaked JSON at offset ${end}`);
    }
}

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
    await page.route('**/api/chats/save', route => route.fulfill({ status: 200, json: { result: 'ok' } }));
    await page.route('**/api/characters/edit', route => route.fulfill({ status: 200, body: 'Rei Kaito.png' }));
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SillyTavern?.getContext()?.characters?.some(c => c.name === 'Rei Kaito'));
    await page.evaluate(async name => {
        const c = SillyTavern.getContext();
        await c.selectCharacterById(c.characters.findIndex(item => item.name === 'Rei Kaito'), { switchMenu: false });
        await c.openCharacterChat(name);
    }, file.slice(0, -6));
    const panel = page.locator('#local-scene-status');
    if (await panel.getAttribute('open') === null) await panel.locator('summary').tap();
    await panel.getByRole('heading', { name: 'Rei Kaito' }).waitFor({ state: 'visible' });
    await panel.getByText('衣着', { exact: true }).first().waitFor({ state: 'visible' });
    const asset = await page.locator('#sheld').evaluate(node => getComputedStyle(node).backgroundImage);
    assert.match(asset, /Rei%20Kaito\.png/);
    await page.waitForFunction(() => document.querySelector('.scene-avatar')?.naturalWidth > 0);
    for (const { index, source } of leaking) {
        const body = page.locator(`#chat .mes[mesid="${index}"] .mes_text`);
        assert.ok((await body.innerText()).trim(), 'Prose must still render');
        assert.doesNotMatch(await body.innerText(), /scene-state|"(?:location|clothing|mood|thoughts|actions)"\s*:/i);
        assert.equal(await page.evaluate(i => window.SillyTavern.getContext().chat[i].mes, index), source);
    }
    for (const width of [390, 360]) {
        await page.setViewportSize({ width, height: 844 });
        const position = await panel.boundingBox();
        assert.ok(position && position.x < 16 && position.x + position.width < width);
        const composer = await page.locator('#send_textarea').boundingBox();
        assert.ok(composer && composer.width > 205 && composer.y >= position.y + position.height);
    }
    await page.locator('#local-scene-status summary').tap();
    assert.equal(await panel.getAttribute('open'), null);
    assert.equal(await readFile(path, 'utf8'), original);
    console.log(JSON.stringify({
        character: 'Rei Kaito', historyReplies: leaking.length, viewports: [390, 360],
        inlineJSON: 'absent', storage: 'unchanged', portrait: 'loaded', layout: 'left status card, unobstructed composer',
    }));
} finally {
    await browser.close();
}
