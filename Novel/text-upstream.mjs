import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('.', import.meta.url));

export async function upstream(config, payload, signal) {
    const key = process.env[config.keyEnv] ||
        (config.keyFile && (await readFile(join(root, config.keyFile), 'utf8')).trim());
    const request = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key && { Authorization: 'Bearer ' + key }) },
        body: JSON.stringify(payload), signal, redirect: 'error',
    };
    const busyDeadline = Date.now() + 45_000;
    let backoff = 2000;
    for (;;) {
        const response = await fetch(config.url, request);
        if (response.status !== 429 || config.protocol !== 'openai') return response;
        const error = await response.clone().json().catch(() => null);
        if (error?.error?.code !== 'KYRUNE_BUSY_WRITING') return response;
        // This code means the new request was rejected before generation began.
        await response.body?.cancel();
        const retryAfter = response.headers.get('retry-after');
        const seconds = Number(retryAfter);
        const minimum = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
        const wait = Math.max(backoff, minimum || 0);
        if (Date.now() + wait > busyDeadline) {
            throw Object.assign(new Error('模型仍在生成上一条回复，请稍后重新发送。'), { status: 429 });
        }
        await delay(wait, undefined, { signal });
        backoff = Math.min(10_000, backoff * 2);
    }
}
