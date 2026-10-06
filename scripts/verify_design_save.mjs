import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2), option=key=>args.includes(key)?args[args.indexOf(key)+1]:undefined;
const { _electron }=require(require.resolve('playwright',{paths:[option('--playwright-root')||root]}));
const output=path.join(root,'.runtime/design-save-rollback-qa');
const profile=path.join(output,`profile-${Date.now()}`), config=path.join(profile,'config/local.json');
const blocked=path.join(profile,'config/local.tmp');
mkdirSync(path.dirname(config),{recursive:true});
writeFileSync(config,JSON.stringify({provider:'local',voice:{voice_mode:'silent'},send_screenshot:false,hotkey:'Control+Alt+F10',cancel_hotkey:'Control+Alt+F11',companion_ui:{background_mode:'image'}}));
const legacy=readFileSync(path.join(root,'apps/desktop/public/tray.png'));
writeFileSync(path.join(profile,'companion-background.png'),legacy);
const launch=()=>_electron.launch({executablePath:path.join(root,'apps/desktop/node_modules/electron/dist/electron.exe'),args:[path.join(root,'apps/desktop'),`--user-data-dir=${profile}`],env:{...process.env,AYANA_DATA_DIR:profile,AYANA_PYTHON:path.join(root,'.venv/Scripts/python.exe')},timeout:30000});
let app,chat,design;
const errors=[],checks={};
async function setup(){
  app=await launch();await app.firstWindow();
  const windows=await app.windows();chat=windows.find(page=>page.url().includes('window=chat'));design=windows.find(page=>page.url().includes('window=design'));
  windows.forEach(page=>page.on('pageerror',error=>errors.push(error.message)));
  await chat.waitForFunction(()=>window.ayana.getState().then(state=>state.connected),null,{timeout:20000});
  await chat.waitForFunction(()=>document.querySelector('.character')?.naturalWidth>0,null,{timeout:20000});
  await app.evaluate(({BrowserWindow})=>{const chat=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().includes('window=chat'));chat.show();chat.focus();});
  await chat.waitForTimeout(500);
}
const snapshot=()=>chat.evaluate(()=>window.ayana.getState());
async function open(){await chat.evaluate(()=>window.ayana.openDesign());await design.getByRole('tab',{name:'便签',exact:true}).click();}
async function close(){await design.getByRole('button',{name:'收起设计控件',exact:true}).click();await chat.waitForFunction(()=>window.ayana.getState().then(state=>!state.designOpen));}
async function save(){await design.getByRole('button',{name:'保存设计',exact:true}).click();await design.waitForFunction(()=>document.querySelector('.design-inspector footer [role=status]').textContent==='设计已保存');}
async function rejectSave(){await design.getByRole('button',{name:'保存设计',exact:true}).click();await design.waitForFunction(()=>document.querySelector('.design-inspector footer [role=status]').textContent.includes('预览已撤销'));}
async function chooseImage(color){
  const base64=await chat.evaluate(color=>{const canvas=document.createElement('canvas');canvas.width=360;canvas.height=620;const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,360,620);return canvas.toDataURL('image/png').split(',')[1];},color);
  const file=path.join(output,`fixture-${color.slice(1)}.png`);writeFileSync(file,Buffer.from(base64,'base64'));
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);
  await design.getByRole('button',{name:'自定义',exact:true}).click();
  await design.getByRole('button',{name:'图片',exact:true}).click();
  await design.getByRole('button',{name:'选择 / 更换背景图片',exact:true}).click();
  await design.waitForFunction(()=>document.querySelector('.design-background-preview img')?.naturalWidth>0);
  return (await snapshot()).designDraft.background_image;
}
try{
  await setup();
  const original=await snapshot(),originalFile=readFileSync(config,'utf8');
  await open();
  await design.getByRole('button',{name:'纸笺 · 茶白',exact:true}).click();
  await chat.waitForFunction(()=>window.ayana.getState().then(state=>state.designPreview.background_color==='#e6dfd0'));
  await close();
  assert.deepEqual((await snapshot()).designPreview,original.designPreview);
  assert.equal(readFileSync(config,'utf8'),originalFile);
  assert.equal((await snapshot()).designDraft.background_color,'#e6dfd0');
  checks.close_discards_preview_but_keeps_draft=true;
  await open();
  mkdirSync(blocked);
  await rejectSave();
  let state=await snapshot();
  assert.deepEqual(state.designPreview,original.designPreview);
  assert.equal(state.designDraft.background_color,'#e6dfd0');
  assert.equal(await design.getByRole('button',{name:'纸笺 · 茶白',exact:true}).getAttribute('aria-pressed'),'true');
  assert(await design.getByRole('button',{name:'保存设计',exact:true}).isEnabled());
  assert.equal(readFileSync(config,'utf8'),originalFile);
  await design.screenshot({path:path.join(output,'failed-save.png')});
  checks.real_write_failure_reverts_live_appearance_and_retains_editor=true;
  // A settings refresh must not reapply the rejected preview.
  await chat.evaluate(()=>window.ayana.send({type:'settings.get'}));
  await chat.waitForTimeout(200);
  assert.deepEqual((await snapshot()).designPreview,original.designPreview);
  checks.refresh_does_not_reapply_failed_preview=true;
  rmdirSync(blocked);
  await save();await close();
  state=await snapshot();
  assert.equal(state.designPreview.background_color,'#e6dfd0');
  assert.equal(JSON.parse(readFileSync(config,'utf8')).companion_ui.background_color,'#e6dfd0');
  checks.retry_commits_and_survives_close=true;
  await open();
  const firstId=await chooseImage('#183c54');
  assert.match(firstId,/^[0-9a-f]{64}$/);
  await save();await close();
  const firstBytes=readFileSync(path.join(profile,`companion-background-${firstId}.png`));
  const firstConfig=readFileSync(config,'utf8');
  assert.equal((await snapshot()).designPreview.background_image,firstId);
  assert.deepEqual(readFileSync(path.join(profile,'companion-background.png')),legacy);
  checks.saved_image_and_legacy_asset_are_preserved=true;
  await open();
  const secondId=await chooseImage('#735431');
  assert.notEqual(secondId,firstId);
  assert(await design.getByRole('button',{name:'保存设计',exact:true}).isEnabled(),'Replacing an image with the same mode/crop must count as an edit');
  mkdirSync(blocked);await rejectSave();
  state=await snapshot();
  assert.equal(state.designPreview.background_image,firstId);
  assert.equal(state.designDraft.background_image,secondId);
  assert((await chat.locator('.note-background-image img').getAttribute('src')).includes(firstId));
  assert.deepEqual(readFileSync(path.join(profile,`companion-background-${firstId}.png`)),firstBytes);
  assert.equal(readFileSync(config,'utf8'),firstConfig);
  await close();assert.equal((await snapshot()).designPreview.background_image,firstId);
  checks.failed_image_replacement_never_overwrites_saved_image=true;
  await open();rmdirSync(blocked);await save();await close();
  assert.equal((await snapshot()).designPreview.background_image,secondId);
  checks.image_replacement_commits_only_after_success=true;
  // Late preview commands from a hidden editor may change its draft, never the live appearance.
  await design.evaluate(()=>window.ayana.previewDesign({background_mode:'solid',background_color:'#112233'}));
  await chat.waitForTimeout(150);
  assert.equal((await snapshot()).designPreview.background_image,secondId);
  assert.equal((await snapshot()).designPreview.background_mode,'image');
  checks.hidden_editor_cannot_apply_unsaved_changes=true;
  await app.close();app=undefined;
  await setup();
  assert.equal((await snapshot()).designPreview.background_image,secondId);
  assert.equal((await snapshot()).designPreview.background_mode,'image');
  checks.restart_loads_committed_appearance=true;
  assert.equal(errors.length,0,errors.join('\n'));
  writeFileSync(path.join(output,'report.json'),JSON.stringify({checks,errors},null,2));
  console.log(JSON.stringify({checks,errors,output},null,2));
}finally{if(app)await app.close();}
