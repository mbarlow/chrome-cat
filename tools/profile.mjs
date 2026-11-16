// Real extension scan/OCR benchmark; model disabled to isolate capture costs.
// PROFILE_URL=https://www.foxnews.com PROFILE_RUNS=1 node tools/profile.mjs
import { createServer } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './playwright.mjs';
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const source = process.env.PROFILE_EXT || repo;
const out = process.env.PROFILE_OUT || mkdtempSync(join(tmpdir(), 'chrome-cat-profile-out-'));
mkdirSync(out, {recursive:true});
const work = mkdtempSync(join(tmpdir(), 'chrome-cat-profile-'));
const ext = join(work, 'ext'); mkdirSync(ext);
for (const name of ['src','vendor','icons','manifest.json']) cpSync(join(source,name),join(ext,name),{recursive:true});
const manifest=JSON.parse(readFileSync(join(ext,'manifest.json')));manifest.host_permissions=['<all_urls>'];
writeFileSync(join(ext,'manifest.json'),JSON.stringify(manifest));
const server=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(readFileSync(join(repo,'tools/profile/index.html')));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=process.env.PROFILE_URL || `http://127.0.0.1:${server.address().port}/`;
const {chromium}=loadPlaywright();
let context;
try {
 context=await chromium.launchPersistentContext(join(work,'profile'),{headless:false,args:['--headless=new',`--disable-extensions-except=${ext}`,`--load-extension=${ext}`],viewport:{width:1280,height:900}});
 const worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
 const origin=`chrome-extension://${new URL(worker.url()).host}`;
 const panel=await context.newPage();const errors=[]; panel.on('pageerror',e=>errors.push(String(e)));
 await panel.addInitScript(()=>{Object.defineProperty(window,'LanguageModel',{value:undefined,configurable:true});});
 await panel.goto(`${origin}/src/sidepanel/sidepanel.html`);
 await panel.setViewportSize({width:420,height:900});
 const targetOpened=context.waitForEvent('page');
 await panel.evaluate(u=>chrome.windows.create({url:u,focused:false,width:1280,height:900}),url);
 const target=await targetOpened;await target.setViewportSize({width:1280,height:900});
 await target.waitForLoadState('domcontentloaded',{timeout:45000});
 await target.waitForTimeout(process.env.PROFILE_URL?5000:250);
 await target.screenshot({path:join(out,'page.png'),fullPage:false});
 const targetTab=await panel.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url),target.url());
 if(!targetTab) throw new Error('Target tab not found');
 await panel.evaluate(t=>{
  const query=chrome.tabs.query.bind(chrome.tabs);
  chrome.tabs.query=q=>(q?.active && (q.currentWindow || q.lastFocusedWindow))?Promise.resolve([t]):query(q);
 },targetTab);
 await panel.screenshot({path:join(out,'panel-before.png')});
 const results=[];
 for(let run=0;run<Number(process.env.PROFILE_RUNS||3);run++){
  await target.bringToFront();
  const result=await panel.evaluate(async ({tab,mode})=>{
   const {capturePage}=await import('../capture/pipeline.js');
   const {getTiles}=await import('../db/captures.js');
   const start=performance.now();const phases=[];
   const capture=await capturePage(tab.id,tab.windowId,{ocrMode:mode,onPhase:(phase,done,total)=>{phases.push({phase,done,total,ms:Math.round(performance.now()-start)});}});
   const tiles=await getTiles(capture.id);
   await chrome.storage.session.set({pendingScope:{type:'capture',captureId:capture.id}});
   return {elapsedMs:Math.round(performance.now()-start),timings:capture.timings||null,phases,tiles:tiles.length,domChars:capture.domText.length,metadata:capture.domMetadata||[],ocrChars:capture.ocrText.length,ocrMode:capture.ocrMode,ocrJobs:capture.ocrJobs,ocrAreas:capture.ocrAreas,ocrStatus:capture.ocrStatus,noticeFound:/MAPLE\s*728/i.test(capture.ocrText),contributorsFound:capture.links.filter(l=>/fern-editor|library-reporter|river-photographer/.test(l.text)),status:capture.status,title:capture.title,errors:capture.ocrErrors||[]};
  },{tab:targetTab,mode:process.env.PROFILE_MODE||'auto'});
  results.push(result);console.log(JSON.stringify({run:run+1,...result,metadata:result.metadata.length,phases:result.phases.filter(p=>Number.isInteger(p.done)&&p.done===p.total)}));
  await panel.waitForTimeout(100);
  await panel.screenshot({path:join(out,`panel-run-${run+1}.png`)});
 }
 const report={url,panelVisibility:await panel.evaluate(()=>document.visibilityState),mode:process.env.PROFILE_MODE||'auto',viewport:{width:1280,height:900},model:'disabled for capture benchmark',results,errors};
 writeFileSync(join(out,'results.json'),JSON.stringify(report,null,2));
 if(process.env.PROFILE_REVIEW==='1') report.review=await (await import('./profile-review.mjs')).reviewExperience({panel,target,out});
 writeFileSync(join(out,'results.json'),JSON.stringify(report,null,2));
 console.log('Artifacts:',out);
 if(errors.length)throw new Error(errors.join('\n'));
} finally {await context?.close();server.close();rmSync(work,{recursive:true,force:true});}
