import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChatSessionManager } from '../src/ai/session-manager.js';
import { buildSystemPrompt, buildQuestionPrompt } from '../src/ai/prompts.js';
import { selectExcerpts, scopeChunks } from '../src/ai/retrieval.js';
import { retrievalQuestion } from '../src/ai/conversation-context.js';
import { Router } from '../src/ai/router.js';
import { ocrRegions } from '../src/ocr/regions.js';
import { findSources } from '../src/ai/sources.js';

let prompts, creates, answers;
globalThis.chrome = { storage: { local: { async get(){ return {}; } } } };
beforeEach(() => {
  prompts=[]; creates=0; answers=[];
  globalThis.LanguageModel={async create(options){
    creates++;
    return {inputUsage:0,inputQuota:1000,options,
      async *promptStreaming(prompt){prompts.push(prompt);yield answers.shift() || 'The capture does not provide a phone number.';},
      async prompt(prompt){prompts.push(prompt);return 'general';},destroy(){}};
  }};
});
const capture={id:1,title:'Fern Daily',url:'https://example.com',ts:1794800000000,
  summary:'Invented age: two years old.',domText:'Contributors: 3. The library opens at 9 am.',
  domChunks:['Contributors: 3. The library opens at 9 am.'],domMetadata:[
  'Contributors: @fern-editor (https://github.com/fern-editor)',
  'Project created 3 months ago — datetime: 2026-08-16T12:00:00Z'],
  ocrText:'Festival code: MAPLE 728'};
const manager=()=>{const s=new ChatSessionManager();s.setScope({type:'capture',capture});return s;};

test('missing page facts do not launch an ungrounded second model call', async()=>{
 const s=manager(); const r=await s.ask('What is the phone number?');
 assert.equal(creates,1);assert.equal(prompts.length,1);assert.doesNotMatch(r.answer,/general knowledge/);
});
test('follow-up carries question, answer and newly retrieved DOM evidence', async()=>{
 const s=manager();s.remember('Who are the contributors?','The page lists 3 contributors.');
 await s.ask('What are their names?');
 assert.match(prompts[0],/Who are the contributors/);assert.match(prompts[0],/3 contributors/);assert.match(prompts[0],/@fern-editor/);
});
test('scope reopening restores only completed exchanges, bounded to four',()=>{
 const s=manager();s.restoreHistory([{role:'assistant',content:'Generated summary'},
 ...Array.from({length:6},(_,i)=>[{role:'user',content:`Question ${i}`},{role:'assistant',content:`Answer ${i}`}]).flat(),
 {role:'user',content:'Interrupted question'}]);
 assert.equal(s.recentTurns.length,4);assert.equal(s.recentTurns[0].question,'Question 2');
 assert.equal(s.recentTurns.at(-1).answer,'Answer 5');
});
test('quota rebuild still includes conversational context without append support',async()=>{
 const s=manager();await s.ask('Who are the contributors?');s.session.inputUsage=900;
 const result=await s.ask('What are their names?');assert.equal(result.trimmed,true);assert.equal(creates,2);
 assert.match(prompts.at(-1),/Who are the contributors/);
});
test('scope changes clear old conversation',()=>{
 const s=manager();s.remember('Private prior question','Old answer');s.setScope({type:'capture',capture});
 assert.deepEqual(s.recentTurns,[]);
});
test('capture time and generated summary are absent from page evidence',()=>{
 const p=buildSystemPrompt({type:'capture',capture});assert.doesNotMatch(p,/Invented age|2026-11-16|179480/);
 assert.match(p,/not a creation date/);
});
test('standalone questions do not retrieve using the previous topic',()=>{
 assert.equal(retrievalQuestion('When does the library open?', [{question:'What is the capital of France?',answer:'Paris'}]),'When does the library open?');
});
test('OCR facts are searchable alongside DOM and metadata',()=>{
 assert.match(selectExcerpts('What is the festival code?',[capture])[0].text,/MAPLE 728/);
 const single={...capture,domText:'Festival code: MAPLE 123',ocrText:'Festival code: MAPLE 728'};
 assert.ok(scopeChunks([single]).some(c=>c.text.includes('728')));
});
test('metadata is evidence but never offered as a DOM text highlight',()=>{
 const excerpts=selectExcerpts('Who are contributors?',[capture]);assert.ok(excerpts.some(e=>e.kind==='metadata'));
 assert.deepEqual(findSources('The contributors include @fern-editor.',excerpts.filter(e=>e.kind==='metadata')),[]);
});
test('explicit page follow-ups and operations avoid model routing latency',async()=>{
 const router=new Router();
 for(const [q,expected] of [['How old is this project?','text'],['What are their names?','text'],['The contributor profile images show usernames','text'],['Summarize this page','text'],['Make a table of prices','table'],['What useful links are on this page?','links'],['Who painted this portrait?','vision']]){
 assert.equal(await router.route(q),expected,q);
 }
 assert.equal(creates,0);
 assert.equal(await router.route('What is the capital of France?',{title:capture.title}),'general');assert.equal(creates,1);
});
test('relevant links beyond the first thirty navigation items are included',async()=>{
 const s=manager();s.scope.capture={...capture,links:[...Array.from({length:40},(_,i)=>({href:`https://example.com/nav-${i}`,text:`Menu ${i}`})),{href:'https://example.com/tickets',text:'Reserve library tickets'}]};
 await s.ask('Where can I reserve library tickets?',{route:'links'});assert.match(prompts[0],/https:\/\/example.com\/tickets/);
});
test('empty evidence still gets grounding instructions',()=>{
 assert.match(buildQuestionPrompt('When was it created?',[]),/does not establish/);
});
test('OCR rectangles scale for DPR/downsampling and clip tile boundaries',()=>{
 const tile={seq:1,w:800,h:1000,contentH:700};
 const regions=ocrRegions(tile,[{x:100,y:1900,w:400,h:600}],1600);
 assert.deepEqual(regions,[{left:46,top:0,width:208,height:254}]);
 assert.deepEqual(ocrRegions(tile,[{x:0,y:0,w:100,h:100}],1600),[]);
});
test('overlapping and contained image regions are merged, disjoint ones stay separate',()=>{
 const boxes=ocrRegions({seq:0,w:800,h:1000},[{x:10,y:10,w:100,h:100},{x:20,y:20,w:20,h:20},{x:300,y:300,w:100,h:100}],800);
 assert.equal(boxes.length,2);assert.equal(boxes[0].width,108);
});

