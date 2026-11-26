const panel = document.getElementById('diagnostics');
const refresh = document.getElementById('refresh');

function row(label, value) {
    const line = document.createElement('div');
    line.className = 'field';
    const title = document.createElement('dt');
    title.textContent = label;
    const entry = document.createElement('dd');
    entry.textContent = value;
    line.append(title, entry);
    return line;
}

async function load() {
    refresh.disabled = true;
    try {
        const response = await fetch('api/diagnostics');
        if (!response.ok) throw new Error();
        const result = await response.json();
        const previous = result.lastGeneration;
        const engines = [['transcription', '听写'], ['speech', '配音'], ['image', '插画'], ['video', '视频']];
        panel.replaceChildren(
            row('手机端模型', result.model),
            row('上下文上限', result.context + ' Token'),
            row('单轮输出上限', result.output + ' Token'),
            row('生成中的存档', result.running),
            row('首段等待', previous?.firstToken == null ? '等待生成' : previous.firstToken + ' 毫秒'),
            row('最近生成速度', previous?.speed == null ? '暂无数据' : previous.speed.toFixed(1) + ' Token/秒'),
            row('模型显存', result.loaded == null ? '暂无本地运行数据' : result.loaded.map(model =>
                model.name + ' · ' + (model.vram / 1024 ** 3).toFixed(2) + ' GiB').join('\n') || '本地模型未加载'),
            ...engines.map(([key, label]) => row(label, result.capabilities[key] ? '已配置' : '未配置')),
        );
    } catch {
        panel.replaceChildren(row('连接失败', '请检查电脑上的小说服务。'));
    } finally {
        refresh.disabled = false;
    }
}

refresh.onclick = load;
void load();
