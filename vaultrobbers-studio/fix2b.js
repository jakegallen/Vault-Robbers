'use strict';
const sharp = require('sharp');
const path = require('path');
const R = __dirname; const S = 2048;
function keyMagenta(d,w,h){for(let i=0;i<w*h;i++){const r=d[i*4],g=d[i*4+1],b=d[i*4+2];if(r>150&&b>110&&g<105&&(r-g)>60&&(b-g)>30)d[i*4+3]=0;}return d;}
function bbox(d,w,h){let minX=w,minY=h,maxX=-1,maxY=-1;for(let y=0;y<h;y++)for(let x=0;x<w;x++){if(d[(y*w+x)*4+3]>40){if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;}}return{minX,minY,maxX,maxY};}
(async()=>{
  const sil=await sharp(path.join(R,'layers/body/shadow-silhouette.png')).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const sb=bbox(sil.data,sil.info.width,sil.info.height);
  const targetH=(sb.maxY-sb.minY)*1.14; const targetCX=S/2, targetCY=(sb.minY+sb.maxY)/2*(S/sil.info.width);
  const cm=await sharp(path.join(R,'mythic-src/7009-0.png')).resize(S,S,{fit:'contain',background:{r:255,g:0,b:255}}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  keyMagenta(cm.data,cm.info.width,cm.info.height);
  const cb=bbox(cm.data,cm.info.width,cm.info.height);
  const charPng=await sharp(Buffer.from(cm.data),{raw:{width:cm.info.width,height:cm.info.height,channels:4}}).extract({left:cb.minX,top:cb.minY,width:Math.max(1,cb.maxX-cb.minX),height:Math.max(1,cb.maxY-cb.minY)}).png().toBuffer();
  const ch=cb.maxY-cb.minY, cw=cb.maxX-cb.minX;
  let scale=(targetH*1.08)/ch;                 // prefer height
  const maxW=S*0.94;
  if(cw*scale>maxW) scale=maxW/cw;             // clamp to width so the duo fits
  const nw=Math.round(cw*scale), nh=Math.round(ch*scale);
  const scaled=await sharp(charPng).resize(nw,nh).png().toBuffer();
  const layer=await sharp({create:{width:S,height:S,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite([{input:scaled,left:Math.round(targetCX-nw/2),top:Math.round(targetCY-nh/2)}]).png().toBuffer();
  const bgBuf=await sharp(path.join(R,'mythic-src/7509-0.png')).resize(S,S,{fit:'cover'}).toBuffer();
  await sharp(bgBuf).composite([{input:layer}]).png().toFile(path.join(R,'layers/mythic/999.png'));
  console.log('999 duo done', nw, nh);
})();
