import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
const listeners = new Set();
const pagehide = new Set();
let saved = {}, micStarts = 0, micAborts = 0, speeches = [], availability = 'available';
globalThis.window = {addEventListener(name, fn){if(name==='pagehide')pagehide.add(fn)}};
globalThis.chrome = {
  runtime:{getURL:path=>path},
  storage:{local:{async get(){return saved},async set(patch){Object.assign(saved,patch)}},onChanged:{addListener(fn){listeners.add(fn)},removeListener(fn){listeners.delete(fn)}}}
};
class Recognition {
  static async available(){return availability}
  static async install(){return true}
  start(){assert.equal(this.processLocally,true);micStarts++;Recognition.current=this}
  abort(){micAborts++;Recognition.current=null}
  stop(){const end=this.onend;Recognition.current=null;queueMicrotask(()=>end?.())}
}
Recognition.prototype.processLocally=false;
globalThis.SpeechRecognition=Recognition;
class Audio {
  async resume(){}
  async close(){}
  createBuffer(){return {copyToChannel(){}}}
  createBufferSource(){return {connect(){},disconnect(){},start(){setTimeout(()=>this.onended?.(),1)},stop(){}}}
}
globalThis.AudioContext=Audio;
class Worker {
  constructor(){this.dead=false}
  postMessage(data){
    if(data.type==='speak'){
      speeches.push(data); this.id=data.id;
      queueMicrotask(()=>{if(!this.dead)this.onmessage?.({data:{type:'audio',id:data.id,audio:new Float32Array(100),sampleRate:24000}})});
    }
    if(data.type==='next') queueMicrotask(()=>{if(!this.dead)this.onmessage?.({data:{type:'done',id:this.id}})});
  }
  terminate(){this.dead=true}
}
globalThis.Worker=Worker;
const {createConversation}=await import('../src/voice/conversation.js');
const {speechText,stopSpeech}=await import('../src/voice/speech.js');
const {inputStatus}=await import('../src/voice/input.js');
const {getSettings,saveSettings}=await import('../src/shared/constants.js');
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
async function setup(onTurn=async()=> 'A reply.'){
  saved={'cc.voiceEnabled':true,'cc.voiceName':'M2'};
  const states=[];
  const c=createConversation({onTurn,onState:s=>states.push(s),onTranscript(){}});
  await tick();
  return {c,states};
}
afterEach(()=>{
  for(const fn of pagehide)fn();
  pagehide.clear();listeners.clear();stopSpeech();
  saved={};micStarts=micAborts=0;speeches=[];availability='available';
  globalThis.SpeechRecognition=Recognition;
  chrome.storage.local.get=async()=>saved;
});

test('voice defaults off and invalid voice values normalize',async()=>{
  assert.equal((await getSettings()).voiceEnabled,false);
  await saveSettings({voiceName:'invalid'});
  assert.equal((await getSettings()).voiceName,'F2');
});
test('spoken text removes markdown code and links; input is bounded',()=>{
  assert.equal(speechText('**Hello** [world](https://example.com). ```rm -rf```'),'Hello world. Code block omitted.');
  assert.equal(speechText('x'.repeat(9000)).length,8000);
});
test('unsupported browser never falls back to remote recognition',async()=>{
  globalThis.SpeechRecognition=class {};
  await assert.rejects(inputStatus,/on-device/);
});
test('missing local language pack does not open the mic',async()=>{
  const {c,states}=await setup();availability='downloadable';
  await c.start();assert.equal(micStarts,0);assert.equal(c.active,false);
  assert.match(states.at(-1).text,/Set up/);
});
test('final recognized text submits once; microphone pauses for reply and resumes',async()=>{
  const turns=[];
  const {c}=await setup(async text=>{assert.equal(Recognition.current,null);turns.push(text);return 'Hello.'});
  await c.start();
  const result=[{transcript:'My question'}];result.isFinal=true;
  Recognition.current.onresult({results:[result]});
  await tick();await tick();
  assert.deepEqual(turns,['My question']);assert.equal(speeches.length,1);
  assert.equal(speeches[0].voice,'M2');assert.equal(micStarts,2);
  c.stop();assert.equal(Recognition.current,null);
});
test('stop while an answer is pending prevents late speech and mic restart',async()=>{
  const {c}=await setup();await c.start();
  let resolve;
  const result=c.turn(()=>new Promise(r=>{resolve=r}));
  await tick();c.stop();resolve('Late answer');await result;
  assert.equal(speeches.length,0);assert.equal(micStarts,1);assert.equal(c.active,false);
});
test('disabling voice ends capture and suppresses late answers',async()=>{
  const {c}=await setup();await c.start();
  let resolve;
  const result=c.turn(()=>new Promise(r=>{resolve=r}));await tick();
  saved['cc.voiceEnabled']=false;
  for(const fn of listeners)fn({'cc.voiceEnabled':{newValue:false}},'local');
  await tick();resolve('Late answer');await result;
  assert.equal(c.active,false);assert.equal(speeches.length,0);assert.equal(Recognition.current,null);
});
test('recognition errors stop instead of reopening the mic',async()=>{
  const {c,states}=await setup();await c.start();
  Recognition.current.onerror({error:'not-allowed'});await tick();
  assert.equal(c.active,false);assert.equal(micStarts,1);assert.match(states.at(-1).text,/permission/);
});
test('disabled voice preserves ordinary typed turn without audio',async()=>{
  const {c}=await setup();saved['cc.voiceEnabled']=false;
  let ran=false;await c.turn(async()=>{ran=true;return 'Typed reply'});
  assert.ok(ran);assert.equal(speeches.length,0);
});
test('stop during settings read cannot start stale playback',async()=>{
  const {c}=await setup();
  let resolve;
  chrome.storage.local.get=()=>new Promise(r=>{resolve=r});
  const pending=c.turn(async()=> 'An answer');await tick();
  c.stop();resolve(saved);await pending;
  assert.equal(speeches.length,0);
});
test('late end event cannot detach a newer microphone session',async()=>{
  const {c}=await setup();await c.start();
  const oldEnd=Recognition.current.onend;c.stop();await c.start();
  oldEnd();c.stop();
  assert.equal(micAborts,2);assert.equal(Recognition.current,null);
});
