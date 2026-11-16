// UI and failure-path review in the benchmark's isolated extension profile.
// Chat replies here are simulated: the real-model suite is tools/e2e.mjs.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
export async function reviewExperience({ panel, target, out }) {
 const passed=[];
 const check=(name,condition)=>{assert.ok(condition,name);passed.push(name);};
 const evidence=await panel.evaluate(async()=>{
  const {listCaptures}=await import('../db/captures.js');
  const {selectExcerpts}=await import('../ai/retrieval.js');
  const c=(await listCaptures())[0];
  return {c,contributors:selectExcerpts('Who are the contributors?',[c]).map(e=>e.text).join('\n'),
   notice:selectExcerpts('What is the festival code?',[c]).map(e=>e.text).join('\n')};
 });
 check('all three small-avatar usernames reach retrieval', ['@fern-editor','@library-reporter','@river-photographer'].every(n=>evidence.contributors.includes(n)));
 check('image-only fact reaches retrieval beside DOM text', /MAPLE\s*728/.test(evidence.notice));
 check('creation and update dates retain their context', evidence.c.domMetadata.some(m=>m.includes('Project created')&&m.includes('2026-08-16')));
 await panel.click('#scanDetails summary');
 await panel.screenshot({path:join(out,'capture-details.png')});
 await panel.click('#tabs [data-tab="artifacts"]');
 await panel.waitForFunction(()=>document.querySelector('#textpane').textContent.includes('MAPLE'));
 await panel.screenshot({path:join(out,'artifacts-auto.png')});
 await panel.click('#runOcr');
 await panel.waitForFunction(()=>!document.querySelector('#runOcr').disabled,{},{timeout:60000});
 const full=await panel.evaluate(async()=> (await (await import('../db/captures.js')).listCaptures())[0]);
 check('full OCR runs on the saved scan', full.ocrMode==='full' && full.ocrText.length>evidence.c.ocrText.length && /MAPLE\s*728/.test(full.ocrText));
 check('full OCR preserves DOM labels',JSON.stringify(full.domMetadata)===JSON.stringify(evidence.c.domMetadata));
 await panel.screenshot({path:join(out,'artifacts-full.png')});
 await panel.click('#tabs [data-tab="chat"]');
 await panel.click('[data-question="Summarize this page"]');
 check('suggested prompt stages an editable draft',(await panel.inputValue('#input'))==='Summarize this page');
 await panel.fill('#input','');
 // Real UI routing, prompt construction, streaming, storage and reload;
 // simulated model outputs, deliberately not evidence of Nano accuracy.
 await panel.evaluate(()=>{
  window.__testPrompts=[];
  Object.defineProperty(window,'LanguageModel',{configurable:true,value:{
   async availability(){return 'available'},
   async create(){return {inputUsage:0,inputQuota:10000,destroy(){},
    async *promptStreaming(prompt){
     window.__testPrompts.push(prompt);
     yield prompt.endsWith('What are their names?') ? 'The contributors are @fern-editor, @library-reporter, and @river-photographer.' : 'The page lists three contributors.';
    }};}
  }});
 });
 for(const [index,question] of ['Who are the contributors?','What are their names?'].entries()){
  await panel.fill('#input',question);await panel.click('#sendBtn');
  await panel.waitForFunction(n=>window.__testPrompts.length===n&&!document.querySelector('#sendBtn').disabled,index+1);
 }
 const prompts=await panel.evaluate(()=>window.__testPrompts);
 check('UI follow-up prompt includes history and captured usernames',prompts.length===2&&prompts[1].includes('Who are the contributors?')&&prompts[1].includes('@fern-editor'));
 for(const width of [320,420]){
  await panel.setViewportSize({width,height:850});
  check(`no horizontal overflow at ${width}px`,await panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  check(`composer visible at ${width}px`,await panel.locator('#sendBtn').evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}));
  await panel.screenshot({path:join(out,`chat-${width}-simulated.png`)});
 }
 // Force a fresh session for the stored scope, as reopening from memory does.
 await panel.evaluate(async()=>{
  const c=(await (await import('../db/captures.js')).listCaptures())[0];
  await chrome.storage.session.set({pendingScope:{type:'capture',captureId:c.id}});
 });
 await panel.waitForFunction(()=>document.querySelectorAll('#msgs .user').length===2);
 await panel.fill('#input','What are their names?');await panel.click('#sendBtn');
 await panel.waitForFunction(()=>!document.querySelector('#sendBtn').disabled);
 check('reopened chat restores prior user context',await panel.evaluate(()=>window.__testPrompts.at(-1).includes('Who are the contributors?')));
 // Cancel a scan while scrolling, checking the live page is restored.
 await target.evaluate(()=>scrollTo(0,420));
 const originalY=await target.evaluate(()=>scrollY);
 await target.bringToFront();await panel.click('#scanBtn');
 await panel.waitForFunction(()=>!document.querySelector('#cancelBtn').hidden);
 await panel.click('#cancelBtn');
 await panel.waitForFunction(()=>!document.querySelector('#scanBtn').disabled,{},{timeout:15000});
 check('cancel restores scroll and fixed-element state',await target.evaluate(y=>scrollY===y&&!document.querySelector('[data-cc-hidden], [data-cc-style]'),originalY));
 check('cancel is reported as cancellation',/cancelled/i.test(await panel.textContent('#toast')));
 await panel.screenshot({path:join(out,'cancelled.png')});
 // Sparse DOM fallback: a canvas-only page must still get full OCR.
 await target.setContent('<title>Canvas fixture</title><canvas width="600" height="180"></canvas>');
 await target.evaluate(()=>{const x=document.querySelector('canvas').getContext('2d');x.fillStyle='white';x.fillRect(0,0,600,180);x.fillStyle='black';x.font='36px sans-serif';x.fillText('CANVAS ONLY 456',20,90);});
 await target.bringToFront();
 await target.screenshot({path:join(out,'sparse-page.png')});
 const sparse=await panel.evaluate(async()=>{
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  return (await import('../capture/pipeline.js')).capturePage(tab.id,tab.windowId,{ocrMode:'auto'});
 });
 const tileBytes=await panel.evaluate(async id=>Array.from(new Uint8Array(await (await (await import('../db/captures.js')).getTiles(id))[0].blob.arrayBuffer())),sparse.id);
 writeFileSync(join(out,'sparse-tile.png'),Buffer.from(tileBytes));
 check('sparse DOM automatically falls back to full OCR',sparse.ocrMode==='full'&&/CANVAS ONLY 456/.test(sparse.ocrText));
 const failure=await panel.evaluate(async id=>{
  const {terminate}=await import('../ocr/tesseract-engine.js');await terminate();
  const original=Tesseract.createWorker;
  Tesseract.createWorker=async()=>{throw new Error('Test worker failure')};
  try {
   const {getCapture}=await import('../db/captures.js');
   return await (await import('../ocr/capture-ocr.js')).recognizeCapture(await getCapture(id));
  } finally {Tesseract.createWorker=original;}
 },sparse.id);
 check('OCR failure is explicit and preserves previous text',failure.ocrStatus==='partial'&&failure.ocrErrors.length===1&&/CANVAS ONLY 456/.test(failure.ocrText)&&!failure.ocrText.includes('Test worker failure'));
 // GitHub-style sidebar: About precedes Contributors, avatar labels are
 // attributes, and all 13 usernames must survive top-k excerpt retrieval.
 await target.setContent('<aside><h2>About</h2><p>Repository description</p><h2>Contributors 13</h2>' +
  Array.from({length:13},(_,i)=>`<a href="https://github.com/contributor-${i}"><img width="24" height="24" alt="@contributor-${i}"></a>`).join('') + '<h2>Languages</h2><p>JavaScript</p></aside>');
 const sidebar=await panel.evaluate(async()=>{
  const {pageExtractDom}=await import('../capture/page-script.js');
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  const [{result:dom}]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:pageExtractDom});
  const {selectExcerpts}=await import('../ai/retrieval.js');
  const {chunkText}=await import('../shared/text.js');
  return selectExcerpts('What are the names of the contributors?', [{url:tab.url,domText:dom.text,domChunks:chunkText(dom.text),domMetadata:dom.metadata}]).map(e=>e.text).join('\n');
 });
 check('all 13 contributor usernames survive sidebar context and retrieval',Array.from({length:13},(_,i)=>sidebar.includes(`@contributor-${i} (`)).every(Boolean));
 console.log('UI REVIEW:',JSON.stringify(passed));
 return passed;
}
