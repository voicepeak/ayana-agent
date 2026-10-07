/** Native chat switching in an isolated profile, with a local model fixture. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {mkdirSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2), option=n=>args.includes(n)?args[args.indexOf(n)+1]:undefined;
const require=createRequire(import.meta.url);
const {_electron}=require(require.resolve('playwright',{paths:[option('--playwright-root')||root]}));
const directory=path.join(root,'.runtime/benchmarks',`conversation-switcher-${Date.now()}`);
const profile=path.join(directory,'profile');mkdirSync(path.join(profile,'config'),{recursive:true});
let held=false;
const server=createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;
 const body=JSON.parse(raw);
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 function reply(){if(res.destroyed)return;for(const event of [{type:'speech',key:'s1',speech_ja:'一緒に考えよう。',intent:'acknowledge'},{type:'translation',key:'s1',display_zh:'我们一起想想。'}])res.write('data: '+JSON.stringify({choices:[{delta:{content:JSON.stringify(event)+'\n'}}]})+'\n\n');res.end('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');}
 if(JSON.stringify(body.messages).includes('正在执行的任务')){held=true;res.flushHeaders();const timer=setTimeout(reply,10000);res.once('close',()=>clearTimeout(timer));}else reply();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
writeFileSync(path.join(profile,'config/local.json'),JSON.stringify({provider:'openai',model:'switcher-fixture',base_url:`http://127.0.0.1:${server.address().port}`,voice:{voice_mode:'silent'},stt:{provider:'disabled'},remember_user:false,save_history:true,send_screenshot:false,native_tools:false,hotkey:'Control+Alt+F6',cancel_hotkey:'Control+Alt+F7',watch_hotkey:'Control+Alt+F8'}));
execFileSync(path.join(root,'.venv/Scripts/python.exe'),['-X','utf8','-c',`
from pathlib import Path
from services.agent.storage import ConversationStore
import sys,time
s=ConversationStore(Path(sys.argv[1]));now=time.time()
for i in range(10):
 cid='chat-switch-'+str(i)
 title=['今天的日常','旅行计划','项目讨论'][i] if i<3 else '之前的对话 · '+str(i)
 preview='小雨和海边，想去走一走' if i==1 else '留在本机的聊天记录'
 s.put_record('conversation',cid,dict(conversation_id=cid,title=title,auto_title=False,preview=preview,created=now-i*86400,updated=now-i*3600,repository_root=None))
 s.commit(dict(type='user.message',conversation_id=cid,text=preview,turn_id='seed-'+str(i),generation_id=0))
s.put_record('conversation-state','active',dict(conversation_id='chat-switch-0'));s.close()
`,path.join(profile,'.runtime/history.sqlite3')],{cwd:root,windowsHide:true});
let app;
const report={directory,checks:[],errors:[]};
try{
 app=await _electron.launch({executablePath:option('--packaged')||path.join(root,'apps/desktop/node_modules/electron/dist/electron.exe'),args:[...(option('--packaged')?[]:[path.join(root,'apps/desktop')]),`--user-data-dir=${profile}`],env:{...process.env,AYANA_DATA_DIR:profile,AYANA_REPOSITORY_ROOT:option('--packaged')?'':root,AYANA_PYTHON:option('--packaged')?'':path.join(root,'.venv/Scripts/python.exe'),AYANA_API_KEY:'switcher-fixture-key'},timeout:60000});
 await app.firstWindow();
 const pages=await app.windows(),chat=pages.find(p=>p.url().includes('window=chat'));
 assert(chat);pages.forEach(p=>p.on('pageerror',e=>report.errors.push(e.message)));
 await chat.waitForFunction(()=>window.ayana?.getState().then(s=>s.connected&&s.events.some(e=>e.type==='conversations.ready')),null,{timeout:30000});
 await chat.evaluate(()=>{window.__switchEvents=[];window.ayana.onEvent(e=>window.__switchEvents.push(e));});
 const current=()=>chat.evaluate(async()=>{const s=await window.ayana.getState();return s.events.findLast(e=>['conversations.ready','conversation.changed'].includes(e.type)).current.conversation_id;});
 const settingsVisible=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('window=settings')).isVisible());
 const nativeChatVisible=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('window=chat')).isVisible());
 const input=chat.getByRole('textbox',{name:'输入问题'}),trigger=chat.getByRole('button',{name:'切换对话',exact:true});
 const picker=chat.getByRole('dialog',{name:'切换对话'});
 await trigger.filter({hasText:'今天的日常'}).waitFor();
 async function choose(title){await trigger.click();await picker.getByRole('button',{name:new RegExp(title)}).click();await picker.waitFor({state:'hidden'});}
 await input.fill('还没发送的日常问题');await trigger.click();
 await chat.getByRole('textbox',{name:'查找对话'}).waitFor();
 await chat.waitForFunction(()=>document.querySelectorAll('.conversation-switch-item').length===10);
 assert.equal(await picker.locator('.conversation-switch-item').count(),10);
 assert.equal(await picker.locator('[aria-current=true] strong').textContent(),'今天的日常');
 assert.equal(await settingsVisible(),false);
 await chat.getByRole('textbox',{name:'查找对话'}).fill('海边');
 assert.equal(await picker.locator('.conversation-switch-item').count(),1);
 assert.equal(await current(),'chat-switch-0');
 await chat.getByRole('textbox',{name:'查找对话'}).fill('不存在的对话');await picker.getByText('没有找到这段对话').waitFor();
 await chat.getByRole('textbox',{name:'查找对话'}).press('Escape');await picker.waitFor({state:'hidden'});
 assert.equal(await nativeChatVisible(),true);assert.equal(await trigger.evaluate(e=>e===document.activeElement),true);
 await trigger.click();await input.click();await picker.waitFor({state:'hidden'});assert.equal(await input.inputValue(),'还没发送的日常问题');
 report.checks.push('The chat header opens all conversations, filters titles/previews without switching, and Escape returns focus without hiding the app.');
 await choose('旅行计划');assert.equal(await current(),'chat-switch-1');assert.equal(await input.inputValue(),'');
 await input.fill('旅行还没发送的问题');await choose('今天的日常');assert.equal(await input.inputValue(),'还没发送的日常问题');
 await choose('旅行计划');assert.equal(await input.inputValue(),'旅行还没发送的问题');assert.equal(await settingsVisible(),false);
 report.checks.push('Direct switching restores each conversation draft and never opens the settings window.');
 await trigger.click();await picker.getByRole('button',{name:'新的对话',exact:true}).click();await picker.waitFor({state:'hidden'});
 const fresh=await current();assert(!['chat-switch-0','chat-switch-1'].includes(fresh));assert.equal(await input.inputValue(),'');
 await input.fill('新的问题');await chat.getByRole('button',{name:'发送',exact:true}).click();
 await chat.waitForFunction(()=>{const user=window.__switchEvents.findLast(e=>e.type==='user.message');return user&&window.__switchEvents.some(e=>e.type==='task.state'&&e.state==='idle'&&e.generation_id===user.generation_id);});
 await choose('旅行计划');assert.equal(await input.inputValue(),'旅行还没发送的问题');
 await choose('新的问题');assert.equal(await current(),fresh);assert.equal(await input.inputValue(),'');
 report.checks.push('New conversations start empty, previous records remain, and sent drafts do not reappear.');
 await input.fill('正在执行的任务');await chat.getByRole('button',{name:'发送',exact:true}).click();
 for(let n=0;n<100&&!held;n++)await new Promise(r=>setTimeout(r,50));assert(held);
 const generation=await chat.evaluate(()=>window.__switchEvents.findLast(e=>e.type==='user.message').generation_id);
 await choose('今天的日常');assert.equal(await current(),'chat-switch-0');assert.equal(await input.inputValue(),'还没发送的日常问题');
 assert(await chat.evaluate(g=>window.__switchEvents.some(e=>e.type==='generation.cancelled'&&e.cancelled_generation_id===g),generation));
 assert.equal(await settingsVisible(),false);
 report.checks.push('Switching during a model request cancels that generation and restores the chosen conversation.');
 for(const [width,height]of [[780,500],[430,340],[320,300]]){
  await app.evaluate(({BrowserWindow},size)=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('window=chat'));w.setMinimumSize(300,260);w.setSize(...size);},[width,height]);
  await trigger.click();await picker.waitFor();
  await chat.screenshot({path:path.join(directory,`switcher-${width}.png`),animations:'disabled'});
  const bounds=await chat.evaluate(()=>{const panel=document.querySelector('.conversation-switch-panel').getBoundingClientRect();const footer=document.querySelector('.conversation-switch-new').getBoundingClientRect();return {panel:{x:panel.x,y:panel.y,right:panel.right,bottom:panel.bottom},footer:{bottom:footer.bottom},width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,parents:[...document.querySelectorAll('.companion-shell,.companion-note,.companion-frame-heading,.companion-heading-start,.conversation-switcher')].map(n=>({class:n.className,x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y,width:n.clientWidth,scrollLeft:n.scrollLeft,scrollTop:n.scrollTop,position:getComputedStyle(n).position}))};});
  assert(bounds.panel.x>=0&&bounds.panel.right<=bounds.width&&bounds.panel.bottom<=bounds.height,JSON.stringify(bounds));assert(bounds.footer.bottom<=bounds.panel.bottom);assert.equal(bounds.overflow,false);
  await picker.getByRole('button',{name:'关闭对话列表'}).click();
 }
 report.checks.push('The conversation list scrolls within the companion at 780, 430 and 320 pixels; controls remain in the window.');
 assert.equal(report.errors.length,0,JSON.stringify(report.errors));report.passed=true;console.log(JSON.stringify(report));
}catch(error){report.errors.push(error.stack||error.message);process.exitCode=1;console.error(error.stack||error.message);}
finally{writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2));await app?.close().catch(()=>{});server.closeAllConnections();await new Promise(r=>server.close(r));}
