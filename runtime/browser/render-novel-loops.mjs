import { chromium } from 'playwright-core';
import { access, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const scenes = {
    '01-last-broadcast': 'rain',
    '02-stadium-lights': 'rain',
    '03-planetarium': 'stars',
    '04-editing-room': 'dust',
    '05-night-shift': 'dust',
    '06-last-ferry': 'mist',
};
const browser = await chromium.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
    args: ['--no-proxy-server', '--disable-background-networking', '--allow-file-access-from-files'],
});

async function render(name, effect) {
    const directory = resolve('Novel/packs', name);
    const still = resolve(directory, 'default.png');
    const output = resolve(directory, 'default.mp4');
    const idle = resolve(directory, 'expressions/idle.mp4');
    await mkdir(resolve(directory, 'expressions'), { recursive: true });
    if (await access(output).then(() => true, () => false)) {
        if (!await access(idle).then(() => true, () => false)) await copyFile(output, idle);
        return;
    }
    const page = await browser.newPage();
    try {
        await page.goto(pathToFileURL(still).href);
        const result = await page.evaluate(async effect => {
            const portrait = document.querySelector('img');
            await portrait.decode();
            const canvas = document.createElement('canvas');
            canvas.width = 720;
            canvas.height = 1080;
            const ctx = canvas.getContext('2d', { alpha: false });
            const duration = 4000;
            const width = canvas.width;
            const height = canvas.height;
            const ratio = Math.max(width / portrait.naturalWidth, height / portrait.naturalHeight);
            function draw(time) {
                const phase = time * Math.PI * 2;
                const scale = ratio * (1.027 + 0.014 * Math.sin(phase));
                const w = portrait.naturalWidth * scale;
                const h = portrait.naturalHeight * scale;
                ctx.drawImage(portrait, (width - w) / 2 + 5 * Math.sin(phase), (height - h) / 2 - 5 * Math.cos(phase), w, h);
                if (effect === 'mist') {
                    const glow = ctx.createLinearGradient(0, height * 0.64, width, height);
                    glow.addColorStop(0, '#bacbd100');
                    glow.addColorStop(0.65 + 0.13 * Math.sin(phase), '#b7cbd51b');
                    glow.addColorStop(1, '#bacbd100');
                    ctx.fillStyle = glow;
                    ctx.fillRect(0, 0, width, height);
                    return;
                }
                for (let i = 0; i < 32; i++) {
                    const x = (i * 193 + 31) % width;
                    if (x > width * 0.25 && x < width * 0.75) continue;
                    if (effect === 'rain') {
                        const y = ((i * 173 + time * height * 2) % height) - 38;
                        ctx.strokeStyle = 'rgba(187,216,238,0.19)';
                        ctx.lineWidth = 1.2;
                        ctx.beginPath();
                        ctx.moveTo(x, y);
                        ctx.lineTo(x - 5, y + 24);
                        ctx.stroke();
                    } else {
                        const angle = phase + i * 1.31;
                        const y = (i * 121 + 40) % (height * 0.57) + 7 * Math.cos(angle);
                        const opacity = 0.09 + 0.13 * (1 + Math.sin(angle)) / 2;
                        ctx.fillStyle = `rgba(255,227,171,${opacity})`;
                        ctx.beginPath();
                        ctx.arc(x + 5 * Math.sin(angle), y, 1.4 + (i % 3) * 0.3, 0, 2 * Math.PI);
                        ctx.fill();
                    }
                }
            }
            const mimeType = ['video/mp4;codecs=avc1.420028', 'video/mp4;codecs=avc1', 'video/mp4']
                .find(type => MediaRecorder.isTypeSupported(type));
            if (!mimeType) throw new Error('H.264 MediaRecorder unavailable');
            draw(0);
            const stream = canvas.captureStream(24);
            const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2250000 });
            const chunks = [];
            recorder.ondataavailable = event => chunks.push(event.data);
            const stopped = new Promise((done, reject) => {
                recorder.onstop = done;
                recorder.onerror = event => reject(event.error);
            });
            recorder.start();
            const start = performance.now();
            const timer = setInterval(() => draw(Math.min((performance.now() - start) / duration, 1)), 1000 / 24);
            await new Promise(done => setTimeout(done, duration));
            clearInterval(timer);
            recorder.stop();
            await stopped;
            stream.getTracks().forEach(track => track.stop());
            const blob = new Blob(chunks, { type: mimeType });
            return new Promise((done, reject) => {
                const reader = new FileReader();
                reader.onload = () => done(reader.result.split(',')[1]);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        }, effect);
        await writeFile(output, Buffer.from(result, 'base64'), { flag: 'wx' });
        await copyFile(output, idle);
        console.log(name + ' · MP4 saved');
    } finally {
        await page.close();
    }
}

try {
    const entries = Object.entries(scenes);
    for (let i = 0; i < entries.length; i += 2) {
        await Promise.all(entries.slice(i, i + 2).map(([name, effect]) => render(name, effect)));
    }
} finally {
    await browser.close();
}
