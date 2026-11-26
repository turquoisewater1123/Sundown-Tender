import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { parseSceneStatus, readMeter } from '../../assets/scene-status/status.mjs';

const origin = 'http://192.168.3.12:8001';
const login = JSON.parse(await readFile('mobile-access.json', 'utf8'));
const browser = await chromium.launchPersistentContext(resolve('runtime/browser-profile'), {
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, isMobile: true, hasTouch: true,
    viewport: { width: 390, height: 844 },
    httpCredentials: { ...login, origin },
    args: ['--no-proxy-server'],
});

const fixture = {
    地点: '旧录音室',
    台呼恢复: false,
    可用物品: ['铜钥匙', '手电'],
    林岚: { 戒备: { value: 4, max: 5, note: '听见脚步' }, 当前情绪: '冷静' },
    远处的访客: { 可信度: '35%', 线索: '门口有雨水' },
};
const status = '回复正文。\n\n```scene-state\n' + JSON.stringify(fixture) + '\n```';
assert.deepEqual(parseSceneStatus(status), fixture);
assert.equal(parseSceneStatus('```json\n{"port": 42}\n```'), null);
assert.equal(readMeter('轮数', 3), null);
assert.equal(readMeter('戒备', fixture.林岚.戒备).max, 5);

try {
    const page = await browser.newPage();
    await page.route('**/api/chats/save', route => route.fulfill({ status: 200, json: { result: 'ok' } }));
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SillyTavern?.getContext()?.characters?.some(c => c.name === '林岚'));
    await page.evaluate(async () => {
        const c = SillyTavern.getContext();
        await c.selectCharacterById(c.characters.findIndex(item => item.name === '林岚'), { switchMenu: false });
    });
    const panel = page.locator('#local-scene-status');
    await panel.waitFor({ state: 'visible' });
    assert.equal(await panel.getAttribute('open'), null);
    await panel.locator('summary').tap();
    assert.equal(await panel.locator('progress:visible').count(), 3);
    assert.match(await panel.innerText(), /35%/);
    await panel.locator('summary').tap();
    const composer = await page.locator('#send_textarea').boundingBox();
    assert.ok(composer && composer.width > 220);

    await page.waitForFunction(() => window.SillyTavern.getContext().onlineStatus === 'roleplay-qwen35:9b-q4');
    assert.match(await page.locator('#ollama_model option:checked').textContent(), / · best$/);
    let requestBody;
    await page.route('**/api/backends/text-completions/generate', route => {
        requestBody = route.request().postDataJSON();
        const chunks = status.split(/(?=\n)/).map(chunk => 'data: ' + JSON.stringify({ choices: [{ text: chunk }] }) + '\n\n');
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body: chunks.join('') + 'data: [DONE]\n\n' });
    });
    await page.locator('#send_textarea').fill('我拿起手电，留在门口听。');
    await page.locator('#send_but').tap();
    await page.waitForFunction(() => document.querySelector('.scene-body')?.textContent.includes('旧录音室'));
    assert.ok(requestBody.prompt.includes('字段随当前故事选择'));
    await panel.locator('summary').tap();
    for (const phrase of ['旧录音室', '远处的访客', '铜钥匙', '4/5', '35%']) {
        assert.ok((await panel.innerText()).includes(phrase), phrase);
    }
    assert.equal((await page.locator('#chat .mes').last().locator('.mes_text').innerText()).trim(), '回复正文。');
    const box = await panel.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.height <= 844 * .63);
    if (process.env.TAVERN_SCENE_SCREENSHOT === '1') await page.screenshot({ path: 'logs/mobile-scene-status.png' });
    console.log('Mobile 390 px: best label, legacy state, generation prompt, dynamic groups and hidden JSON verified.');
} finally {
    await browser.close();
}
