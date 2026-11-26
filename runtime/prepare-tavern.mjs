import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';

const root = new URL('../', import.meta.url);
const local = path => new URL(path, root);
const tavern = path => local('SillyTavern/' + path);
const read = path => readFile(tavern(path), 'utf8');
const readJson = async path => JSON.parse(await read(path));
async function writeNew(destination, content) {
    try {
        await writeFile(destination, content, { flag: 'wx' });
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
    }
}

const profile = tavern('data/default-user/');
const characters = new URL('characters/', profile);
await mkdir(characters, { recursive: true });
await mkdir(new URL('extensions/', profile), { recursive: true });
await cp(local('assets/scene-status/'), new URL('extensions/scene-status/', profile), { recursive: true });
await cp(local('assets/scene-status/status.mjs'), tavern('public/scripts/local-scene-status.mjs'));

const settings = await readJson('default/content/settings.json');
const instruct = await readJson('default/content/presets/instruct/ChatML.json');
const context = await readJson('default/content/presets/context/ChatML.json');
Object.assign(settings, { firstRun: false, main_api: 'textgenerationwebui', max_context: 4096, amount_gen: 420 });
Object.assign(settings.textgenerationwebui_settings, {
    type: 'ollama',
    server_urls: { ollama: 'http://127.0.0.1:11435' },
    ollama_model: 'meissa:7b-q4',
    streaming: true,
    temp: 0.8,
    top_p: 0.9,
});
Object.assign(settings.power_user, {
    auto_connect: true,
    instruct: { ...instruct, preset: instruct.name, enabled: true, names_behavior: 'none' },
    context: { ...context, preset: context.name },
});
await writeNew(new URL('settings.json', profile), JSON.stringify(settings, null, 2));

const config = (await read('default/config.yaml'))
    .replace(/(browserLaunch:[\s\S]*?\r?\n  enabled:) true/, '$1 false')
    .replace(/^(  autoUpdate:) true/m, '$1 false')
    .replace(/^(    autoDownload:) true/m, '$1 false')
    .replace(/^enableDownloadableTokenizers: true/m, 'enableDownloadableTokenizers: false')
    .replace(/^enableServerPluginsAutoUpdate: true/m, 'enableServerPluginsAutoUpdate: false')
    .replace(/^(  keepAlive:) -1/m, '$1 300');
await writeNew(tavern('config.yaml'), config);

function chunk(type, contents) {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(contents.length);
    header.write(type, 4, 'ascii');
    const digest = Buffer.alloc(4);
    digest.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), contents])));
    return Buffer.concat([header, contents, digest]);
}

const size = 160;
const pixels = Buffer.alloc(size * (1 + size * 3));
for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
        const stripe = Math.floor((x + y) / 12);
        let color = [23 + stripe, 36 + stripe, 51 + stripe];
        if (x >= 27 && x < 133 && y >= 56 && y < 117) color = [192, 131, 80];
        if (x >= 34 && x < 126 && y >= 63 && y < 110) color = [50, 40, 45];
        if (x >= 42 && x < 88 && y >= 73 && y < 101 && y % 5 < 2) color = [191, 140, 96];
        if ((x - 108) ** 2 + (y - 86) ** 2 <= 90) color = [218, 172, 114];
        if (y >= 34 && y < 57 && Math.abs(x - (94 + y / 2)) < 2) color = [209, 154, 99];
        pixels.set(color, y * (size * 3 + 1) + 1 + x * 3);
    }
}
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 2;
const card = await readFile(local('assets/雨夜电台.json'), 'utf8');
const encoded = Buffer.from(JSON.stringify(JSON.parse(card))).toString('base64');
const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('tEXt', Buffer.from('chara\0' + encoded)),
    chunk('IEND', Buffer.alloc(0)),
]);
await writeNew(local('assets/雨夜电台.png'), png);
await writeNew(new URL('雨夜电台.png', characters), png);
console.log('SillyTavern profile, scene status extension and PNG card prepared.');
