import { readFile, writeFile } from 'node:fs/promises';
import { parseSceneStatus } from '../assets/scene-status/status.mjs';
import { parse as parseCharacterCard } from '../SillyTavern/src/character-card-parser.js';

const base = process.env.TAVERN_BENCHMARK_OLLAMA_URL ?? 'http://127.0.0.1:11435';
const contextLength = Number(process.env.TAVERN_BENCHMARK_CONTEXT ?? 4096);
const { data: card } = JSON.parse(await readFile(new URL('../assets/雨夜电台.json', import.meta.url), 'utf8'));
const premise = [card.description, card.personality, card.scenario].join('\n');
const scene = [
    ['system', premise],
    ['assistant', card.first_mes],
    ['user', '我接过毛巾，把门关上。「我听见了一句话，像是在念你们电台的旧台呼。你想上去看看吗？」'],
];
let scenarios = [
    { name: '新话题与玩家行动', turns: [...scene, ['user', '我想看看你带在身上的那把钥匙。']] },
    { name: '未交代的指代', turns: [...scene, ['user', '我就是想让她们听到。']] },
    {
        name: '场景位置与新选择',
        turns: [...scene, ['assistant', '「先等等。」林岚仍站在一楼桌边，钥匙还在她手里。'],
            ['user', '先别上楼。我想问，你愿意让我靠近一点吗？']],
    },
];

const args = process.argv.slice(2);
const replay = args[0] === '--replay';
const cardMode = args[0] === '--card';
if (replay) {
    const [, path, turn] = args.splice(0, 3);
    const history = (await readFile(path, 'utf8')).trim().split(/\r?\n/)
        .map(line => JSON.parse(line)).filter(message => typeof message.mes === 'string');
    const ends = turn === 'all' ? history.flatMap((message, index) => message.is_user ? [index + 1] : []) :
        turn.split(',').map(Number);
    scenarios = ends.map(end => {
        if (!Number.isInteger(end) || !history[end - 1]?.is_user) {
            throw new Error('Replay must end at a one-based user turn');
        }
        return {
            name: `原始对话第 ${end} 条消息`,
            turns: [['system', premise], ...history.slice(0, end).map(message =>
                [message.is_user ? 'user' : 'assistant', message.mes])],
        };
    });
}
if (cardMode) {
    const [, path] = args.splice(0, 2);
    const { data: custom } = JSON.parse(await parseCharacterCard(path));
    const substitute = text => (text ?? '').replace(/{{char}}/gi, () => custom.name).replace(/{{user}}/gi, 'User');
    const greeting = substitute(custom.first_mes);
    const cases = [
        ['停一下并交代场景', '先停一下。我还没决定做什么。用中文告诉我你是谁、我们现在在哪儿，然后等我回答。'],
        ['不确定的旁人', '她们会听见吗？如果你不知道我说的“她们”是谁，先问我。先别让任何人进来。'],
        ['回应当下并保留行动权', '继续留在包厢里。你可以说你想要什么、有什么界限。先回应我，下一步我来决定。'],
    ];
    scenarios = cases.map(([name, input]) => {
        const search = (greeting + '\n' + input).toLowerCase();
        const lore = (custom.character_book?.entries ?? []).filter(entry => entry.enabled !== false &&
            (entry.constant || entry.keys?.some(key => key && search.includes(key.toLowerCase()))))
            .map(entry => substitute(entry.content));
        const system = [custom.system_prompt, custom.description, custom.personality, custom.scenario,
            ...lore, custom.mes_example].map(substitute).filter(Boolean).join('\n\n');
        return { name, turns: [['system', system], ['assistant', greeting], ['user', input]],
            instructions: substitute(custom.post_history_instructions) };
    });
}
const models = args;
if (!models.length) throw new Error('Pass at least one installed model name');
const cardOutput = contextLength === 8192 ? '../logs/rei-kaito-comparison-8k.json' : '../logs/rei-kaito-comparison.json';
const output = new URL(cardMode ? cardOutput :
    replay ? '../logs/roleplay-replay.json' : '../logs/roleplay-comparison.json', import.meta.url);
let results = [];
try {
    results = JSON.parse(await readFile(output, 'utf8')).filter(sample => !models.includes(sample.model));
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}
for (const model of models) {
    const assistantPrefix = model === 'roleplay-qwen35:9b-q4' ?
        '<|im_start|>assistant\n<think>\n\n</think>\n\n' : '<|im_start|>assistant\n';
    for (const test of scenarios) {
        const instructions = test.instructions ?? card.post_history_instructions;
        const turns = instructions ? [...test.turns, ['user', instructions]] : test.turns;
        const prompt = turns.map(([role, content]) => `<|im_start|>${role}\n${content}<|im_end|>\n`).join('') +
            assistantPrefix;
        const response = await fetch(base + '/api/generate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model, prompt, raw: true, stream: false, keep_alive: '2m',
                options: { seed: 42, temperature: 0.8, top_p: 0.9, num_ctx: contextLength, num_predict: 280,
                    ...(process.env.TAVERN_BENCHMARK_LOW_MEMORY === '1' ? { use_mmap: true, num_batch: 128 } : {}),
                    stop: ['<|im_end|>', '<|im_start|>'] },
            }),
            signal: AbortSignal.timeout(180000),
        });
        if (!response.ok) throw new Error(response.status + ': ' + await response.text());
        const reply = await response.json();
        const loaded = (await (await fetch(base + '/api/ps')).json()).models.find(item => item.name === model);
        const visible = (reply.response ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        const sample = {
            model, test: test.name, inputTokens: reply.prompt_eval_count, contextLength,
            tokensPerSecond: reply.eval_duration ? Math.round(reply.eval_count * 1e9 / reply.eval_duration) : null,
            gpuPercent: loaded?.size ? Math.round(100 * loaded.size_vram / loaded.size) : null,
            state: Boolean(parseSceneStatus(visible)), reply: visible,
            thinkingOnly: !visible && Boolean(reply.thinking),
            finish: reply.done_reason,
        };
        results.push(sample);
        await writeFile(output, JSON.stringify(results, null, 2));
        console.log(JSON.stringify(replay || cardMode ? { ...sample, reply: undefined } : sample));
    }
}
