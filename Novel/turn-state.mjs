import {readMeter, displayStateLabel} from '../assets/scene-status/status.mjs';
const fixed = [
    '好感度','信任值','心动值','羞耻值','抗拒值','期待值',
    '主动意愿','安全感','性兴奋度','高潮度','乳头坚硬程度','小穴湿润程度',
];
const aliases = new Map(Object.entries({'羞耻度':'羞耻值','心动度':'心动值','好感值':'好感度','信任度':'信任值','抗拒度':'抗拒值','期待度':'期待值','兴奋值':'性兴奋度','小穴湿润度':'小穴湿润程度','乳头硬度':'乳头坚硬程度'}));
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export function galleryChoices(info,assets,messages){
    const config=info.extensions?.nightread || {};
    const used=new Set(messages.map(message=>message.galleryKey).filter(Boolean));
    return Object.fromEntries((config.gallery_order || []).filter(key=>Object.hasOwn(assets,key) && !used.has(key)).map(key=>{
        const description=config.gallery_descriptions?.[key] || (!/^插画\d+$/.test(key) ? '本轮实际出现「'+key+'」所指的情境时使用。' : '');
        return [key,description];
    }).filter(([,description])=>description));
}
export function selectScene(info,assets,messages,choice,prose,state={}){
    const choices=galleryChoices(info,assets,messages);
    if(choice!=null && typeof choice!=='string')return {};
    const cues=info.extensions?.nightread?.gallery_cues || {};
    const clauses=String(prose||'').split(/[。！？；\n]/u).map(s=>s.trim()).filter(Boolean);
    const strict=info.extensions?.nightread?.explicit_scene_choice;
    const current=line=>!/(?:回忆|想起|如果|假如|并未|并没有|没有|还没|并不|从未|并非|要是|明天再)/u.test(line)
        && !(strict && /(?:不想|不要|不肯|不愿|拒绝|不能|是否|要不要|想象|打算|准备去|想到|梦见|提到|别去|明天|改天|还未|尚未)/u.test(line));
    const windows=clauses.map((line,i)=>current(line)?line+(clauses[i+1]&&current(clauses[i+1])?clauses[i+1]:''):'');
    const gates=info.extensions?.nightread?.gallery_minimums || {};
    const eligible=key=>Object.entries(gates[key] || {}).every(([field,minimum])=>{
        const meter=readMeter(field,state[field]);
        return (meter ? 100*meter.value/meter.max : Number(state[field]) || 0)>=minimum;
    });
    const exclusions=info.extensions?.nightread?.gallery_exclusions || {};
    const continuous=info.extensions?.nightread?.gallery_continuous || [];
    const present=clauses.filter(current);
    const matches=key=>eligible(key)
        && !present.some(line=>exclusions[key]?.some(term=>{
            const at=line.indexOf(term);
            return at>=0 && !/(?:昨晚|昨夜|昨天|昨日|那一晚|那天夜里)[^，。！？]{0,16}$/u.test(line.slice(0,at));
        }))
        && (continuous.includes(key) ? [present.join('。')] : windows)
            .some(line=>cues[key].every(group=>group.some(term=>line.includes(term))));
    if(Object.hasOwn(choices,choice) && eligible(choice) && (!cues[choice]?.length || matches(choice)))return {galleryKey:choice};
    if(strict){
        const confirmed=Object.keys(choices).filter(key=>continuous.includes(key) && cues[key]?.length>=3 && matches(key));
        return confirmed.length===1 ? {galleryKey:confirmed[0]} : {};
    }
    if(choice && choice!=='无' && !Object.hasOwn(choices,choice))return {};
    const unique=Object.keys(choices).filter(key=>cues[key]?.length>=2 && matches(key));
    return unique.length===1?{galleryKey:unique[0]}:{};
}
export function galleryProgress(info, assets, messages, state) {
    const stages = (info.extensions?.nightread?.gallery_order || []).filter(key => Object.hasOwn(assets,key));
    if (!stages.length) return {};
    const meter = key => {
        const raw = state?.[key];
        const measured=readMeter(key,raw);
        const n = measured ? measured.value*100/measured.max : Number(raw);
        return Number.isFinite(n) ? Math.min(100, Math.max(0,n)) : 0;
    };
    const score = Math.max(meter('性兴奋度'), meter('心动值') * .75, meter('期待值') * .5);
    const level = Math.min(stages.length-1, Math.floor(score * stages.length / 100));
    const used = messages.filter(row => row.galleryKey);
    if (level <= Math.max(-1,...used.map(row => row.galleryLevel ?? -1)) || used.some(row => row.galleryKey === stages[level])) return {};
    return {galleryLevel:level,galleryKey:stages[level]};
}
export function stateDefaults(info) {
    const adult=/nsfw|成人向|explicit|成人互动小说|均已成年|均成年|角色与玩家均成年/i.test([info.tags,info.system_prompt].join(' '));
    return adult ? Object.fromEntries(fixed.map(k=>[k,0])) : {};
}
export function mergeState(previous,current) {
    const result={...previous};
    for(const [key,value] of Object.entries(current || {})){
        if(['__proto__','prototype','constructor'].includes(key) || value==null) continue;
        const old=result[key];
        result[key]=record(old)&&record(value)&&!('max' in old)&&!('max' in value) ? mergeState(old,value) : value;
    }
    return result;
}
const echoedKeys=['上轮状态','上一轮状态','本轮正文','可用套图','配图要求'];
export function unpackTurn(source){
    if(!record(source))return source;
    const {本轮状态:current,...fields}=source;
    for(const key of echoedKeys)delete fields[key];
    if(record(current)||echoedKeys.some(key=>Object.hasOwn(source,key)))delete fields.主角;
    if(record(current))return mergeState(fields,current);
    if(current!=null)fields.本轮状态=current;
    return Object.keys(fields).length?fields:null;
}
export function readTurnHistory(rows){
    let last,previousRaw;
    for(const row of rows){
        if(!record(row.state))continue;
        const raw=row.state;
        if(record(raw.本轮状态)){
            const fields=unpackTurn({...raw,本轮状态:undefined}) || {};
            delete fields.主角;
            const patch={};
            for(const [key,value] of Object.entries(fields))
                if(!previousRaw || JSON.stringify(previousRaw[key])!==JSON.stringify(value))patch[key]=value;
            if(JSON.stringify(previousRaw?.本轮状态)!==JSON.stringify(raw.本轮状态))Object.assign(patch,raw.本轮状态);
            row.state=mergeState(last,patch);
            row.stateChanges=Object.keys(row.state).filter(k=>JSON.stringify(row.state[k])!==JSON.stringify(last?.[k]));
        }
        last=row.state;
        previousRaw=raw;
    }
    return rows;
}
function canonical(source) {
    const values={...source};
    for(const key of Object.keys(values)){
        const label=displayStateLabel(key);
        const target=label==='兴奋度'?'性兴奋度':label;
        if(target!==key && fixed.includes(target)){
            if(!Object.hasOwn(values,target))values[target]=values[key];
            delete values[key];
        }
    }
    for(const [alias,key] of aliases) if(Object.hasOwn(values,alias)){
        if(!Object.hasOwn(values,key))values[key]=values[alias];
        delete values[alias];
    }
    return values;
}
export function turnState(info,previous,changes,prose=''){
    const defaults=stateDefaults(info);
    if(!Object.keys(defaults).length)return mergeState(previous,changes);
    const base={...defaults,...canonical(previous)}, patch=canonical(changes);
    // Earlier cards initialized these retired meters to zero without story evidence.
    for(const key of ['身体敏感度','疲劳度']) if(base[key]===0) delete base[key];
    if(record(patch[info.name])){
        const subject=canonical(patch[info.name]);
        for(const key of fixed)if(Object.hasOwn(subject,key)){
            if(!Object.hasOwn(patch,key))patch[key]=subject[key];
            delete subject[key];
        }
        if(Object.keys(subject).length)patch[info.name]=subject;
        else delete patch[info.name];
    }
    for(const key of fixed){
        if(!Object.hasOwn(patch,key))continue;
        const value=patch[key];
        // A missing measurement or an unsupported reset is not a change.
        const meter=readMeter(key,value);
        const n=meter ? meter.value*100/meter.max : (typeof value==='number' || (typeof value==='string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) ? Number(value) : NaN;
        const note=meter?.note?.trim();
        const evidenced=note && prose.includes(note);
        if(Number.isFinite(n)&&n>=0&&n<=100&&(n>0||evidenced)){
            patch[key]={value:Math.round(n),max:100,...(evidenced?{note}:{})};
        }else delete patch[key];
    }
    return mergeState(base,patch);
}
