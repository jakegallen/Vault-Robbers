'use strict';
/* Recomposite ALL ten mythics with the strong magenta+purple key so the leftover
   purple baseline is gone everywhere. No new Grok calls: reuse chars 7000-7009 + bgs 7500-7509. */
const sharp=require('sharp');const path=require('path');const R=__dirname;const S=2048;
function keyBg(d,w,h){for(let i=0;i<w*h;i++){const r=d[i*4],g=d[i*4+1],b=d[i*4+2];if(b>90&&r>80&&(r-g)>30&&(b-g)>22)d[i*4+3]=0;}return d;}
function bbox(d,w,h){let minX=w,minY=h,maxX=-1,maxY=-1;for(let y=0;y<h;y++)for(let x=0;x<w;x++){if(d[(y*w+x)*4+3]>40){if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;}}return{minX,minY,maxX,maxY};}
(async()=>{
  const sil=await sharp(path.join(R,'layers/body/shadow-silhouette.png')).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const sbb=bbox(sil.data,sil.info.width,sil.info.height);
  const targetH=(sbb.maxY-sbb.minY)*1.14; const targetCX=S/2, targetCY=(sbb.minY+sbb.maxY)/2*(S/sil.info.width);
  for(let i=0;i<9;i++){ // 990-998 (999 already rebuilt by lovers-ghost with strong key)
    const ci=7000+i, bi=7500+i, idx=990+i;
    const cm=await sharp(path.join(R,`mythic-src/${ci}-0.png`)).resize(S,S,{fit:'contain',background:{r:255,g:0,b:255}}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    keyBg(cm.data,cm.info.width,cm.info.height);
    const cb=bbox(cm.data,cm.info.width,cm.info.height);
    const charPng=await sharp(Buffer.from(cm.data),{raw:{width:cm.info.width,height:cm.info.height,channels:4}}).extract({left:cb.minX,top:cb.minY,width:Math.max(1,cb.maxX-cb.minX),height:Math.max(1,cb.maxY-cb.minY)}).png().toBuffer();
    const ch=cb.maxY-cb.minY, cw=cb.maxX-cb.minX; let scale=targetH/ch; const maxW=S*0.92; if(cw*scale>maxW) scale=maxW/cw;
    const nw=Math.round(cw*scale), nh=Math.round(ch*scale);
    const scaled=await sharp(charPng).resize(nw,nh).png().toBuffer();
    const layer=await sharp({create:{width:S,height:S,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite([{input:scaled,left:Math.round(targetCX-nw/2),top:Math.round(targetCY-nh/2)}]).png().toBuffer();
    const bgBuf=await sharp(path.join(R,`mythic-src/${bi}-0.png`)).resize(S,S,{fit:'cover'}).toBuffer();
    await sharp(bgBuf).composite([{input:layer}]).png().toFile(path.join(R,`layers/mythic/${idx}.png`));
    console.log(idx,'cleaned');
  }
  console.log('all 990-998 recomposited with strong key');
})();
