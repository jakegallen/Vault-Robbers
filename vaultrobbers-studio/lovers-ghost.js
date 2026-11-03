'use strict';
/* Lovers (999): two ghost skull robbers, CLOSE together as partners, no purple
   ground line. Strong magenta/purple key removes the leftover horizontal lines. */
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const R = __dirname; const S = 2048;
const TOK = process.env.DASHBOARD_TOKEN;
const APIE = 'http://localhost:4000/pub/main/vaultrobbers-studio/api/edit-1of1';
const STYLE = ' Flat hand drawn cartoon, bold black outlines, flat colors, no text, no watermark.';
async function post(url, body){for(let a=0;a<6;a++){try{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOK},body:JSON.stringify(body)});const j=await r.json();if(j.ok)return j;console.log(' err',JSON.stringify(j).slice(0,90));}catch(e){console.log(' retry',a,String(e).slice(0,40));}await new Promise(z=>setTimeout(z,7000));}return null;}
// strong key: zero any magenta OR purple pixel (red and blue both above green)
function keyBg(d,w,h){for(let i=0;i<w*h;i++){const r=d[i*4],g=d[i*4+1],b=d[i*4+2];if(b>90&&r>80&&(r-g)>30&&(b-g)>22)d[i*4+3]=0;}return d;}
function bbox(d,w,h){let minX=w,minY=h,maxX=-1,maxY=-1;for(let y=0;y<h;y++)for(let x=0;x<w;x++){if(d[(y*w+x)*4+3]>40){if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;}}return{minX,minY,maxX,maxY};}
(async()=>{
  const SB=1024;
  const dmbg=await sharp({create:{width:SB,height:SB,channels:3,background:{r:255,g:0,b:255}}}).png().toBuffer();
  const bodyB=await sharp(path.join(R,'layers/body/shadow-silhouette.png')).resize(Math.round(SB*0.54),Math.round(SB*0.54),{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).toBuffer();
  const skullB=await sharp(path.join(R,'layers/head/classic-skull.png')).resize(Math.round(SB*0.54),Math.round(SB*0.54),{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).toBuffer();
  const yoff=Math.round(SB*0.22);
  const duoBase=await sharp(dmbg).composite([
    {input:bodyB,left:Math.round(SB*0.14),top:yoff},{input:skullB,left:Math.round(SB*0.14),top:yoff},
    {input:bodyB,left:Math.round(SB*0.36),top:yoff},{input:skullB,left:Math.round(SB*0.36),top:yoff},
  ]).png().toBuffer();
  const duoUri='data:image/png;base64,'+duoBase.toString('base64');
  const prompt="Two hooded skull-faced ghost robbers standing CLOSE together, shoulder to shoulder as an outlaw couple and partners, Bonnie and Clyde. BOTH keep their rounded black hooded body and white bony skull face exactly like the base, NO human skin, NO human face, NO legs. The LEFT robber wears a red beret tilted on its skull and a draped dark-red cloak over the hood, holding an old revolver, with a small black domino mask over the skull eye sockets. The RIGHT robber wears a flat brown newsboy cap and a brown leather jacket over the hood, holding a small stack of cash, with a small black domino mask over the skull eye sockets. Keep the solid flat magenta background. Do NOT draw any purple line, horizontal line, underline, ground line or shadow bar."+STYLE;
  console.log('editing lovers-ghost (close + no line)');
  await post(APIE,{index:7009,prompt,image:duoUri});
  // composite: key FIRST (kills purple line so bbox is tight to the figures), then scale/place
  const sil=await sharp(path.join(R,'layers/body/shadow-silhouette.png')).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const sbb=bbox(sil.data,sil.info.width,sil.info.height);
  const targetH=(sbb.maxY-sbb.minY)*1.14; const targetCX=S/2, targetCY=(sbb.minY+sbb.maxY)/2*(S/sil.info.width);
  const cm=await sharp(path.join(R,'mythic-src/7009-0.png')).resize(S,S,{fit:'contain',background:{r:255,g:0,b:255}}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  keyBg(cm.data,cm.info.width,cm.info.height);
  const cb=bbox(cm.data,cm.info.width,cm.info.height);
  const charPng=await sharp(Buffer.from(cm.data),{raw:{width:cm.info.width,height:cm.info.height,channels:4}}).extract({left:cb.minX,top:cb.minY,width:Math.max(1,cb.maxX-cb.minX),height:Math.max(1,cb.maxY-cb.minY)}).png().toBuffer();
  const ch=cb.maxY-cb.minY, cw=cb.maxX-cb.minX; let scale=(targetH*1.04)/ch; const maxW=S*0.9; if(cw*scale>maxW) scale=maxW/cw;
  const nw=Math.round(cw*scale), nh=Math.round(ch*scale);
  const scaled=await sharp(charPng).resize(nw,nh).png().toBuffer();
  const layer=await sharp({create:{width:S,height:S,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite([{input:scaled,left:Math.round(targetCX-nw/2),top:Math.round(targetCY-nh/2)}]).png().toBuffer();
  const bgBuf=await sharp(path.join(R,'mythic-src/7509-0.png')).resize(S,S,{fit:'cover'}).toBuffer();
  await sharp(bgBuf).composite([{input:layer}]).png().toFile(path.join(R,'layers/mythic/999.png'));
  console.log('lovers-ghost done',nw,nh,'bbox',cb.minX,cb.minY,cb.maxX,cb.maxY);
})();
