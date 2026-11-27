import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright-core';

await mkdir('logs',{recursive:true});
const directory=await mkdtemp(resolve('logs/scene-channels-'));
process.env.NOVEL_DATA_DIR=directory;
process.env.NOVEL_QA_CLEANUP='1';
process.env.OPENUNCENSORED_API_KEY='fixture';
process.env.NOVEL_SETTINGS=join(directory,'settings.json');
const settings=JSON.parse(await readFile('Novel/settings.example.json','utf8'));
settings.text={protocol:'openai',url:'https://fixture.invalid/describe',model:'fixture'};
await writeFile(process.env.NOVEL_SETTINGS,JSON.stringify(settings));
const sample=(await readFile('Novel/packs/01-last-broadcast/default.png')).toString('base64');
const fetchLocal=globalThis.fetch;
const submissions=[];
globalThis.fetch=async(url,options)=>{
    if(String(url).startsWith('http://127.0.0.1:'))return fetchLocal(url,options);
    if(url===settings.text.url){
        const english=JSON.parse(options.body).messages[1].content.includes('纯英文');
        return Response.json({choices:[{message:{content:'入镜人物：许简宁〔正面〕\n'+(english?'An adult radio host sits by the microphone.':'许简宁坐在话筒旁。')}}]});
    }
    if(String(url).endsWith('/async')){
        const input=JSON.parse(options.body);
        assert.deepEqual(input.models,['MeinaMix']);
        assert.ok(input.source_image);
        submissions.push('free');
        return Response.json({id:'horde-test'});
    }
    if(String(url).includes('/check/'))return Response.json({done:true});
    if(String(url).includes('/status/'))return Response.json({generations:[{img:sample}]});
    if(String(url)==='https://api.openuncensored.com/v1/images/edits'){
        const input=JSON.parse(options.body);
        assert.equal(options.headers.Authorization,'Bearer fixture');
        assert.equal(input.model,'wai-illustrious');
        assert.equal(input.n,1);
        assert.match(input.images[0],/^data:image\/png;base64,/);
        assert.match(input.prompt,/radio host/);
        assert.doesNotMatch(input.prompt,/\p{Script=Han}/u);
        submissions.push('wai');
        return Response.json({data:[{b64_json:sample}],ou:{request_id:'fixture'}});
    }
    throw Error('Unexpected request: '+url);
};
const {handleNovel,closeNovelData}=await import('../../Novel/server.mjs');
const {branches,messages,media}=await import('../../Novel/mongo.mjs');
const id='gallery-modes';
await branches.insertOne({_id:id,id,card:'pack:01-last-broadcast',title:'图片通道测试',created:Date.now()});
await messages.insertOne({branch:id,role:'assistant',position:0,text:'许简宁坐在话筒旁。',state:{}});
const server=createServer((req,res)=>handleNovel(req,res,true));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port+'/novel/';
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
try{
    const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,serviceWorkers:'block'});
    page.setDefaultTimeout(45000);
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(branch=>history.replaceState({nightread:true,page:'reading',branch},''),id);
    await page.goto(base);
    const slot=page.locator('[data-scene-position="0"]');
    const choice=slot.locator('.scene-mode');
    const button=slot.locator('.scene-generate');
    assert.equal(await choice.inputValue(),'free');
    await button.click();
    await slot.locator('.scene-figure').first().waitFor();
    assert.equal(await button.innerText(),'再生成一张');
    await choice.selectOption('wai');
    const capture=page.waitForRequest(req=>req.method()==='POST' && req.url().includes('/scene-images/'));
    await button.click();
    const original=(await capture).postDataJSON();
    const images=slot.locator('.scene-figure');
    await images.nth(1).waitFor();
    const post=(path,input)=>fetchLocal(base+'api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}).then(r=>r.json());
    await post('scene-images/'+id,original);
    assert.deepEqual(submissions,['free','wai']);
    const fork=await post('branches',{parent:id,position:0});
    assert.equal(fork.messages[0].media.length,2);
    await page.reload();
    await images.nth(1).waitFor();
    const first=await images.first().locator('img').getAttribute('src');
    const second=await images.nth(1).locator('img').getAttribute('src');
    assert.notEqual(first,second);
    page.once('dialog',dialog=>dialog.accept());
    await images.first().locator('.scene-delete').click();
    await images.nth(1).waitFor({state:'detached'});
    await page.reload();
    await images.first().waitFor();
    assert.equal(await images.count(),1);
    assert.equal(await images.first().locator('img').getAttribute('src'),second);
    assert.equal((await fetchLocal(base+'media/'+fork.messages[0].media[0].id)).status,200);
    assert.equal(await media.countDocuments({branch:id}),1);
    assert.deepEqual(submissions,['free','wai']);
    assert.deepEqual(errors,[]);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    console.log('PASS 390px mobile: free → WAI, append, replay deduplication, delete, reload, fork retention.');
}finally{
    await browser.close();
    await new Promise(resolve=>server.close(resolve));
    await closeNovelData();
}
