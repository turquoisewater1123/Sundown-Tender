import { chineseStateSubset, displayStateLabel, displayStateValue, isChineseState, parseSceneStatus, parseStateBlock, readMeter } from './status.mjs';
import { extension_prompt_roles, extension_prompt_types } from '../../../../script.js';

function element(tag, cssClass, content) {
    const node = document.createElement(tag);
    if (cssClass) node.className = cssClass;
    if (content !== undefined) node.textContent = content;
    return node;
}

const panel = element('details');
panel.id = 'local-scene-status';
panel.hidden = true;
panel.open = !window.matchMedia('(max-width: 720px)').matches;
const summary = element('summary', 'scene-summary', '剧本状态');
const identity = element('div', 'scene-identity');
const avatar = element('img', 'scene-avatar');
avatar.alt = '';
avatar.hidden = true;
const heading = element('h2', 'scene-character');
const body = element('div', 'scene-body');
const chatShell = document.getElementById('sheld');
identity.append(avatar, heading);
panel.append(summary, identity, body);
document.body.append(panel);

function renderMeter(label, meter, previous) {
    const result = element('div', 'scene-meter');
    const line = element('div', 'scene-meter-line');
    const progress = element('progress');
    progress.max = meter.max;
    progress.value = meter.value;
    progress.setAttribute('aria-label', displayStateLabel(label));
    const amount = meter.max === 100 ? `${meter.value}%` : `${meter.value}/${meter.max}`;
    const value = element('span', 'scene-meter-value', amount);
    const before = readMeter(label, previous);
    if (before && before.max === meter.max && before.value !== meter.value) {
        const rose = meter.value > before.value;
        value.append(element('span', rose ? 'scene-up' : 'scene-down', rose ? ' ↑' : ' ↓'));
    }
    line.append(progress, value);
    result.append(line);
    if (meter.note) result.append(element('small', 'scene-note', meter.note));
    return result;
}

function renderFields(fields, previous, depth = 0) {
    const list = element('dl', 'scene-fields');
    for (const [label, value] of Object.entries(fields)) {
        const prior = previous && Object.hasOwn(previous, label) ? previous[label] : undefined;
        const row = element('div', 'scene-row');
        row.append(element('dt', 'scene-key', displayStateLabel(label)));
        const cell = element('dd', 'scene-value');
        const meter = readMeter(label, value);
        if (meter) {
            cell.append(renderMeter(label, meter, prior));
        } else if (Array.isArray(value) && value.every(item => ['string', 'number', 'boolean'].includes(typeof item))) {
            const tags = element('ul', 'scene-tags');
            for (const item of value) tags.append(element('li', '', String(item)));
            if (value.length) cell.append(tags);
            else cell.textContent = '—';
        } else if (value && typeof value === 'object' && depth < 5) {
            row.classList.add('scene-group');
            const nested = Array.isArray(value) ? Object.fromEntries(value.map((item, index) => [`第 ${index + 1} 项`, item])) : value;
            const priorGroup = Array.isArray(prior) ? undefined : prior;
            cell.append(renderFields(nested, priorGroup, depth + 1));
        } else {
            cell.textContent = value === '' ? '—' : displayStateValue(value);
        }
        row.append(cell);
        list.append(row);
    }
    return list;
}

let lastRender;
const requests = new WeakMap();
const stateKey = 'local_scene_status';
function messageVersion(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
        hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
    }
    return hash >>> 0;
}

function stateOf(message) {
    const inline = parseSceneStatus(message.mes);
    const stored = message.extra?.[stateKey];
    return typeof message.mes === 'string' && stored?.version === messageVersion(message.mes) ? stored.fields : inline;
}

