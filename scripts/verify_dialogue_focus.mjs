import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),args=process.argv.slice(2),option=k=>args.includes(k)?args[args.indexOf(k)+1]:undefined;
const require=createRequire(import.meta.url),{_electron}=require(require.resolve('playwright',{paths:[option('--playwright-root')||root]}));
const directory=path.join(root,'.runtime/benchmarks','dialogue-focus-'+Date.now()),data=path.join(directory,'profile');mkdirSync(path.join(data,'config'),{recursive:true});
writeFileSync(path.join(data,'config/local.json'),JSON.stringify({provider:'local',voice:{voice_mode:'silent'},stt:{provider:'disabled'},hotkey:'Control+Alt+F6',cancel_hotkey:'Control+Alt+F7',companion_ui:{frame_width:760,frame_height:620,font_size:24}}));
const launch=()=>_electron.launch({executablePath:option('--packaged')||path.join(root,'apps/desktop/node_modules/electron/dist/electron.exe'),args:[...(option('--packaged')?[]:[path.join(root,'apps/desktop')]),'--user-data-dir='+data],env:{...process.env,AYANA_DATA_DIR:data,AYANA_REPOSITORY_ROOT:option('--packaged')?'':root,AYANA_PYTHON:option('--packaged')?'':path.join(root,'.venv/Scripts/python.exe')}});
let app,page,design;const report={checks:[],errors:[]};
const emit=events=>app.evaluate(({BrowserWindow},events)=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('window=chat'));events.forEach(e=>w.webContents.send('ayana:event',{protocol_version:1,...e}));},events);
const reply=(id,text)=>[{type:'utterance.ready',generation_id:200,utterance_id:id,speech_ja:'ゆっくり話そう。',audio_enabled:true},{type:'subtitle.ready',generation_id:200,utterance_id:id,display_zh:text,display_en:'Let us take our time.'},{type:'playback.started',generation_id:200,utterance_id:id,total_samples:1000},{type:'playback.progress',generation_id:200,utterance_id:id,played_samples:1000,total_samples:1000}];
const row=id=>page.locator(`[data-caption-id="${id}"]`);
try{
 app=await launch();const windows=await app.windows();page=windows.find(w=>w.url().includes('window=chat'));design=windows.find(w=>w.url().includes('window=design'));windows.forEach(w=>w.on('pageerror',e=>report.errors.push(e.message)));
 await page.waitForFunction(()=>window.ayana.getState().then(s=>s.connected));await page.waitForFunction(()=>document.querySelector('img.character')?.naturalWidth>0);
 await page.getByLabel('打开设计控件',{exact:true}).click();assert.equal(await design.getByRole('button',{name:'看全身',exact:true}).count(),0);assert.equal(await design.getByRole('button',{name:'到膝盖',exact:true}).count(),0);
 await design.getByRole('tab',{name:'对白',exact:true}).click();
 for(const [primary,secondary] of [['ja','none'],['zh','ja'],['en','zh'],['ja','en']]){
  await design.getByLabel('对白主语言',{exact:true}).selectOption(primary);await design.getByLabel('对白翻译语言',{exact:true}).selectOption(secondary);
  await emit(reply('languages','我们慢慢说。'));await page.waitForTimeout(200);
  assert.equal(await page.locator('.is-current .cinematic-dialogue').getAttribute('lang'),primary==='zh'?'zh-CN':primary);
  const text=await page.locator('.is-current .cinematic-shot').textContent();assert.equal(text,{ja:'ゆっくり話そう。',zh:'我们慢慢说。',en:'Let us take our time.'}[primary]);
  assert.equal(await design.getByLabel('对白翻译语言',{exact:true}).locator(`option[value="${primary}"]`).count(),0);
  if(secondary==='none')assert.equal(await page.locator('.is-current .cinematic-original').count(),0);
 }
 await design.getByLabel('对白主语言',{exact:true}).selectOption('zh');await design.getByLabel('对白翻译语言',{exact:true}).selectOption('none');
 if(await design.getByRole('button',{name:'保存设计',exact:true}).isEnabled()){await design.getByRole('button',{name:'保存设计',exact:true}).click();await design.getByText('设计已保存',{exact:true}).waitFor();}await design.getByLabel('收起设计控件',{exact:true}).click();
 report.checks.push('Both portrait preset buttons are removed; Japanese/Chinese/English main languages and optional distinct translations render correctly and save');
 await emit(reply('first','第一句是清楚的，在下一句到来前保持焦点。'));await page.waitForTimeout(750);
 await row('first').evaluate(node=>{window.__oldCaption=node.querySelector('.cinematic-dialogue');window.__oldGlyph=node.querySelector('.cinematic-glyph');});
 const centered=await row('first').evaluate(n=>{const b=n.getBoundingClientRect(),v=document.querySelector('.cinematic-memory').getBoundingClientRect();return Math.abs(b.y+b.height/2-v.y-v.height/2);});assert(centered<3);
 await emit([{type:'playback.ended',generation_id:200,utterance_id:'first',played_samples:1000,total_samples:1000}]);await page.waitForTimeout(1100);assert(await row('first').evaluate(n=>n.classList.contains('is-current')),'Last reply stays prominent until another arrives.');
 await emit(reply('second','第二句进入中心，前一句平滑退到背景。'));
 assert(await row('first').evaluate(n=>n.querySelector('.cinematic-dialogue')===window.__oldCaption&&n.querySelector('.cinematic-glyph')===window.__oldGlyph),'Retirement keeps the exact same caption and glyph nodes.');
 const samples=[];for(let i=0;i<9;i++){await page.waitForTimeout(70);samples.push(await row('first').evaluate(n=>({y:n.getBoundingClientRect().y,opacity:Number(getComputedStyle(n.firstElementChild).opacity),text:n.textContent,shown:[...n.querySelectorAll('.cinematic-glyph')].every(g=>g.classList.contains('is-shown'))})));}
 assert(samples.every(s=>s.shown),'Old glyphs never disappear or replay their reveal.');assert(samples.every(s=>s.opacity>.2));assert(samples.at(-1).y<samples[0].y+1);
 const current=await row('second').locator('.cinematic-dialogue').evaluate(n=>({opacity:Number(getComputedStyle(n).opacity),scale:new DOMMatrixReadOnly(getComputedStyle(n).transform).a}));
 const old=await row('first').locator('.cinematic-dialogue').evaluate(n=>({opacity:Number(getComputedStyle(n).opacity),scale:new DOMMatrixReadOnly(getComputedStyle(n).transform).a}));assert(current.opacity>old.opacity);assert(current.scale>old.scale);
 await page.screenshot({path:path.join(directory,'new-reply.png'),omitBackground:true});report.samples=samples;
 report.checks.push('Latest reply remains centered and clear; previous sentences shrink/fade behind it; consecutive replies preserve text-node identity and never flash hidden glyphs');
 for(let i=0;i<5;i++){await emit(reply('past-'+i,'这是一句用于滚轮回看的历史台词。'));await page.waitForTimeout(120);}await page.waitForTimeout(750);
 await row('first').evaluate(n=>{const list=document.querySelector('.cinematic-memory');list.dispatchEvent(new WheelEvent('wheel',{deltaY:-300,bubbles:true}));list.scrollTop=n.offsetTop+n.offsetHeight/2-list.clientHeight/2;list.dispatchEvent(new Event('scroll'));});await page.waitForTimeout(450);
 assert.equal(await row('first').getAttribute('data-focused'),'true');
 const focused=await row('first').locator('.cinematic-dialogue').evaluate(n=>Number(getComputedStyle(n).opacity));assert(focused>.94);
 const anchor=await row('first').evaluate(n=>n.getBoundingClientRect().top);
 await emit(reply('fresh','你查看历史时，新回复不会拉走视线。'));await page.waitForTimeout(750);
 const after=await row('first').evaluate(n=>n.getBoundingClientRect().top);assert(Math.abs(after-anchor)<3,'Reading viewport remains anchored.');
 await page.screenshot({path:path.join(directory,'history-focus.png'),omitBackground:true});
 report.checks.push('Wheel/history reading promotes the sentence at the visual center; incoming replies preserve the reading position');
 await page.reload();await page.waitForFunction(()=>window.ayana.getState().then(s=>s.connected));
 await page.getByLabel('打开设计控件',{exact:true}).click();await design.getByRole('tab',{name:'对白',exact:true}).click();await design.getByLabel('对白主语言',{exact:true}).selectOption('en');await design.getByLabel('对白翻译语言',{exact:true}).selectOption('zh');await design.getByRole('button',{name:'保存设计',exact:true}).click();await design.getByText('设计已保存',{exact:true}).waitFor();await design.getByLabel('收起设计控件',{exact:true}).click();
 await page.evaluate(()=>window.ayana.send({type:'turn.start',text:'给我一句可以切换字幕语言的话'}));await page.waitForFunction(()=>document.querySelector('.is-current .cinematic-shot')?.textContent.includes('talk about today'));
 await page.waitForTimeout(550);const local=JSON.parse(readFileSync(path.join(data,'config/local.json'),'utf8'));assert.equal(local.companion_ui.primary_language,'en');assert.equal(local.companion_ui.translation_language,'zh');
 await page.reload();await page.waitForFunction(()=>document.querySelector('.cinematic-shot')?.textContent.includes("I'm right here"));
 assert((await page.locator('.cinematic-original').allTextContents()).join('').includes('我在这里'));
 await page.screenshot({path:path.join(directory,'english-restored.png'),omitBackground:true});
 report.checks.push('Real local-provider English and Chinese translations persist in history and restore after reload; language preferences remain saved');
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.failure=String(error);process.exitCode=1;if(page)await page.screenshot({path:path.join(directory,'failure.png'),omitBackground:true}).catch(()=>{});}
finally{if(app)await app.close();writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,directory},null,2));}
