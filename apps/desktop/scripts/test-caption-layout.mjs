import assert from 'node:assert/strict';
import {build} from 'esbuild';
const compiled=await build({entryPoints:['renderer/captionLayout.ts','renderer/portraitGeometry.ts'],bundle:true,format:'esm',write:false,outdir:'test-memory'});
const modules=await Promise.all(compiled.outputFiles.map(file=>import('data:text/javascript;base64,'+Buffer.from(file.text).toString('base64'))));
const {captionLayout}=modules.find(module=>module.captionLayout),{portraitLayout}=modules.find(module=>module.portraitLayout);
for(const width of [360,400,760,1100])for(const height of [240,460,620])for(const size of [160,320,640])for(const x of [-900,0,900]){
 const area={width,height},portrait=portraitLayout(area,472/1656,{portrait_size:size,portrait_side:'right',portrait_x:x,portrait_y:0});
 const saved=JSON.stringify(portrait),layout=captionLayout({area,portrait,dragging:false},26);
 assert.equal(JSON.stringify(portrait),saved,'Caption placement cannot change portrait coordinates.');
 assert(layout.x>=0&&layout.y>=0&&layout.x+layout.width<=width+1&&layout.y+layout.height<=height+1,'Caption band stays inside its scene.');
 if(layout.mode==='left')assert(layout.x+layout.width<=portrait.x-15);
 if(layout.mode==='right')assert(layout.x>=portrait.x+portrait.width+15);
 if(layout.mode==='bottom')assert(height-layout.portraitBottomInset<=layout.y,'Portrait is clipped above the subtitle band.');
}
console.log('PASS: caption placement avoids both portrait sides, reserves narrow-window bands and preserves user coordinates across resize and scale.');
