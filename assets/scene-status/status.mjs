const legacyMeters = new Set(['好感度', '心动值', '羞耻度']);
const stateMeters = new Set([...legacyMeters,'信任值','羞耻值','抗拒值','期待值','主动意愿','安全感','高潮度','性兴奋度','乳头坚硬程度','小穴湿润程度']);
const wrappers = ['scene_status', 'scene_state', '剧本状态', '状态'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const labels = new Map(Object.entries({
    location: '地点', scene: '场景', setting: '场景', time: '时间', atmosphere: '氛围', status: '状态',
    clothing: '衣着', outfit: '衣着', mood: '情绪', emotions: '情绪', thoughts: '想法',
    actions: '互动进展', relationship: '关系', affection: '好感度', arousal: '兴奋度',
    'body reactions': '身体反应', 'physical state': '身体状态', consent: '意愿',
    boundaries: '界限', intent: '当前意图', tags: '状态标签', distance: '距离',
    'relationship dynamic': '关系变化', 'physical reactions': '身体反应',
    'tone emotions': '语气与情绪', 'consent boundaries': '意愿与界限',
    'characters present': '在场人物', goals: '当前目标', relationships: '关系', player: '玩家', user: '玩家',
    'arousal level': '兴奋度', 'clothing status': '衣着状态', 'physical condition': '身体状态',
    action: '动作', dialogue: '对白', emotion: '情绪', text: '说明', tag: '标签',
    state: '当前状态', 'arousal change': '兴奋变化',
    dominance: '主导程度', obedience: '顺从程度', 'shame to desire ratio': '羞耻与渴望',
    'submit to pain': '对痛感的态度', 'power balance': '主动权',
}));

export function displayStateLabel(label) {
    return labels.get(label.toLowerCase().replace(/[_-]+/g, ' ').trim()) ?? label;
}

export function isChineseState(value, names = []) {
    return object(value) && chineseStateLanguage(names).valid(value);
}

function chineseStateLanguage(names) {
    const allowedNames = names.filter(Boolean).flatMap(name =>
        [name, name.replace(/\s+/g, ''), ...name.trim().split(/\s+/)]).filter(Boolean);
    function hasEnglish(text) {
        const normalized = text.toLowerCase();
        const stripped = allowedNames.reduce((result, name) => result.split(name.toLowerCase()).join(''), normalized);
        return /[a-z]{2,}/.test(stripped);
    }
    function valid(item) {
        if (typeof item === 'string') return !hasEnglish(displayStateValue(item));
        if (Array.isArray(item)) return item.every(valid);
        if (!object(item)) return true;
        return Object.entries(item).every(([key, entry]) => validKey(item, key) && valid(entry));
    }
    function validKey(item, key) {
        return (Number.isFinite(item.value) && Number.isFinite(item.max) && ['value', 'max', 'note'].includes(key)) ||
            !hasEnglish(displayStateLabel(key));
    }
    return { valid, validKey };
}

export function chineseStateSubset(value, names = []) {
    if (!object(value)) return null;
    const { valid, validKey } = chineseStateLanguage(names);
    function clean(item) {
        if (valid(item)) return item;
        if (Array.isArray(item)) {
            const values = item.map(clean).filter(entry => entry !== undefined);
            return values.length ? values : undefined;
        }
        if (!object(item)) return undefined;
        const entries = Object.entries(item).filter(([key]) => validKey(item, key))
            .map(([key, entry]) => [key, clean(entry)]).filter(([, entry]) => entry !== undefined);
        return entries.length ? Object.fromEntries(entries) : undefined;
    }
    return clean(value) ?? null;
}

export function displayStateValue(value) {
    if (value === null || (typeof value === 'string' &&
        /^(?:未提及|未交代|未说明|未确定|未知|不确定|not mentioned|not specified|unknown|undetermined)[。.!！]?$/i.test(value.trim()))) return '0';
    if (typeof value === 'boolean') return value ? '是' : '否';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function parseStateBlock(source, declared = false) {
    if (source.length > 24000) return null;
    let data;
    try {
        data = JSON.parse(source);
    } catch {
        return null;
    }
    if (!object(data)) return null;
    const wrapper = wrappers.find(key => Object.hasOwn(data, key) && object(data[key]));
    const fields = wrapper ? data[wrapper] : data;
    const legacy = [...legacyMeters].some(key => Object.hasOwn(fields, key)) &&
        Object.hasOwn(fields, '当前心情');
    return (declared || wrapper || legacy) && Object.keys(fields).length ? fields : null;
}

function sceneStateSpans(message) {
    const spans = [];
    const blocks = /(?:^|\r?\n)[ \t]*```([^\r\n]*)\r?\n([\s\S]*?)(?:\r?\n[ \t]*```(?=[ \t]*(?:\r?\n|$))|$)/g;
    for (const match of message.matchAll(blocks)) {
        const language = match[1].trim().toLowerCase();
        if (language !== 'scene-state' && language !== 'json') continue;
        const declared = language === 'scene-state';
        const fields = parseStateBlock(match[2], declared);
        const statePrefix = /^\s*\{\s*"(?:scene_status|scene_state|剧本状态|当前心情|好感度|心动值|羞耻度)"\s*:/.test(match[2]);
        const complete = /\r?\n[ \t]*```$/.test(match[0]);
        if (declared || fields || statePrefix || !complete) {
            spans.push({ start: match.index, end: match.index + match[0].length, fields });
        }
    }
    const inline = /```scene-state\b[ \t]*(?=\{|\[|$)/gi;
    for (const match of message.matchAll(inline)) {
        if (spans.some(span => match.index >= span.start && match.index < span.end)) continue;
        const contentStart = match.index + match[0].length;
        const close = message.indexOf('```', contentStart);
        const contentEnd = close < 0 ? message.length : close;
        spans.push({
            start: match.index,
            end: close < 0 ? message.length : close + 3,
            fields: parseStateBlock(message.slice(contentStart, contentEnd).trim(), true),
        });
    }
    spans.sort((first, second) => first.start - second.start);
    const tail = message.slice(spans.at(-1)?.end ?? 0);
    const pending = /(?:^|\r?\n)[ \t]*```(?:scene-state|json)[ \t]*$/i.exec(tail) ||
        /(?:^|\r?\n[ \t]*\r?\n)\{\s*"(?:scene_status|scene_state|剧本状态)"\s*:[\s\S]*$/.exec(tail);
    const bare = /(?:^|\r?\n[ \t]*\r?\n)(\{[\s\S]*?\})[ \t\r\n]*$/.exec(tail);
    const fields = bare && parseStateBlock(bare[1]);
    const suffix = pending || (fields && bare);
    if (suffix) spans.push({ start: message.length - tail.length + suffix.index, end: message.length, fields });
    return spans;
}

export function parseSceneStatus(message) {
    if (typeof message !== 'string') return null;
    return sceneStateSpans(message).findLast(span => span.fields)?.fields ?? null;
}

export function stripSceneStatusForDisplay(message) {
    if (typeof message !== 'string') return message;
    const spans = sceneStateSpans(message);
    if (!spans.length) return message;
    let shown = '';
    let start = 0;
    for (const span of spans) {
        shown += message.slice(start, span.start);
        start = span.end;
    }
    return (shown + message.slice(start)).trimEnd();
}

export function readMeter(label, value) {
    if (object(value) && Number.isFinite(value.value) && Number.isFinite(value.max) &&
        value.max > 0 && value.value >= 0 && value.value <= value.max) {
        return { value: value.value, max: value.max, note: typeof value.note === 'string' ? value.note : '' };
    }
    if (stateMeters.has(label) && Number.isFinite(value) && value >= 0 && value <= 100) {
        return { value, max: 100, note: '' };
    }
    const percent = typeof value === 'string' && /^(\d+(?:\.\d+)?)\s*[%％]\s*(.*)$/s.exec(value);
    if (percent && Number(percent[1]) <= 100) {
        return { value: Number(percent[1]), max: 100, note: percent[2] };
    }
    return null;
}
