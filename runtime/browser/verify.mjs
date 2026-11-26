import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { parseSceneStatus } from '../../assets/scene-status/status.mjs';

const browser = await chromium.launchPersistentContext(resolve('runtime/browser-profile'), {
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
    args: ['--no-proxy-server', '--disable-background-networking'],
});
try {
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:8000/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SillyTavern?.getContext()?.characters
        ?.some(character => character.name === '林岚'), undefined, { timeout: 45000 });
    await page.evaluate(async () => {
        const context = SillyTavern.getContext();
        const id = context.characters.findIndex(character => character.name === '林岚');
        await context.selectCharacterById(id);
    });
    const panel = page.locator('#local-scene-status');
    await panel.waitFor({ state: 'visible', timeout: 15000 });
    assert.match(await panel.innerText(), /好感度\s+35%/);
    assert.match(await panel.innerText(), /戒备而好奇/);
    console.log('PNG character loaded and status panel displayed.');

    await page.waitForFunction(() => SillyTavern.getContext().onlineStatus !== 'no_connection',
        undefined, { timeout: 20000 });
    const stream = page.waitForResponse(response => response.url().endsWith('/api/backends/text-completions/generate'), { timeout: 90000 });
    await page.locator('#send_textarea').fill('我接过毛巾，把门关上。「我听见了一句话，像是在念你们电台的旧台呼。你想上去看看吗？」\n\n（请用一小段正文续写，正文后按上一条回复的格式附上完整的 json 状态代码块。）');
    await page.locator('#send_but').click();
    const reply = await stream;
    assert.equal(reply.status(), 200);
    assert.equal(reply.headers()['transfer-encoding'], 'chunked');
    const events = (await reply.text()).split('\n').filter(line => line.startsWith('data: '));
    assert.ok(events.length > 5);
    await page.waitForFunction(() => SillyTavern.getContext().chat.length >= 3 &&
        !document.querySelector('#mes_stop')?.checkVisibility(), undefined, { timeout: 40000 });
    const latest = await page.evaluate(() => SillyTavern.getContext().chat.at(-1).mes);
    const state = parseSceneStatus(latest);
    assert.ok(state, 'The generated reply must end with valid state JSON: ' + JSON.stringify(latest.slice(-320)));
    await page.waitForFunction(mood => document.querySelector('#local-scene-status').innerText.includes(mood),
        state['当前心情'], { timeout: 10000 });
    assert.equal(await panel.locator('progress').count(), 3);
    await page.evaluate(() => SillyTavern.getContext().saveChat());
    console.log(`SillyTavern streamed ${events.length} events and rendered three state meters.`);
} finally {
    await browser.close();
}