test('late session creation cannot overwrite a new scope session',async()=>{
 const s=manager(); let release, started;
 const pending=new Promise(resolve=>{release=resolve});
 const creating=new Promise(resolve=>{started=resolve});
 const create=LanguageModel.create;
 LanguageModel.create=async options=>{started();return pending;};
 const old=s.ask('Old page question');
 await creating;
 s.setScope({type:'capture',capture:{...capture,id:2,title:'New page'}});
 LanguageModel.create=create;
 await s.ask('New page question');
 const current=s.session;let destroyed=false;
 release({destroy(){destroyed=true}});
 await assert.rejects(old,{name:'AbortError'});
 assert.equal(s.session,current);assert.equal(destroyed,true);
 assert.equal(s.recentTurns.length,1);assert.equal(s.recentTurns[0].question,'New page question');
});
test('a stream completing after a scope switch cannot pollute new history',async()=>{
 const s=manager();let release,started;
 const pending=new Promise(resolve=>{release=resolve});
 const streaming=new Promise(resolve=>{started=resolve});
 LanguageModel.create=async()=>({async *promptStreaming(){started();await pending;yield 'Old answer'},destroy(){}});
 const answer=s.ask('Old question');await streaming;
 s.setScope({type:'capture',capture:{...capture,id:2}});release();
 await assert.rejects(answer,{name:'AbortError'});assert.deepEqual(s.recentTurns,[]);
});
test('page summaries prefer main content over navigation',()=>{
 const c={...capture,mainText:'The library opens at 9 am. It has 48 seats.',domChunks:['Menu: Log in. Subscribe.']};
 assert.match(selectExcerpts('Summarize this page',[c])[0].text,/48 seats/);
});
