import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {Jimp} from './art-codecs.mjs';
import { chooseReference, descriptionMessages, picturedAges, readShot, sceneImagePrompt } from './scene-description.mjs';
import { upstream } from './text-upstream.mjs';
import { database, media, atomic } from './mongo.mjs';

const jobs = database.collection('image_jobs');
const pending = ['queued', 'preparing', 'submitting', 'waiting', 'rendering'];
const headers = { 'Content-Type': 'application/json', apikey: '0000000000', 'Client-Agent': 'NightRead:1.0:scene-images' };
const endpoint = 'https://aihorde.net/api/v2/generate/';
const publicFields = { _id:0, id:1, mode:1, position:1, status:1, error:1, wait:1, created:1, updated:1 };
await jobs.updateMany({active:{$exists:false},status:{$in:pending}},{$set:{active:true}});
await jobs.createIndex({branch:1,position:1,active:1},{unique:true,partialFilterExpression:{active:true}});
await jobs.dropIndex('branch_1_position_1').catch(error=>{if(error.code!==27) throw error;});
await jobs.createIndex({branch:1,position:1,created:-1});

export function imageJobs(branch) {
    return jobs.aggregate([{$match:{branch}},{$sort:{position:1,created:-1,_id:-1}},
        {$group:{_id:'$position',latest:{$first:'$$ROOT'}}},{$replaceWith:'$latest'},{$project:publicFields}]).toArray();
}

export async function enqueueImage(branch, position, mode='free', requestId=randomUUID()) {
    const now=Date.now();
    await jobs.insertOne({_id:branch+'/'+position+'/'+requestId,id:randomUUID(),branch,position,mode,
        active:true,status:'queued',created:now,updated:now,attempts:0,next:0}).catch(error=>{
        if (error.code !== 11000) throw error;
    });
    return imageJobs(branch);
}

