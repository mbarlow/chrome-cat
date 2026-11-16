// Real WASM speech under MV3 CSP, offline. Recognition/model stubs exercise UI
// turn-taking separately; they do not claim microphone or Nano accuracy.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPlaywright } from './playwright.mjs';
const { chromium } = loadPlaywright();
const ext = resolve(import.meta.dirname, '..');
const profile = mkdtempSync('/tmp/chrome-cat-voice-smoke-');
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  args: ['--headless=new', '--autoplay-policy=no-user-gesture-required', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
});
try {
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  const base = `chrome-extension://${new URL(sw.url()).host}`;
  const page = await ctx.newPage();
  await page.setViewportSize({width:390,height:800});
  const errors = [], remote = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  ctx.on('request', r => { if (/^https?:/.test(r.url())) remote.push(r.url()); });
  await ctx.setOffline(true);
  await page.goto(`${base}/src/sidepanel/sidepanel.html`);
  assert.equal(await page.locator('#voiceControls').isVisible(), false);
  const results = await page.evaluate(() => new Promise((resolve, reject) => {
    const worker = new Worker(chrome.runtime.getURL('src/voice/worker.js'));
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('WASM voice timed out')); }, 120000);
    const result = [];
    worker.onerror = e => { clearTimeout(timer); worker.terminate(); reject(new Error(e.message)); };
    worker.onmessage = ({data}) => {
      if (data.type === 'error') { clearTimeout(timer); worker.terminate(); reject(new Error(data.message)); }
      if (data.type === 'audio') {
        let peak=0, energy=0;
        for(const sample of data.audio) { if(!Number.isFinite(sample)) reject(new Error('nonfinite sample')); peak=Math.max(peak,Math.abs(sample)); energy+=sample*sample; }
        result.push({voice:data.id,samples:data.audio.length,peak,energy,sampleRate:data.sampleRate});
        worker.postMessage({type:'next'});
      }
      if (data.type === 'done') {
        if (data.id === 'F2') worker.postMessage({type:'speak',id:'M2',voice:'M2',text:'Hello! I am Chrome Cat.'});
        else { clearTimeout(timer); worker.terminate(); resolve(result); }
      }
    };
    worker.postMessage({type:'speak',id:'F2',voice:'F2',text:'Hello! I am Chrome Cat.'});
  }));
  for(const voice of ['F2','M2']) {
    const chunks=results.filter(x=>x.voice===voice);
    assert.ok(chunks.length>=2);
    assert.ok(chunks.every(x=>x.samples>1000 && x.sampleRate===24000 && x.peak<=0.990001 && x.energy>0));
  }
  console.log('PASS real female/male WASM synthesis, multiple sentences, finite bounded PCM, offline');

  await page.click('[data-tab="settings"]');
  await page.check('#voiceEnabled');
  await page.selectOption('#voiceName','M2');
  await page.waitForFunction(async()=> (await chrome.storage.local.get('cc.voiceName'))['cc.voiceName']==='M2');
  await page.reload();
  await page.click('[data-tab="settings"]');
  await page.waitForFunction(()=>document.querySelector('#voiceName').value==='M2');
  assert.ok(await page.isChecked('#voiceEnabled'));
  await page.screenshot({path:'/tmp/chrome-cat-voice-settings.png'});
  assert.equal(await page.evaluate(async()=>{
    const speech=await import('../voice/speech.js');
    const pending=speech.speak('This load will be cancelled.');
    speech.stopSpeech();
    try{await pending;return 'unexpected completion'}catch(e){return e.name}
  }),'AbortError');
  await page.click('#voicePreview');
  await page.waitForFunction(()=>document.querySelector('#voicePreviewStatus').textContent==='Speaking…');
  await page.click('#voicePreviewStop');
  await page.waitForFunction(()=>document.querySelector('#voicePreviewStatus').textContent==='Preview stopped.');
  console.log('PASS persisted on/off and voice selection; real preview playback and cancellation');

  await page.evaluate(async()=> {
    class Recognition {
      static async available(){return 'available'}
      static async install(){return true}
      start(){window.__mic=this;window.__micStarts=(window.__micStarts||0)+1;if(!this.processLocally)throw Error('not local');}
      abort(){window.__mic=null;}
      stop(){const end=this.onend;window.__mic=null;setTimeout(()=>end?.(),0)}
    }
    Recognition.prototype.processLocally=false;
    window.SpeechRecognition=Recognition;
    const {ChatSessionManager}=await import('../ai/session-manager.js');
    ChatSessionManager.prototype.route=async()=> 'text';
    ChatSessionManager.prototype.ask=async function(question,{onChunk}) {
      window.__questions=(window.__questions||[]).concat(question);
      const answer='Hello. I can help.';
      onChunk(answer);
      return {answer,trimmed:false,sources:[]};
    };
    const caps=await import('../db/captures.js');
    const capture=await caps.createCapture({url:'https://example.com/voice-test',title:'Voice fixture',viewport:{w:1,h:1,dpr:1}});
    await caps.updateCapture(capture.id,{status:'ready',summary:'A voice test page.'});
    await chrome.storage.session.set({pendingScope:{type:'capture',captureId:capture.id}});
  });
  await page.waitForFunction(()=>document.querySelector('#scopebar').textContent.includes('Voice fixture'));
  await page.click('#voiceStart');
  await page.waitForFunction(()=>!!window.__mic);
  await page.evaluate(()=>{
    const result=[{transcript:'What is on this page?'}];result.isFinal=true;
    window.__mic.onresult({results:[result]});
  });
  await page.waitForFunction(()=>document.querySelector('#voiceStatus').textContent==='Speaking…');
  assert.equal(await page.evaluate(()=>!!window.__mic),false);
  await page.waitForFunction(()=>window.__micStarts===2, {timeout:30000});
  await page.screenshot({path:'/tmp/chrome-cat-voice-chat.png'});
  assert.deepEqual(await page.evaluate(()=>window.__questions),['What is on this page?']);
  assert.equal(await page.locator('.msg.user').last().textContent(),'What is on this page?');
  await page.click('#voiceStop');
  assert.equal(await page.evaluate(()=>!!window.__mic),false);
  console.log('PASS recognized turn uses normal chat, speaks answer, resumes listening, Stop releases mic (recognition/model stubbed)');

  await page.click('#voiceStart');
  await page.waitForFunction(()=>!!window.__mic);
  await page.click('[data-tab="settings"]');
  assert.equal(await page.evaluate(()=>!!window.__mic),false);
  await page.uncheck('#voiceEnabled');
  await page.click('[data-tab="chat"]');
  await page.waitForFunction(()=>document.querySelector('#voiceControls').hidden);
  await page.fill('#input','Typed chat still works.');
  await page.click('#sendBtn');
  await page.waitForFunction(()=>window.__questions?.length===2);
  assert.equal(await page.evaluate(()=>window.__micStarts),3);
  console.log('PASS leaving chat releases mic; disabling voice preserves text chat');
  assert.deepEqual(remote,[], 'no remote speech asset or text requests');
  assert.deepEqual(errors,[], 'no page/CSP errors');
  console.log('VOICE SMOKE OK');
} finally { await ctx.close(); rmSync(profile,{recursive:true,force:true}); }
