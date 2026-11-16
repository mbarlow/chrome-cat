import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createModelStatus} from '../src/sidepanel/model-status.js';
import {probeModel} from '../src/ai/language-model.js';
const realTimeout=globalThis.setTimeout, realClear=globalThis.clearTimeout, realNow=Date.now;
const flush=()=>new Promise(setImmediate);
let timers,now,id,hide;
function setup(state='downloading') {
  timers=new Map();now=0;id=0;
  globalThis.setTimeout=(fn,ms)=>{timers.set(++id,{fn,at:now+ms});return id};
  globalThis.clearTimeout=id=>timers.delete(id);
  Date.now=()=>now;
  globalThis.window={addEventListener(name,fn){if(name==='pagehide')hide=fn}};
  globalThis.chrome={tabs:{create(options){setup.opened=options.url}}};
  globalThis.LanguageModel={availability:async()=>state};
  const dom={dot:{},text:{},bar:{classList:{toggle(){}}},fill:{style:{}},button:{addEventListener(name,fn){this.click=fn}}};
  return {...dom,status:createModelStatus(dom)};
}
async function advance(ms) {
  now+=ms;
  const due=[...timers].filter(([,v])=>v.at<=now);
  for(const [key,timer] of due){if(timers.delete(key))timer.fn()}
  await flush();
}
afterEach(()=>{hide?.();globalThis.setTimeout=realTimeout;globalThis.clearTimeout=realClear;Date.now=realNow;delete globalThis.LanguageModel});

test('background downloading exposes progress action, then diagnostics after no progress',async()=>{
  const ui=setup();await ui.status.refresh();
  assert.equal(ui.button.textContent,'show progress');assert.equal(ui.button.hidden,false);
  await advance(60000);
  assert.match(ui.text.textContent,/no progress reported/);assert.equal(ui.button.textContent,'diagnostics');
  ui.button.click();assert.equal(setup.opened,'chrome://on-device-internals/');
});
test('show progress attaches a monitor and surfaces creation failures',async()=>{
  const ui=setup();let reject,monitor;
  LanguageModel.create=options=>{
    options.monitor({addEventListener(name,callback){monitor=callback}});
    return new Promise((_,r)=>{reject=r});
  };
  await ui.status.refresh();ui.button.click();
  assert.ok(monitor);assert.doesNotMatch(ui.text.textContent,/0%/);
  monitor({loaded:0.25});assert.match(ui.text.textContent,/25%/);
  await advance(40000);monitor({loaded:0.5});await advance(30000);
  assert.match(ui.text.textContent,/50%/);
  reject(new Error('Component update failed'));await flush();
  assert.match(ui.text.textContent,/download failed: Component update failed/);
  assert.equal(ui.button.textContent,'re-check');
});
test('a repeated percentage does not reset the stalled-download clock',async()=>{
  const ui=setup();await ui.status.refresh();ui.status.showDownload(20);
  await advance(30000);ui.status.showDownload(20);await advance(30000);
  assert.match(ui.text.textContent,/no progress reported/);
});
test('ready state clears the stall timer and probes a real response',async()=>{
  const ui=setup();await ui.status.refresh();
  LanguageModel.availability=async()=> 'available';
  let destroyed=false;
  LanguageModel.create=async()=>({prompt:async()=> 'ready',destroy(){destroyed=true}});
  await ui.status.refresh();await advance(60000);
  assert.equal(ui.text.textContent,'model ready');assert.ok(destroyed);assert.equal(timers.size,0);
});
test('session creation rejection becomes a visible status instead of stuck loading',async()=>{
  const ui=setup('available');LanguageModel.create=async()=>{throw Error('GPU initialization failed')};
  await ui.status.refresh();assert.equal(ui.text.textContent,'GPU initialization failed');assert.equal(ui.button.textContent,'re-check');
  assert.deepEqual(await probeModel(),{ok:false,reason:'GPU initialization failed'});
});
