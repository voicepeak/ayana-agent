/** Isolated subtitle retirement, scroll ownership and real history pagination. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),args=process.argv.slice(2),option=k=>args.includes(k)?args[args.indexOf(k)+1]:undefined;
const require=createRequire(import.meta.url),{_electron}=require(require.resolve('playwright',{paths:[option('--playwright-root')||root]}));
const directory=path.join(root,'.runtime/benchmarks',`cinematic-memory-${Date.now()}`),data=path.join(directory,'profile');
mkdirSync(path.join(data,'config'),{recursive:true});
writeFileSync(path.join(data,'config/local.json'),JSON.stringify({provider:'local',voice:{voice_mode:'silent'},stt:{provider:'disabled'},hotkey:'Control+Alt+F6',cancel_hotkey:'Control+Alt+F7',companion_ui:{frame_width:760,frame_height:620,font_size:26,background_mode:'minimal',opacity:100,show_japanese:true,translation_language:'ja'}}));
let app,page;const report={checks:[],errors:[]};
const emit=events=>app.evaluate(({BrowserWindow},events)=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('window=chat'));events.forEach(e=>w.webContents.send('ayana:event',{protocol_version:1,...e}));},events);
const reply=(id,text)=>[{type:'utterance.ready',generation_id:100,utterance_id:id,speech_ja:'ゆっくり話そう。',audio_enabled:true},{type:'subtitle.ready',generation_id:100,utterance_id:id,display_zh:text},{type:'playback.started',generation_id:100,utterance_id:id,total_samples:1000},{type:'playback.progress',generation_id:100,utterance_id:id,played_samples:1000,total_samples:1000}];
const row=id=>page.locator(`[data-caption-id="${id}"]`);
try{
 app=await _electron.launch({executablePath:option('--packaged')||path.join(root,'apps/desktop/node_modules/electron/dist/electron.exe'),args:[...(option('--packaged')?[]:[path.join(root,'apps/desktop')]),`--user-data-dir=${data}`],env:{...process.env,AYANA_DATA_DIR:data,AYANA_REPOSITORY_ROOT:option('--packaged')?'':root,AYANA_PYTHON:option('--packaged')?'':path.join(root,'.venv/Scripts/python.exe')},timeout:30000});
 await app.evaluate(({app})=>{app.__memoryErrors=[];process.on('uncaughtException',error=>{app.__memoryErrors.push(String(error));console.error('TEST_UNCAUGHT',String(error));});});
 app.process().stderr.on('data',v=>{if(v.toString().includes('TEST_UNCAUGHT'))report.errors.push(v.toString());});
 page=(await app.windows()).find(w=>w.url().includes('window=chat'));page.on('pageerror',e=>report.errors.push(e.message));
 await page.waitForFunction(()=>window.ayana.getState().then(s=>s.connected));
 await page.waitForFunction(()=>document.querySelector('img.character')?.naturalWidth>0);
 assert.equal(await page.getByLabel('查看上下文',{exact:true}).count(),0);
 await emit([{type:'user.message',generation_id:100,turn_id:'pinned-question',text:'我们一起把这个界面做好。'},...reply('memory-one','嗯，我在这里。')]);
 await row('memory-one').locator('.cinematic-shot').waitFor();
 await page.waitForTimeout(150);
 const before=await row('memory-one').boundingBox();
 await page.screenshot({path:path.join(directory,'foreground.png'),omitBackground:true});
 await emit([{type:'playback.ended',generation_id:100,utterance_id:'memory-one',played_samples:1000,total_samples:1000}]);
 await page.waitForFunction(()=>document.querySelector('[data-caption-id="memory-one"]')?.classList.contains('is-current'));
 await emit(reply('memory-two','下一句清晰地进入视觉中心。'));
 await page.waitForFunction(()=>document.querySelector('[data-caption-id="memory-one"]')?.classList.contains('is-memory'));
 const animation=await row('memory-one').evaluate(n=>n.getAnimations().map(a=>({duration:a.effect.getTiming().duration,frames:a.effect.getKeyframes()})));
 assert(animation.length>0,'Retirement has an actual smooth transform/opacity animation.');
 await page.waitForTimeout(750);
 const after=await row('memory-one').boundingBox(),retiredStyle=await row('memory-one').evaluate(n=>({opacity:Number(getComputedStyle(n.querySelector('.cinematic-shot')).opacity),z:getComputedStyle(n).zIndex}));
 report.retirement={before,after,style:retiredStyle,animation};assert(after.y<before.y,'The completed caption moves upward.');assert(retiredStyle.opacity<.95);
 await emit(reply('memory-two','下一句保持清晰，上一句留在后面。'));
 assert.equal(await row('memory-two').evaluate(n=>getComputedStyle(n).opacity),'1');
 await page.waitForTimeout(750);assert(Number(await row('memory-two').evaluate(n=>getComputedStyle(n).zIndex))>Number(retiredStyle.z));
 await page.waitForTimeout(750);
 await page.screenshot({path:path.join(directory,'two-layers.png'),omitBackground:true});
 assert.equal(await page.locator('.cinematic-memory .cinematic-question').count(),0);
 assert((await page.locator('.cinematic-question').textContent()).includes('我们一起把这个界面做好。'));
 report.checks.push('No history button; finished speech moves upward with transform/opacity animation to a lower layer; new speech stays clear; user question is pinned independently');

 const cid=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('window=chat')).webContents.executeJavaScript('window.ayana.getState().then(s=>s.events.filter(e=>e.type==="conversations.ready").at(-1).current.conversation_id)'));
 // Seed only this test profile through the same persistent store used by the runtime.
 execFileSync(path.join(root,'.venv/Scripts/python.exe'),['-c',`from pathlib import Path
from services.agent.storage import ConversationStore
import sys
s=ConversationStore(Path(sys.argv[1])); cid=sys.argv[2]
for i in range(135):
 uid='older-'+str(i)
 e=dict(protocol_version=1,session_id='memory-fixture',conversation_id=cid,turn_id='history-turn',generation_id=0,utterance_id=uid)
 s.commit(dict(e,type='utterance.ready',speech_ja='昔の台詞。'))
 s.commit(dict(e,type='subtitle.ready',display_zh='历史台词 '+str(i)+'，可以向上滚动查看。'))
 s.commit(dict(e,type='utterance.displayed'))
s.db.close()`,path.join(data,'.runtime/history.sqlite3'),cid],{cwd:root,windowsHide:true});
 await page.evaluate(()=>window.ayana.send({type:'history.get'}));
 await page.waitForFunction(()=>document.querySelectorAll('.cinematic-memory-row').length>=100);
 const questionBefore=await page.locator('.cinematic-question').boundingBox();
 await page.locator('.cinematic-memory').evaluate(n=>{n.scrollTop=Math.max(0,n.scrollHeight-n.clientHeight-300);n.dispatchEvent(new Event('scroll'));});
 const viewport=await page.locator('.cinematic-memory').evaluate(n=>({top:n.scrollTop,height:n.scrollHeight}));
 await emit(reply('memory-three','看旧台词的时候，不会抢走滚动位置。'));
 await page.waitForTimeout(750);
 assert(Math.abs((await page.locator('.cinematic-memory').evaluate(n=>n.scrollTop))-viewport.top)<2,'New speech cannot pull a reader to the bottom.');
 assert.deepEqual(await page.locator('.cinematic-question').boundingBox(),questionBefore);
 await page.screenshot({path:path.join(directory,'reading-history.png'),omitBackground:true});
 // Moving to the top automatically requests the next real page; preserve an existing row's screen position.
 const anchor=await page.locator('[data-caption-id="older-35"]').boundingBox();
 await page.locator('.cinematic-memory').evaluate(n=>{n.scrollTop=0;n.dispatchEvent(new Event('scroll'));});
 const anchored=await page.locator('[data-caption-id="older-35"]').boundingBox();
 await page.waitForFunction(()=>document.querySelector('[data-caption-id="older-0"]'));
 await page.waitForTimeout(200);
 const restored=await page.locator('[data-caption-id="older-35"]').boundingBox();
 assert(Math.abs(anchored.y-restored.y)<3,'Prepending older records preserves the reading anchor.');
 assert.equal(await page.locator('[data-caption-id="older-35"]').count(),1);
 report.pagination={anchored,restored,initialAnchor:anchor};
 report.checks.push('Real persisted history loads automatically at the top without duplication or viewport jumps; manual reading position and pinned question survive incoming replies');
 await emit([{type:'utterance.ready',generation_id:100,utterance_id:'future-unheard',speech_ja:'まだ表示していない',audio_enabled:true},{type:'subtitle.ready',generation_id:100,utterance_id:'future-unheard',display_zh:'不能提前泄露的未来台词'}]);
 assert.equal(await row('future-unheard').count(),0);
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.locator('.cinematic-memory').evaluate(n=>{n.scrollTop=n.scrollHeight;n.dispatchEvent(new Event('scroll'));});
 await emit([{type:'playback.ended',generation_id:100,utterance_id:'memory-three',played_samples:1000,total_samples:1000}]);
 await emit(reply('reduced-next','减少动态时也保留前一句。'));await page.waitForFunction(()=>document.querySelector('[data-caption-id="memory-three"]')?.classList.contains('is-memory'));
 assert.equal(await row('memory-three').evaluate(n=>n.getAnimations().length),0);
 report.checks.push('Queued speech is not exposed early and reduced-motion preferences disable movement');
 assert.deepEqual(report.errors,[]);assert.deepEqual(await app.evaluate(({app})=>app.__memoryErrors),[]);report.passed=true;
}catch(error){report.passed=false;report.failure=String(error);process.exitCode=1;if(page)await page.screenshot({path:path.join(directory,'failure.png'),omitBackground:true}).catch(()=>{});}
finally{if(app)await app.close();writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,directory},null,2));}