function refresh() {
    const context = SillyTavern.getContext();
    const { chat, characterId, groupId, chatId, name2 } = context;
    const adult = adultCharacter(context);
    panel.hidden = characterId == null && groupId == null;
    const avatarFile = groupId ? '' : context.characters[characterId]?.avatar;
    const portrait = avatarFile && avatarFile !== 'none' ? '/characters/' + encodeURIComponent(avatarFile) : '';
    chatShell.classList.toggle('scene-has-portrait', Boolean(portrait));
    avatar.hidden = !portrait;
    if (portrait && avatar.getAttribute('src') !== portrait) {
        avatar.src = portrait;
        chatShell.style.setProperty('--scene-portrait', `url("${portrait}")`);
    }
    if (panel.hidden) return;
    const states = [];
    let character;
    for (let index = chat.length - 1; index >= 0 && states.length < 2; index--) {
        const message = chat[index];
        if (message.is_user || message.is_system) continue;
        const state = stateOf(message);
        if (!state || (adult && !isChineseState(state, [adult.name, context.name1]))) continue;
        if (states.length === 0) character = message.name;
        states.push(state);
    }
    const title = groupId ? '群聊' : character || name2 || '当前场景';
    const fingerprint = JSON.stringify([chatId, title, states]);
    if (fingerprint === lastRender) return;
    lastRender = fingerprint;
    heading.textContent = title;
    body.replaceChildren(states.length ? renderFields(states[0], states[1]) :
        element('p', 'scene-empty', '角色回复包含场景状态后，这里会自动更新。'));
}

const { eventSource, eventTypes } = SillyTavern.getContext();
const chineseRule = '硬性语言要求：无论角色卡、开场或历史使用什么语言，最终回复的正文、对白、旁白、心理描写和状态面板的字段名、字段值、标签、备注一律使用简体中文。英文原文须先翻成中文再输出。原角色名、数字和代码块标记以及量表键 value、max、note 可以保留。';
const prompt = '状态面板：先写剧情正文，再在末尾添加一个 scene-state 代码块，块内是合法 JSON 对象。字段随当前故事选择 3–8 项，只记录已发生的事实，沿用仍适用的状态。不要替玩家行动。简短文本直接写字符串，标签用字符串数组，分组用嵌套对象，有明确范围的量表用 {"value":当前值,"max":上限,"note":"简短说明"}。如果角色卡已经指定可识别的状态格式，沿用其要求。';
const adultPrompt = '成人剧本状态面板：依据当前角色卡、开场、聊天和本轮正文，尽量记录 6–12 项有依据的状态，字段名和值都用简体中文。字段随剧情变动，可从具体场景、衣着、关系与互动进展、姿势与距离、亲密接触或身体反应、语气、情绪和想法、好感或兴奋变化、角色与玩家分别表达的意愿和界限中选择。用简短具体的细节或标签写出这一轮的变化。没有发生的事不要补写；仍相关但未提及的字段用数字 0，不硬凑无关字段。有多个相关角色时用各自姓名分组。正文简短，末尾附上一个以 ```scene-state 开头、以 ``` 结束的完整合法 JSON 对象。文本用字符串，标签用字符串数组，有明确依据的量表用 {"value":当前值,"max":上限,"note":"变化缘由"}。';
const storyTypes = ['normal', 'regenerate', 'swipe'];
function adultCharacter(context) {
    const character = context.characters[context.characterId];
    return character?.data?.extensions?.adult_settings?.level === 'explicit' ? character : null;
}

