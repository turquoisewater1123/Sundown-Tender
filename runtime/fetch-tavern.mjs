import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const cwd = resolve('SillyTavern');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
const files = execFileSync('git', ['ls-tree', '-rz', 'HEAD'], { cwd, encoding: 'utf8' })
    .split('\0').filter(Boolean).map(line => {
        const offset = line.indexOf('\t');
        return [line.slice(offset + 1), line.slice(0, offset).split(' ')[2]];
    });
const curl = promisify(execFile);
const failures = [];
let finished = 0;
async function matches(path, sha) {
    try {
        const file = await readFile(path);
        return createHash('sha1').update(`blob ${file.length}\0`).update(file).digest('hex') === sha;
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return false;
    }
}
async function download(path, sha) {
    const target = resolve(cwd, path);
    if (await matches(target, sha)) return;
    await mkdir(dirname(target), { recursive: true });
    const partial = target + '.download';
    const url = `https://raw.githubusercontent.com/SillyTavern/SillyTavern/${commit}/` +
        path.split('/').map(encodeURIComponent).join('/');
    try {
        await curl('curl.exe', ['-fsSL', '--retry', '3', '--retry-all-errors', '--max-time', '75', '-o', partial, url]);
        if (!await matches(partial, sha)) throw new Error('Git blob hash mismatch');
        await rename(partial, target);
    } finally {
        await rm(partial, { force: true });
    }
}
await Promise.all(Array.from({ length: 16 }, async () => {
    for (;;) {
        const entry = files.shift();
        if (!entry) break;
        try {
            await download(...entry);
            if (++finished % 50 === 0) console.log(`Verified ${finished} files`);
        } catch (error) {
            failures.push(entry[0]);
            console.error(entry[0], error.stderr?.trim() || error.message);
        }
    }
}));
console.log(`Verified ${finished} files, ${failures.length} failures`);
process.exitCode = failures.length ? 1 : 0;
