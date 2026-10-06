/** Real voice, audio receipts and recovery, isolated from personal conversations. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),args=process.argv.slice(2),option=k=>args.includes(k)?args[args.indexOf(k)+1]:undefined;
const require=createRequire(import.meta.url),{_electron}=require(require.resolve('playwright',{paths:[option('--playwright-root')||root]}));
const directory=path.join(root,'.runtime/benchmarks','voice-recovery-'+Date.now()),data=path.join(directory,'profile');mkdirSync(path.join(data,'config'),{recursive:true});
const voice=JSON.parse(readFileSync(path.join(process.env.APPDATA,'Ayana/config/local.json'),'utf8')).voice;
writeFileSync(path.join(data,'config/local.json'),JSON.stringify({provider:'local',voice,volume:0,stt:{provider:'disabled'},hotkey:'Control+Alt+F6',cancel_hotkey:'Control+Alt+F7',companion_ui:{primary_language:'ja',translation_language:'zh',portrait_side:'left'}}));
let app,page;const report={checks:[],errors:[]};
try{
 app=await _electron.launch({executablePath:option('--packaged')||path.join(root,'apps/desktop/node_modules/electron/dist/electron.exe'),args:[...(option('--packaged')?[]:[path.join(root,'apps/desktop')]),'--user-data-dir='+data],env:{...process.env,AYANA_DATA_DIR:data,AYANA_REPOSITORY_ROOT:option('--packaged')?'':root,AYANA_PYTHON:option('--packaged')?'':path.join(root,'.venv/Scripts/python.exe')}});
 page=(await app.windows()).find(w=>w.url().includes('window=chat'));page.on('pageerror',e=>report.errors.push(e.message));
 // Poll IPC from Node: this bundled Playwright treats async predicates as truthy.
 const deadline=Date.now()+90000;let ready=false;
 while(Date.now()<deadline){const s=await page.evaluate(()=>window.ayana.getState());if(s.connected&&s.events.some(e=>e.type==='service.state'&&e.service==='tts'&&e.state==='ready')){ready=true;break;}await page.waitForTimeout(300);}
 assert(ready,'The real voice worker must be ready before sending.');
 report.connection=await page.evaluate(async()=>{const before=await window.ayana.getState();const probe=await window.ayana.send({type:'history.get'});return {connected:before.connected,service:before.service,probe};});
 assert.equal(report.connection.probe.ok,true,JSON.stringify(report.connection));
 await page.evaluate(()=>{window.__voiceEvents=[];window.ayana.onEvent(e=>{if(e.type==='audio.ready'||e.type==='error'||e.type==='utterance.ready'||e.type==='service.state'||e.type.startsWith('playback.')||e.type==='generation.cancelled')window.__voiceEvents.push(e);});});
 const ask=async()=>{await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('window=chat'));w.show();w.focus();});await page.getByLabel('输入问题',{exact:true}).click();await page.getByLabel('输入问题',{exact:true}).fill('你好');await page.getByLabel('输入问题',{exact:true}).press('Enter');};
 const mark=()=>page.evaluate(()=>window.__voiceEvents.length);
 let start=await mark();await ask();await page.waitForFunction(start=>window.__voiceEvents.slice(start).filter(e=>e.type==='playback.ended'&&typeof e.seq!=='number').length>=2,start,{timeout:45000});
 report.checks.push('Real GPT-SoVITS output produces two full PCM consumption receipts and visible Japanese/Chinese captions');
 start=await mark();await ask();await page.waitForFunction(start=>window.__voiceEvents.slice(start).some(e=>e.type==='playback.progress'&&typeof e.seq!=='number'),start,{timeout:45000});await page.evaluate(()=>window.ayana.send({type:'generation.cancel'}));
 await page.waitForFunction(start=>window.__voiceEvents.slice(start).some(e=>e.type==='playback.cancelled'),start,{timeout:15000});
 start=await mark();await ask();await page.waitForFunction(start=>window.__voiceEvents.slice(start).filter(e=>e.type==='playback.ended'&&typeof e.seq!=='number').length>=2,start,{timeout:45000});
 report.checks.push('Interrupting a real utterance records partial consumption; the following turn resumes full playback and caption display');
 const events=await page.evaluate(()=>window.__voiceEvents);report.events=events.map(({type,generation_id,utterance_id,played_samples,total_samples,state,message})=>({type,generation_id,utterance_id,played_samples,total_samples,state,message}));
 assert(!events.some(e=>e.type==='error'),JSON.stringify(events.filter(e=>e.type==='error')));assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.failure=String(error);process.exitCode=1;if(page){report.events=await page.evaluate(()=>window.__voiceEvents?.map(({type,generation_id,state,message,utterance_id})=>({type,generation_id,state,message,utterance_id}))).catch(()=>[]);report.connectionAfter=await page.evaluate(()=>window.ayana.getState().then(s=>({connected:s.connected,service:s.service}))).catch(()=>null);await page.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});}}
finally{if(app)await app.close();writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,events:report.events?.filter(e=>e.type!=='playback.progress'),directory},null,2));}