async function extractAdultState(id, type) {
    const context = SillyTavern.getContext();
    const message = context.chat[id];
    const character = adultCharacter(context);
    const { type: api, ollama_model: model, server_urls: urls } = context.textCompletionSettings;
    const fieldsBefore = message && stateOf(message);
    const names = [character?.name, context.name1];
    if (!storyTypes.includes(type) || !character || api !== 'ollama' || !model || !urls.ollama ||
        !message?.mes?.trim() || message.is_user || message.is_system || isChineseState(fieldsBefore, names)) return;
    const original = message.mes;
    if (requests.get(message) === original) return;
    requests.set(message, original);
    summary.textContent = '剧本状态 · 更新中';
    const recent = context.chat.slice(Math.max(0, id - 3), id + 1)
        .map(item => `${item.is_user ? '玩家' : item.name || character.name}：${item.mes?.slice(-850) || ''}`).join('\n');
    const facts = [character.name, character.data?.scenario?.slice(0, 650), recent].filter(Boolean).join('\n');
    const extraction = '你是剧本状态记录员。只输出 JSON 对象。取本轮有依据的 6–12 项，按剧情命名。可记录场景、衣着、距离、关系和互动、身体反应、语气、情绪或想法、双方意愿和界限。描述要具体简短。相关但未提及的值用数字 0，不猜测。不硬凑无关字段。文字用字符串，标签用数组，人物用对象分组，有明确范围的量表才用 value、max。';
    const translation = '逐层翻译这个 JSON，翻译所有字段名、文本值、数组标签和量表备注。保留结构、数值和原意，只输出翻译后的 JSON 对象。';
    const next = '<|im_start|>assistant\n' +
        (model === 'roleplay-qwen35:9b-q4' ? '<think>\n\n</think>\n\n' : '');
    async function requestState(instruction, input) {
        const response = await fetch('/api/backends/text-completions/generate', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            signal: AbortSignal.timeout(65000),
            body: JSON.stringify({
                api_type: api, api_server: urls.ollama, model, stream: false, format: 'json',
                temperature: 0.2, num_ctx: context.maxContext, num_predict: 480,
                stop: ['<|im_end|>', '<|im_start|>'],
                prompt: `<|im_start|>system\n${chineseRule}\n${instruction}<|im_end|>\n<|im_start|>user\n${input}<|im_end|>\n` + next,
            }),
        });
        if (!response.ok) return;
        const output = (await response.json()).response?.trim();
        return output && (parseStateBlock(output, true) || parseSceneStatus(output) ||
            parseStateBlock(output.replace(/^```(?:json)?\s*|\s*```$/gi, ''), true));
    }
    try {
        let fields = fieldsBefore ?
            await requestState(translation, JSON.stringify(fieldsBefore)) : await requestState(extraction, facts);
        if (fields && !isChineseState(fields, names)) {
            fields = await requestState(translation, JSON.stringify(fields)) || fields;
        }
        fields = chineseStateSubset(fields, names);
        const current = SillyTavern.getContext();
        if (!isChineseState(fields, names) || current.chatId !== context.chatId || current.chat[id] !== message || message.mes !== original) return;
        (message.extra ??= {})[stateKey] = { version: messageVersion(original), fields };
        refresh();
        await current.saveChat();
    } catch (error) {
        console.warn('Scene state extraction failed', error?.name);
    } finally {
        summary.textContent = '剧本状态';
    }
}

eventSource.on(eventTypes.GENERATION_AFTER_COMMANDS, type => {
    const context = SillyTavern.getContext();
    const active = (context.characterId != null || context.groupId != null) &&
        storyTypes.includes(type);
    const instruction = adultCharacter(context) ? adultPrompt : prompt;
    context.setExtensionPrompt('local-scene-status', active ? `${chineseRule}\n${instruction}` : '', extension_prompt_types.IN_CHAT,
        0, false, extension_prompt_roles.SYSTEM);
});
eventSource.on(eventTypes.MESSAGE_RECEIVED, (id, type) => { void extractAdultState(id, type); });
eventSource.on(eventTypes.CHAT_CHANGED, () => {
    const context = SillyTavern.getContext();
    const id = context.chat.findLastIndex(message => !message.is_user && !message.is_system);
    if (id >= 0 && stateOf(context.chat[id])) void extractAdultState(id, 'normal');
});
for (const name of ['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'GENERATION_ENDED']) {
    if (eventTypes[name]) eventSource.on(eventTypes[name], refresh);
}
refresh();
