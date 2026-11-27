export function sceneContext(messages, position) {
    const previous = messages.slice(0, position);
    const lastReply = previous.findLastIndex(row => row.role === 'assistant');
    const playerInput = previous.slice(lastReply + 1).filter(row => row.role === 'user')
        .map(row => row.text).join('\n');
    return {
        position,
        playerInput: clip(playerInput, 1000),
        continuity: previous.slice(0,lastReply+1).slice(-6).map(row => ({
            发言者: row.role === 'assistant' ? '角色' : '玩家', 内容:clip(row.text,650),
        })),
        state: clip(JSON.stringify(messages[position].state ?? {}),1600),
    };
}

const appearance = '沿用原卡人物的年龄、五官和发型，身形比例自然。';

export function picturedAges(info, cast) {
    return cast.map(name => {
        const profile = info.visual_cast?.[name] || '';
        const primary = name === info.name;
        const ages = [primary && info.age, ...String(profile).matchAll(/(\d{1,3})\s*岁/gu)]
            .filter(Boolean).map(value => Number.parseInt(Array.isArray(value) ? value[1] : value, 10));
        if (ages.some(age => !Number.isInteger(age) || age < 18) || new Set(ages).size > 1)
            throw new Error(name + '的成年设定未确认，请核对角色资料。');
        if (ages.length) return name + '，' + ages[0] + '岁，已成年';
        const player = /^(玩家|你|观察者|viewer)$/iu.test(name);
        if (/已成年|成年[男女]/u.test(profile) ||
            (player && /角色与玩家均已成年|玩家已成年/u.test(info.system_prompt || '')))
            return name + '，已成年';
        throw new Error(name + '缺少成年设定，请在角色资料中补充后重试。');
    }).join('；');
}

export function sceneImagePrompt(description) {
    return [description, appearance].join(' ');
}

export function readShot(output) {
    const match = output.trim().match(/^入镜人物[：:]([^\n]*)\n+([\s\S]+)$/u);
    if (!match) throw new Error('分镜缺少入镜人物清单，请重试。');
    const names = match[1].trim();
    const entries = names === '无' ? [] : names.split(/[、，,]/u).map(s => s.trim()).filter(Boolean);
    const views=new Map();
    const cast=entries.map(entry=>{
        const tag=/^(.+?)〔(正面|侧面|背面|回头)〕$/u.exec(entry);
        if(!tag)return entry;
        views.set(tag[1].trim(),tag[2]);
        return tag[1].trim();
    });
    if (!names || new Set(cast).size !== cast.length) throw new Error('分镜人物清单无效，请重试。');
    return { cast, views, description: match[2].trim() };
}

export function chooseReference(images,view){
    return images?.get(view) || (view==='回头' && images?.get('背面')) || images?.get('默认') || images?.get('正面');
}

export function descriptionMessages(info, text, context = {}, english = false) {
    return [
        { role: 'system', content: `你是成人互动小说的分镜师。以「当前镜头」中的本轮角色回复为依据，选取本轮最后一个明确、可见且具有表现力的瞬间。输出一段可直接用于生图的${english?'英文':'简体中文'}画面描述。
通读本轮动作的先后顺序，定格一个时间点。玩家输入用于理解回应；前文用于延续已经确立的人物、场地、道具和衣着。本轮有变化时采用变化后的状态。状态字段仅补充正文相容的可见事实，忽略占位值。区分已经发生的事与请求、回忆、假设。
首句确定观察者位置、取景方向和主要人物相对镜头的朝向。优先采用正文明确的观察视点；面向玩家叙述时默认从玩家眼睛看出去，玩家只在正文明确可见的范围内入画。将人物之间的方向换算成相对镜头的正面、背面或侧面。动作已落实且臀部正朝观察者时锁定正后方背面取景。分别追踪骨盆、躯干、头部和视线的朝向；只有转头时保持身体原朝向。之后的表情、细节与参考图均服从这个机位。
区分在场、入镜与画外的人。按实际入镜人数构图，用姓名或稳定特征标明各人的位置、动作和动作对象，保留必要的前后景、遮挡和支撑关系；独处、旁观和多人互动均按本轮事实呈现。
逐人延续衣物最近确定的穿戴状态，按定格时点更新覆盖范围和位置。
${appearance}描绘成年女性外阴时统一为无毛。正文写到口腔、阴道或肛门的内部或接触时，选择能清楚交代可见结构、接触部位以及体液、阴茎或其他物体所在位置的视角。借动作方向、受力和当下的身体反应呈现动势；残留物沿用当前状态。
从本轮选择最能显出人物情绪变化的一两个可见细节，让表情、姿态与互动对象处在同一瞬间。声音或内心感受只通过正文已有的可见线索传达，保留人物反应的强弱和克制。
成年人的亲密动作和可见性器官按原文直接命名。分别核对体液的种类、归属、所在部位及当前可见状态。分别判断动作是否正在发生、痕迹是否仍然可见；两者同时有依据时一并呈现。只在原文交代时描述来源、移动方向或状态变化。
阴道性交正在发生时，若本轮着重描写内壁接触或腔内精液，而正常机位会遮住该细节，可在原机位用动漫局部透视画法：仅将遮挡处作小范围剖视，把进入体内的那段阴茎画成带清晰轮廓的半透明叠影，表现阴道内壁的贴合位置。人物其余部分保持实色与原姿势。精液只在正文已明确交代时按当下位置呈现；仅有润滑液时保留其原貌。普通外部镜头沿用自然遮挡。
把最能传达当下欲望或情绪的可见细节放在画面中心，用准确的动词和空间关系形成张力。输出前核对人物、衣着、姿势、表情和体液是否属于同一瞬间。仅输出画面描述，省略标题、分析、台词和英文标签。` },
        { role: 'system', content: '输出第一行必须是“入镜人物：”后接按画面从左到右排列的原姓名，每个姓名后用〔正面〕、〔侧面〕、〔背面〕或〔回头〕标记该人相对镜头的躯干朝向和回头状态，各人以顿号分隔；无人写“无”。同名角色只列一次，匿名者用稳定称谓。第二行起输出'+(english?'纯英文分镜正文，使用英文外貌描述或人名音译':'简体中文分镜正文')+'。为每个入镜者分别写明有依据的身份、辨识度最高的外貌特征、位置、动作及动作对象。角色资料仅用于识别人，不把资料里提到的人自动加入画面，也不把性格、职业或泛称推断成具体脸型。' },
        { role: 'user', content: JSON.stringify({
            人物设定:clip(String(info.description || ''),3600),
            分角色美术设定:info.visual_cast && clip(JSON.stringify(info.visual_cast),3500),
            剧本背景:clip(String(info.scenario || ''),1000),
            年龄要求:'逐人沿用原卡明确的年龄，在分镜正文注明已成年及已知岁数。年龄不明时保留未知。玩家入镜时清单统一写“玩家”。',
            角色: info.name, 角色年龄:info.age, 过往对话仅供连续性:context.continuity,
            当前镜头:{目标消息位置:context.position,玩家本轮输入:context.playerInput,本轮状态:context.state,
                本轮角色回复:clip(text,6500)},
        }) },
    ];
}

function clip(text, limit) {
    if (text.length<=limit) return text;
    const head=Math.floor(limit/3);
    return text.slice(0,head)+'\n〔中段略〕\n'+text.slice(-(limit-head-7));
}
