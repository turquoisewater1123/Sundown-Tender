import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

const profile = new URL('../SillyTavern/data/default-user/', import.meta.url);
const settingsFile = new URL('settings.json', profile);
const model = 'roleplay-qwen35:9b-q4';
const chineseModel = 'roleplay-cn:8b-q4';
const name = 'Qwen3.5 Roleplay';
const settings = JSON.parse(await readFile(settingsFile, 'utf8'));
const chatML = JSON.parse(await readFile(new URL('instruct/ChatML.json', profile), 'utf8'));
const preset = {
    ...chatML,
    name,
    names_behavior: 'none',
    last_output_sequence: '<|im_start|>assistant\n<think>\n\n</think>',
};
await mkdir(new URL('instruct/', profile), { recursive: true });
await writeFile(new URL('instruct/Qwen3.5 Roleplay.json', profile), JSON.stringify(preset, null, 2));

const templates = settings.power_user.model_templates_mappings ??= {};
templates[model] = { instruct: name, context: 'ChatML' };
for (const olderModel of ['meissa:7b-q4', 'roleplay-zh:14b-q4']) {
    templates[olderModel] ??= { instruct: 'ChatML', context: 'ChatML' };
}
if (process.argv.includes('--default')) {
    settings.textgenerationwebui_settings.ollama_model = model;
    settings.power_user.instruct = { ...preset, preset: name, enabled: true };
}
if (process.argv.includes('--enable-cn') || process.argv.includes('--default-cn')) {
    templates[chineseModel] = { instruct: 'ChatML', context: 'ChatML' };
}
if (process.argv.includes('--default-cn')) {
    settings.textgenerationwebui_settings.ollama_model = chineseModel;
    settings.power_user.instruct = { ...chatML, preset: 'ChatML', enabled: true };
}
if (process.argv.includes('--context-8k')) {
    settings.max_context = 8192;
}

const pending = new URL('settings.roleplay-pending.json', profile);
await writeFile(pending, JSON.stringify(settings, null, 2));
await rename(pending, settingsFile);
