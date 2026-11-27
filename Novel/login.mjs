import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const signingKey=randomBytes(32);
const lifetime=7*24*60*60;
const covers=['braids','sapphire'];
const publicFiles=new Map([
    ['/novel/login-linyin.png',['login-linyin.png','image/png']],
    ['/novel/login-sapphire.png',['login-sapphire.png','image/png']],
]);

function equal(a,b) {
    const first=Buffer.from(a), second=Buffer.from(b);
    return first.length===second.length && timingSafeEqual(first,second);
}
function signature(credentials,expiry,nonce) {
    return createHmac('sha256',signingKey).update(JSON.stringify([credentials,expiry,nonce])).digest('base64url');
}
export function signedIn(req,credentials) {
    const token=/(?:^|;\s*)nightread_session=(\d{10})\.([\w-]{22})\.([\w-]{43})(?:;|$)/.exec(req.headers.cookie || '');
    return Boolean(token && Number(token[1])>Date.now()/1000 && equal(token[3],signature(credentials,token[1],token[2])));
}

// Only the novel's two navigation parameters may survive a login.
function destination(url) {
    const next=new URLSearchParams();
    for(const key of ['page','story']) if(url.searchParams.has(key)) next.set(key,url.searchParams.get(key));
    return next.size?'?'+next:'';
}
export function redirectToLogin(req,res) {
    const url=new URL(req.url,'http://localhost');
    res.writeHead(303,{Location:'/novel/login'+destination(url),'Cache-Control':'no-store'}).end();
}
export async function loginRoute(req,res,loadCredentials,secure) {
    if(!req.url.startsWith('/novel/')) return false;
    const url=new URL('http://localhost'+req.url);
    const asset=publicFiles.get(url.pathname);
    if(!asset && url.pathname!=='/novel/login') return false;
    const read=req.method==='HEAD' || req.method==='GET';
    if(!read && (asset || req.method!=='POST')){
        res.writeHead(405,{Allow:asset?'GET, HEAD':'GET, HEAD, POST'}).end();return true;
    }
    try {
        if(asset){
            const bytes=await readFile(new URL('./public/'+asset[0],import.meta.url));
            res.writeHead(200,{'Content-Type':asset[1],'Content-Length':bytes.length,'Cache-Control':'private, max-age=86400'});
            res.end(req.method==='HEAD'?undefined:bytes);return true;
        }
        let invalid=false;
        let cover;
        if(!read){
            if(req.headers['content-type']?.split(';')[0]!=='application/x-www-form-urlencoded'){
                res.writeHead(415).end();return true;
            }
            let size=0;
            const chunks=[];
            for await(const chunk of req){
                size+=chunk.length;
                if(size>4096){res.writeHead(413).end();return true;}
                chunks.push(chunk);
            }
            const fields=new URLSearchParams(Buffer.concat(chunks).toString());
            const credentials=await loadCredentials();
            if(equal(JSON.stringify([fields.get('username'),fields.get('password')]),JSON.stringify(credentials))){
                const expiry=String(Math.floor(Date.now()/1000)+lifetime);
                const nonce=randomBytes(16).toString('base64url');
                const token=[expiry,nonce,signature(credentials,expiry,nonce)].join('.');
                res.writeHead(303,{'Location':'/novel/'+destination(url),'Cache-Control':'no-store',
                    'Set-Cookie':'nightread_session='+token+'; Path=/novel; HttpOnly; SameSite=Strict; Max-Age='+lifetime+(secure?'; Secure':'')}).end();
                return true;
            }
            invalid=true;
            const previousCover=fields.get('cover');
            if(covers.includes(previousCover)) cover=previousCover;
        }
        const html=await readFile(new URL('./public/login.html',import.meta.url),'utf8');
        res.writeHead(invalid?401:200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'same-origin',
            'Content-Security-Policy':"default-src 'none'; img-src 'self'; font-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});
        cover ??= covers[randomInt(covers.length)];
        res.end(req.method==='HEAD'?undefined:html.replaceAll('{{cover}}',cover).replace('<!-- error -->',invalid?'<p role="alert">用户名或密码有误，请重新输入。</p>':''));
    } catch { if(!res.headersSent)res.writeHead(503);res.end('暂时无法打开登录页，请稍后重试。'); }
    return true;
}
