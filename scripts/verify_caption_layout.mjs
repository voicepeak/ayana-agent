/** Readable caption bubbles and geometry-based portrait avoidance in real Electron. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),args=process.argv.slice(2),option=k=>args.includes(k)?args[args.indexOf(k)+1]:undefined;
const require=createRequire(import.meta.url),{_electron}=require(require.resolve('playwright',{paths:[option('--playwright-root')||root]}));
const directory=path.join(root,'.runtime/benchmarks','caption-layout-'+Date.now()),data=path.join(directory,'profile');mkdirSync(path.join(data,'config'),{recursive:true});
writeFileSync(path.join(data,'config/local.json'),JSON.stringify({provider:'local',voice:{voice_mode:'silent'},stt:{provider:'disabled'},hotkey:'Control+Alt+F6',cancel_hotkey:'Control+Alt+F7',companion_ui:{frame_width:760,frame_height:620,font_size:24,portrait_side:'left',background_mode:'transparent',opacity:0}}));
let app,page,design;const report={checks:[],errors:[]};
const measure=()=>page.evaluate(()=>{
 const box=n=>{const b=n.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom};};
 const caption=document.querySelector('.is-current .cinematic-dialogue'),scene=document.querySelector('.portrait-canvas'),workspace=document.querySelector('.companion-workspace');
 return {portrait:box(document.querySelector('.portrait-stage')),scene:box(scene),workspace:box(workspace),mode:workspace.dataset.captionLayout,clip:getComputedStyle(scene).clipPath,bubble:caption&&{background:getComputedStyle(caption).backgroundColor,color:getComputedStyle(caption).color,border:getComputedStyle(caption).borderTopWidth,opacity:getComputedStyle(caption).opacity},frameOpacity:getComputedStyle(document.querySelector('.companion-shell')).getPropertyValue('--frame-opacity')};
});
const preview=patch=>page.evaluate(patch=>window.ayana.previewDesign(patch),patch);
try{
 app=await _electron.launch({executablePath:option('--packaged')||path.join(root,'apps/desktop/node_modules/electron/dist/electron.exe'),args:[...(option('--packaged')?[]:[path.join(root,'apps/desktop')]),'--user-data-dir='+data],env:{...process.env,AYANA_DATA_DIR:data,AYANA_REPOSITORY_ROOT:option('--packaged')?'':root,AYANA_PYTHON:option('--packaged')?'':path.join(root,'.venv/Scripts/python.exe')}});
 const windows=await app.windows();page=windows.find(w=>w.url().includes('window=chat'));design=windows.find(w=>w.url().includes('window=design'));windows.forEach(w=>w.on('pageerror',e=>report.errors.push(e.message)));
 await page.waitForFunction(()=>window.ayana.getState().then(s=>s.connected));await page.waitForFunction(()=>document.querySelector('img.character')?.naturalWidth>0);
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('window=chat'));for(const e of [{type:'user.message',text:'透明背景也要能读清楚。',generation_id:200},{type:'utterance.ready',utterance_id:'bubble',generation_id:200,speech_ja:'ゆっくり話そう。',audio_enabled:true},{type:'subtitle.ready',utterance_id:'bubble',generation_id:200,display_zh:'字幕保持清楚，立绘可以自由拖动。'},{type:'playback.started',utterance_id:'bubble',generation_id:200,total_samples:1000},{type:'playback.progress',utterance_id:'bubble',generation_id:200,total_samples:1000,played_samples:1000}])w.webContents.send('ayana:event',{protocol_version:1,...e});});
 await page.waitForTimeout(800);
 let m=await measure();assert.equal(m.mode,'right');assert(m.workspace.x>m.portrait.right);assert.equal(Number(m.frameOpacity),0);assert.equal(m.bubble.opacity,'1');assert(parseFloat(m.bubble.border)>0);assert(!m.bubble.background.endsWith(', 0)'));
 await page.screenshot({path:path.join(directory,'transparent.png'),omitBackground:true});report.checks.push('Transparent window at zero background opacity keeps an independent readable bubble and border; left portrait reserves a separate right caption area');
 const initial=m.workspace;
 const b=await page.locator('.portrait-stage').boundingBox(),scene=await page.locator('.portrait-canvas').boundingBox();
 await page.mouse.move(b.x+b.width/2,scene.y+Math.min(70,scene.height/4));await page.mouse.down();await page.mouse.move(scene.x+scene.width-b.width/2-8,scene.y+70,{steps:12});
 await page.waitForFunction(()=>document.querySelector('.caption-layout-preview'));
 m=await measure();assert.equal(m.workspace.x,initial.x,'During dragging only the target guide moves.');assert.equal(await page.locator('.caption-layout-preview').getAttribute('data-layout'),'left');
 await page.screenshot({path:path.join(directory,'drag-preview.png'),omitBackground:true});await page.mouse.up();await page.waitForTimeout(850);
 m=await measure();assert.equal(m.mode,'left');assert(m.workspace.right<m.portrait.x);assert.equal(await page.locator('.caption-layout-preview').count(),0);
 const stored=JSON.parse(readFileSync(path.join(data,'config/local.json'),'utf8'));assert(stored.companion_ui.portrait_x>0);await page.screenshot({path:path.join(directory,'portrait-right.png'),omitBackground:true});report.checks.push('A captured portrait drag shows its target guide; captions stay still while dragging and move to the free side after release; only the user portrait position is saved');
 await preview({portrait_side:'left',portrait_x:0,background_mode:'solid',background_color:'#f4efe5',opacity:100});await page.waitForTimeout(850);m=await measure();assert.equal(m.mode,'right');assert.equal(m.bubble.color,'rgb(55, 51, 44)');await page.screenshot({path:path.join(directory,'light.png'),omitBackground:true});
 await page.getByLabel('打开设计控件',{exact:true}).click();await design.getByRole('tab',{name:'便签',exact:true}).click();
 await app.evaluate(({app,dialog},file)=>{app.__captionDialog=dialog.showOpenDialog;dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},path.join(process.env.APPDATA,'Ayana/companion-background.png'));
 await design.getByLabel('便签背景',{exact:true}).selectOption('image');await design.getByRole('button',{name:'选择 / 更换背景图片',exact:true}).click();await app.evaluate(({app,dialog})=>{dialog.showOpenDialog=app.__captionDialog;});await design.getByLabel('收起设计控件',{exact:true}).click();
 await page.waitForTimeout(850);m=await measure();assert.equal(m.bubble.color,'rgb(241, 233, 224)');assert(parseFloat(m.bubble.border)>0);await page.screenshot({path:path.join(directory,'custom-image.png'),omitBackground:true});report.checks.push('Light colors and custom image backgrounds retain their own contrasting bubble text and border');
 const position=await page.locator('.portrait-stage').evaluate(n=>({left:n.style.left,top:n.style.top}));
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('window=chat')).setSize(400,620));await page.waitForTimeout(950);m=await measure();assert.equal(m.mode,'bottom');assert.notEqual(m.clip,'none');assert(m.workspace.bottom<=m.scene.bottom+1);assert(m.workspace.width<=m.scene.width);await page.screenshot({path:path.join(directory,'narrow-band.png'),omitBackground:true});
 const after=JSON.parse(readFileSync(path.join(data,'config/local.json'),'utf8'));assert.equal(after.companion_ui.portrait_x,stored.companion_ui.portrait_x);report.checks.push('Narrow windows use a bounded bottom subtitle band with portrait pixels clipped out of it; resize never changes the saved portrait position');
 assert.deepEqual(report.errors,[]);report.passed=true;report.geometry=m;
}catch(error){report.passed=false;report.failure=String(error);process.exitCode=1;if(page)await page.screenshot({path:path.join(directory,'failure.png'),omitBackground:true}).catch(()=>{});}
finally{if(app)await app.close();writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,directory},null,2));}
