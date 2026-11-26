import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { BlockList, isIPv4 } from 'node:net';
import { handleNovel, isAndroidDownload, translateExistingCards } from '../Novel/server.mjs';

const [address, prefix] = process.argv.slice(2);
const port = 8001;
const host = `${address}:${port}`;
void translateExistingCards().catch(error => console.error('剧本库暂时无法读取',error.message));
const origin = `http://${host}`;
if (!isIPv4(address) || !/^\d+$/.test(prefix) || Number(prefix) < 16 || Number(prefix) > 32) {
    throw new Error('Expected the Wi-Fi IPv4 address and subnet prefix.');
}

const peers = new BlockList();
peers.addSubnet(address, Number(prefix), 'ipv4');
const credentialFile = new URL('../mobile-access.json', import.meta.url);
try {
    const password = randomBytes(12).toString('base64url');
    await writeFile(credentialFile, JSON.stringify({ username: 'tavern', password }, null, 2), { flag: 'wx' });
} catch (error) {
    if (error.code !== 'EEXIST') throw error;
}
async function authenticate(req, res) {
    let expected;
    try {
        const { username, password } = JSON.parse(await readFile(credentialFile, 'utf8'));
        expected = Buffer.from('Basic ' + Buffer.from(`${username}:${password}`).toString('base64'));
    } catch {
        res.writeHead(503).end('Mobile login configuration is unavailable');
        return false;
    }
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Local SillyTavern"', 'Cache-Control': 'no-store' });
        res.end('Sign in to SillyTavern');
        return false;
    }
    return true;
}

http.createServer(async (req, res) => {
    if (!peers.check(req.socket.remoteAddress, 'ipv4') || req.headers.host !== host ||
        (req.headers.origin && req.headers.origin !== origin)) {
        res.writeHead(403).end('Local Wi-Fi access only');
        return;
    }
    // Android launchers can hand downloads to a process without the browser's Basic auth.
    // Only the fixed installer file is available without credentials on the Wi-Fi subnet.
    if (isAndroidDownload(req)) {
        await handleNovel(req, res);
        return;
    }
    if (!await authenticate(req, res)) return;
    if (await handleNovel(req, res)) return;

    const headers = { ...req.headers, host: '127.0.0.1:8000' };
    for (const field of ['authorization', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']) {
        delete headers[field];
    }
    const upstream = http.request({ hostname: '127.0.0.1', port: 8000, method: req.method, path: req.url, headers }, reply => {
        res.writeHead(reply.statusCode, reply.headers);
        reply.pipe(res);
    });
    upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end('Start the local SillyTavern service on port 8000.');
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
}).listen(port, address, () => console.log(`SillyTavern Wi-Fi: ${origin}/`));

const localOrigin = 'http://127.0.0.1:8002';
http.createServer(async (req, res) => {
    const incomingOrigin = req.headers.origin;
    const direct = req.headers.host === '127.0.0.1:8002' &&
        (!incomingOrigin || incomingOrigin === localOrigin) && !req.headers['x-forwarded-proto'];
    if (!direct) {
        const remote = await readFile(new URL('../Novel/settings.json', import.meta.url), 'utf8')
            .then(content => JSON.parse(content).httpsHost).catch(() => null);
        if (!remote || !/^[a-z0-9.-]+\.ts\.net$/.test(remote) ||
            req.headers.host !== remote || req.headers['x-forwarded-proto'] !== 'https' ||
            (incomingOrigin && incomingOrigin !== 'https://' + remote)) {
            res.writeHead(403).end();
            return;
        }
        if (!await authenticate(req, res)) return;
    }
    if (!await handleNovel(req, res, direct)) res.writeHead(302, { Location: '/novel/' }).end();
}).listen(8002, '127.0.0.1', () => console.log(`Novel preview: ${localOrigin}/novel/`));
