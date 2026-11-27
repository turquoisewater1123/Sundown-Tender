import { readFile } from 'node:fs/promises';
import { createJimp } from '../SillyTavern/node_modules/@jimp/core/dist/esm/index.js';
import { methods as resize } from '../SillyTavern/node_modules/@jimp/plugin-resize/dist/esm/index.js';
import { PNG } from '../SillyTavern/node_modules/pngjs/lib/png.js';
import jpeg from '../SillyTavern/node_modules/jpeg-js/index.js';
import decodeWebp, { init as initWebp } from '../SillyTavern/node_modules/@jsquash/webp/decode.js';
import encodeWebp,{init as initEncoder} from '../SillyTavern/node_modules/@jsquash/webp/encode.js';
import {methods as contain} from '../SillyTavern/node_modules/@jimp/plugin-contain/dist/esm/index.js';
if(!globalThis.ImageData)globalThis.ImageData=class {constructor(data,width,height){Object.assign(this,{data,width,height})}};
await initEncoder(await WebAssembly.compile(await readFile(new URL('../SillyTavern/node_modules/@jsquash/webp/codec/enc/webp_enc_simd.wasm',import.meta.url))));
await initWebp(await WebAssembly.compile(await readFile(new URL('../SillyTavern/node_modules/@jsquash/webp/codec/dec/webp_dec.wasm',import.meta.url))));
export const Jimp=createJimp({plugins:[resize,contain],formats:[
    ()=>({mime:'image/png',encode:bitmap=>PNG.sync.write(bitmap),decode:bytes=>PNG.sync.read(bytes)}),
    ()=>({mime:'image/jpeg',encode:bitmap=>jpeg.encode(bitmap,90).data,decode:bytes=>jpeg.decode(bytes,{useTArray:true})}),
    ()=>({mime:'image/webp',encode:async bitmap=>Buffer.from(await encodeWebp(bitmap,{quality:92})),decode:async bytes=>{const pic=await decodeWebp(bytes);return {...pic,data:Buffer.from(pic.data)}}}),
]});