export function startImageWorker({ settings, source, directory }) {
    let preparing = false;
    let submitting = false;
    let lastSubmit = 0;
    const running = new Set();
    let paused = false;
    let epoch = 0;
    const update = (job, fields) => jobs.updateOne({ _id:job._id, id:job.id }, { $set:{ ...fields, ...(fields.status==='failed'?{active:false}:{}), updated:Date.now() } });
    async function prepare(job) {
        const { info, text, references, context } = await source(job.branch, job.position);
        const config = await settings();
        const provider = config.text;
        const compatible = provider.protocol === 'openai';
        const result = await upstream(provider, {
            model:provider.model, stream:false,
            ...(compatible ? {max_tokens:400,temperature:0.1} : {think:false, options:{num_ctx:8192,num_predict:400,temperature:0.1}}),
            messages:descriptionMessages(info,text,context,job.mode==='wai'),
        }, AbortSignal.timeout(120000));
        if (result.status === 429) {
            const reason = await result.text();
            if (/current generation|concurrent|in progress/i.test(reason)) {
                await update(job,{status:'queued', next:Date.now()+15000});
                return;
            }
            throw new Error('画面提示词请求已达服务限额，请稍后重试。');
        }
        if(!result.ok) throw new Error('准备画面描述失败，请重试。');
        const data=await result.json();
        const prompt=(compatible?data.choices?.[0]?.message?.content:data.message?.content)?.trim();
        if(!prompt || prompt.length>6000) throw new Error('画面描述为空，请重试。');
        const {cast,views,description}=readShot(prompt);
        if(job.mode==='wai'){
            if(!/[a-z]+\s+[a-z]+/i.test(description) || /[\p{Script=Han}]{3}/u.test(description)) throw new Error('WAI 英文分镜生成失败，请重试。');
        }else if(!/\p{Script=Han}/u.test(description) || /[a-z]{2,}(?:\s+[a-z]{2,}){3,}/i.test(description)) throw new Error('分镜模型未按要求输出中文，请重试。');
        const ages=picturedAges(info,cast);
        let referenceFile=null;
        let referenceNote='';
        const pictured=cast.filter(name=>chooseReference(references.get(name),views.get(name)));
        if(pictured.length){
            const sheet=new Jimp({width:512,height:768,color:0xe8e5e2ff});
            const columns=Math.ceil(Math.sqrt(pictured.length)), rows=Math.ceil(pictured.length/columns);
            const w=Math.floor(512/columns), h=Math.floor(768/rows);
            for(const [index,name] of pictured.entries()){
                const pic=await Jimp.read(await readFile(chooseReference(references.get(name),views.get(name))));
                pic.contain({w,h});
                sheet.composite(pic,(index%columns)*w,Math.floor(index/columns)*h);
            }
            referenceFile=job.id+'.reference.png';
            await writeFile(join(directory,referenceFile),await sheet.getBuffer('image/png'));
            referenceNote=' 参考图按从左到右、从上到下仅对应'+pictured.join('、')+'，分别沿用五官发型。其余人物按文字设定绘制，全员按本轮分镜重新构图。';
        }
        const profiles=cast.filter(name=>typeof info.visual_cast?.[name]==='string')
            .map(name=>name+'：'+info.visual_cast[name]).join(' ');
        const counted='画面共'+cast.length+'人。'+profiles;
        const imagePrompt=job.mode==='wai' ? [description,'Anime illustration. Visible people: '+cast.length+'.',
            pictured.length && 'Use the reference for identity only. In reading order, the reference portraits correspond to scene subjects '+pictured.map(name=>cast.indexOf(name)+1).join(', ')+'. Follow the described pose, clothing and setting.'].filter(Boolean).join(' ') :
            counted+description+' 动漫插画。'+referenceNote;
        await update(job,{promptModel:provider.model,prompt:imagePrompt,ages,cast,reference:referenceFile,status:'submitting',next:0});
    }
    async function renderWai(job) {
        const key=process.env.OPENUNCENSORED_API_KEY || await readFile(new URL('./.private/openuncensored.key',import.meta.url),'utf8').catch(()=> '');
        if(!key.trim()) throw new Error('快速生图尚未配置密钥。');
        const reference=job.reference && await readFile(join(directory,job.reference));
        const payload={model:'wai-illustrious',prompt:job.prompt,n:1,size:'1024x1536',response_format:'b64_json'};
        if(reference) Object.assign(payload,{images:['data:image/png;base64,'+reference.toString('base64')],strength:0.72});
        // Persist the claim before sending a billable request. Never replay it on a lost response.
        const claimed=await jobs.updateOne({_id:job._id,status:'submitting'},{$set:{status:'rendering',updated:Date.now(),next:Date.now()+9*60000}});
        if(!claimed.modifiedCount)return;
        const response=await fetch('https://api.openuncensored.com/v1/images/'+(reference?'edits':'generations'),{
            method:'POST',headers:{Authorization:'Bearer '+key.trim(),'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(480000)});
        if(!response.ok)throw new Error('WAI 快速生成失败（HTTP '+response.status+'）。');
        const data=await response.json();
        const output=data.data?.[0];
        if(!output)throw new Error('WAI 未返回图片。');
        await saveImage(job,output.b64_json||output.url,data.ou?.request_id);
    }
    async function submit(job) {
        if(typeof job.ages!=='string'){
            await update(job,{status:'queued',next:0});
            return;
        }
        const reference=job.reference && (await readFile(join(directory,job.reference))).toString('base64');
        const result=await fetch(endpoint+'async',{
            method:'POST',headers,signal:AbortSignal.timeout(45000),
            body:JSON.stringify({
                models:['MeinaMix'],prompt:sceneImagePrompt([job.ages,job.prompt].filter(Boolean).join('。')),...(reference?{source_image:reference,source_processing:'img2img'}:{}),
                nsfw:true,censor_nsfw:false,r2:true,shared:false,
                params:{n:1,width:512,height:job.height||768,steps:22,...(reference?{denoising_strength:0.72}:{})},
            }),
        });
        if(result.status===429){
            const delay=Math.max(3,Number(result.headers.get('retry-after'))||10);
            await update(job,{next:Date.now()+delay*1000,status:'submitting'});return;
        }
        const body=await result.json();
        if(result.status===403 && body.rc==='KudosUpfront' && job.height!==512){
            await update(job,{height:512,next:Date.now()+1500,status:'submitting'});return;
        }
        if(!result.ok||!body.id) throw new Error('图片队列暂时不可用，请重试。');
        await update(job,{status:'waiting',remote:body.id,submitted:Date.now(),next:Date.now()+8000});
    }
    async function poll(job) {
        const response=await fetch(endpoint+'check/'+job.remote,{signal:AbortSignal.timeout(15000)});
        if(response.status===404) throw new Error('图片任务已过期，请重新生成。');
        if(!response.ok) throw new Error('图片服务暂时无法连接。');
        const check=await response.json();
        if(check.faulted) throw new Error('生成节点失败，请重新生成。');
        if(!check.done){
            await update(job,{wait:check.wait_time,next:Date.now()+8000});return;
        }
        const result=await fetch(endpoint+'status/'+job.remote,{signal:AbortSignal.timeout(15000)});
        if(!result.ok) throw new Error('读取图片结果失败。');
        const value=await result.json();
        const generation=value.generations?.[0];
        if(!generation?.img||generation.censored||generation.state==='faulted') throw new Error('节点未返回可用图片，请重试。');
        await saveImage(job,generation.img);
    }
    async function saveImage(job,source,receipt) {
        if(typeof source!=='string'||!source)throw new Error('图片数据为空。');
        let buffer;
        if(source.startsWith('https://')){
            const r=await fetch(source,{signal:AbortSignal.timeout(30000)});
            if(!r.ok) throw new Error('下载图片失败。');
            if(Number(r.headers.get('content-length'))>20000000) throw new Error('图片过大。');
            buffer=Buffer.from(await r.arrayBuffer());
        }else buffer=Buffer.from(source.replace(/^data:image\/[^;]+;base64,/i,''),'base64');
        if(buffer.length>20000000) throw new Error('图片过大。');
        const pic=await Jimp.read(buffer);
        let lo=255,hi=0;
        for(let i=0;i<pic.bitmap.data.length;i++) if(i%4!==3){lo=Math.min(lo,pic.bitmap.data[i]);hi=Math.max(hi,pic.bitmap.data[i]);}
        if(hi-lo<3) throw new Error('生成节点返回了空白图，请重试。');
        const filename=job.id+'.png';
        await writeFile(join(directory,filename),await pic.getBuffer('image/png'));
        await atomic(async session=>{
            await media.updateOne({_id:job.id},{$setOnInsert:{id:job.id,branch:job.branch,position:job.position,type:'image',mode:job.mode||'free',file:filename,ordinal:Date.now()}},{upsert:true,session});
            await jobs.updateOne({_id:job._id,id:job.id},{$set:{status:'done',active:false,updated:Date.now(),...(receipt?{receipt}:{})}},{session});
        });
    }
    async function execute(job,operation) {
        if(running.has(job.id))return;
        running.add(job.id);
        try{await operation(job)}catch(error){
            const attempts=(job.attempts||0)+1;
            const retry=job.remote && attempts<5 && /fetch|timeout|下载|读取|连接|terminated/i.test(error.message);
            await update(job,{attempts,status:retry?'waiting':'failed',error:retry?'':error.message,next:Date.now()+15000}).catch(()=>{});
        }finally{running.delete(job.id)}
    }
    const tick=async()=>{
        if(paused)return;
        const version=epoch;
        try{
            const list=await jobs.find({status:{$in:pending},next:{$lte:Date.now()}}).sort({created:1}).toArray();
            for(const job of list){
                if(paused || version!==epoch)return;
                if(running.has(job.id))continue;
                if(job.status==='rendering'){await update(job,{status:'failed',error:'WAI 请求已发出，结果未能取回。再次生成将另计费用。'});continue}
                if(Date.now()-job.created>45*60000){await update(job,{status:'failed',error:'排队时间过长，请重试。'});continue}
                if(job.status==='waiting'){void execute(job,poll);continue}
                if(['queued','preparing'].includes(job.status)&&!preparing){
                    preparing=true;
                    void execute(job,async j=>{try{await update(j,{status:'preparing'});await prepare(j)}finally{preparing=false}});
                }
                if(job.status==='submitting' && job.mode==='wai'){void execute(job,renderWai);continue}
                if(job.status==='submitting'&&!submitting&&Date.now()-lastSubmit>700){
                    submitting=true;lastSubmit=Date.now();
                    void execute(job,async j=>{try{await submit(j)}finally{submitting=false}});
                }
            }
        }catch{/* Retry the persisted queue after temporary database outages. */}
    };
    const timer=setInterval(tick,1000);timer.unref();void tick();
    return {
        async pause() {
            paused=true;
            epoch++;
            while(running.size) await new Promise(resolve=>setTimeout(resolve,100));
        },
        resume() { paused=false; }
    };
}
