// Disposable browser verification surface: real UI modules, in-memory native API.
// It does not launch agents, read project records, or persist production data.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInitiative, applyAction} from '../../template/.switchflow/scripts/control/lifecycle.mjs';
const root=fileURLToPath(new URL('../../template/.switchflow/scripts/control/public/',import.meta.url));
const date='2026-09-22T03:00:00.000Z';
const statuses=['Backlog','Ready','In Progress','Review','Blocked','Done'];
const paragraph='People need to understand the next step, retain their place, and review evidence before making a decision. This task describes a realistic long record with readable instructions and clear outcomes.';
let tasks, milestones, initiatives, docs, decisions, config, writes=[], offline=false, failSave=false, loseResponse=false, activeRun=null, delayedTask=null, scenario;
function seed(name='scale') {
 scenario=name; offline=false;failSave=false;loseResponse=false;activeRun=null;delayedTask=null;writes=[];
 config={projectName:'UI review sandbox',statuses,types:['feature','bug'],defaultStatus:'Backlog',hideEmptyColumns:true,dateFormat:'yyyy-mm-dd',definitionOfDone:['Reviewed','Verified','Documented'],autoCommit:false,remoteOperations:false};
 const total=name==='drag'?2:200;
 tasks=Array.from({length:total},(_,i)=>({id:`DEMO-${i+1}`,title:i===0?'Read a substantial task and preserve the exact return context':i===1?'Verify dependency completion':`Outcome ${i+1}: demonstrate clear human interaction`,status:name==='drag'?'Ready':i<5?'Ready':i===5?'In Progress':i<26?'Blocked':i<50?'Backlog':'Done',assignee:i<5?['Human']:['Codex'],ordinal:i+1,description:i===0?'# Desired outcome\n\n'+Array.from({length:45},(_,n)=>`## Step ${n+1}\n\n${paragraph}\n\n- Verify the visible result\n- Keep the decision explicit`).join('\n\n'):i===1?'Complete the prerequisite before beginning the dependent work.':'A concise task description.',implementationNotes:i===0?Array.from({length:15},(_,n)=>`### Observation ${n+1}\n${paragraph}`).join('\n\n'):'',implementationPlan:'',finalSummary:'',blockReason:i>=6&&i<26?(i===6?'':'dependent'):'',dependencies:i>=6&&i<26?['DEMO-2']:[],labels:['ui-review'],milestone:i<150?`m-${i%12+1}`:null,priority:i===0?'high':null,source:'local',revision:`rev-${i+1}-1`,atomicRevision:true,acceptanceCriteriaItems:Array.from({length:i===0?15:1},(_,n)=>({index:n+1,text:`Criterion ${n+1}: the result can be understood`,checked:false})),definitionOfDoneItems:[{index:1,text:'Reviewed',checked:false},{index:2,text:'Verified',checked:true}],comments:i===0?Array.from({length:100},(_,n)=>({id:`c-${n+1}`,author:'Reviewer',body:`Observation ${n+1}: ${n===0?'Original decision: preserve the exact origin.':paragraph}`,createdDate:date})):[],createdDate:date,updatedDate:date}));
 milestones=Array.from({length:40},(_,i)=>({id:`m-${i+1}`,title:i===0?'Accept and launch':i===1?'Establish the first outcome':`Milestone ${i+1}`,description:`# Outcome\n\n${paragraph}\n\n## Evidence\n\n- Preserve context\n- Demonstrate completion`,labels:[],executionOrder:name==='ordered'&&i<3?i+1:null,revision:`milestone-${i+1}-1`,atomicRevision:true}));
 docs=[{id:'doc-1',title:'Interaction design guide',type:'guide',path:'guides/design.md',tags:['design'],rawContent:'# Interaction design guide\n\n'+Array.from({length:25},(_,n)=>`## Topic ${n+1}\n\n${paragraph}`).join('\n\n')}];
 decisions=[{id:'decision-1',title:'Keep human acceptance explicit',status:'accepted',date:'2026-09-22',rawContent:'# Keep human acceptance explicit\n\n## Context\nPeople approve outcomes.\n\n## Decision\nKeep acceptance explicit.\n\n## Consequences\nAutomated evidence does not imply acceptance.'}];
 const uat=createInitiative({title:'Review the delivered workspace',request:'Make the next human action obvious.',start:false});
 Object.assign(uat,{id:'fixture-uat',stage:'uat',status:'awaiting-human',summary:'Ready for your acceptance checks',nextAction:'Try the result and record each check.',scope:paragraph.repeat(10),plan:[{phase:'one',task:'DEMO-1',outcome:paragraph,evidence:'Browser fixture'}],approvedScope:{hash:'scope',by:'Human'},approvedPlan:{hash:'plan',scopeHash:'scope',tasks:[{phase:'one',task:'DEMO-1',outcome:'Readable detail',evidence:'Browser checks'}]},evidence:['Disposable candidate evidence; no real delivery or Human acceptance claimed.'],uat:Array.from({length:20},(_,i)=>({id:`check-${i+1}`,text:`Check ${i+1}: ${i===0?'Read a long task and return to your work':paragraph}`,status:'pending'})),events:Array.from({length:60},(_,i)=>({id:`event-${i+1}`,type:i%2?'progress':'update',at:date,message:`Event ${i+1}: ${i===0?'Original decision: maintain context':paragraph}`})),runs:Array.from({length:50},(_,i)=>({id:`run-${i+1}`,stage:'execution',status:'complete',startedAt:date,finishedAt:date,summary:`Run ${i+1} completed bounded work.`}))});
 const planning=createInitiative({title:'Review the next delivery plan',request:'An independent planned outcome',start:false});
 Object.assign(planning,{id:'fixture-plan',stage:'planning',status:'awaiting-human',scope:paragraph,approvedScope:{hash:'scope',by:'Human'},plan:[{phase:'first',task:'DEMO-2',outcome:'Understand the prerequisite',evidence:'Check the result'}],nextAction:'Review and approve the plan.'});
 initiatives=name==='drag'||name==='empty'?[]:[uat,planning];
 if(name==='empty'){tasks=[];milestones=[];docs=[];decisions=[];}
}
seed(process.env.UI_SCENARIO||'scale');
// Disposable agent sessions: one Claude orchestrator steering Codex workers.
const agentStart=Date.now();
const iso=ms=>new Date(agentStart+ms).toISOString();
let agentSettings={schemaVersion:1,revision:0,roles:{intake:'claude',planning:'claude',execution:'claude',delivery:'codex',review:'auto',uat:'claude'},models:{claude:null,codex:null},efforts:{claude:null,codex:null},limits:{timeoutMinutes:60,maxWorkers:2,maxReviewRounds:2,maxTurns:200}};
const routing=()=>Object.fromEntries(Object.keys(agentSettings.roles).map(r=>[r,{provider:agentSettings.roles[r]==='auto'?'claude':agentSettings.roles[r],fallback:null}]));
const S=(o)=>({runId:'fixture-run',transport:o.provider==='codex'?'app-server':'cli',threadId:'thread-'+o.id,sandbox:o.kind==='review'?'read-only':'workspace-write',worktree:null,reviewRound:o.kind==='review'?1:null,endedAt:null,result:null,error:null,fallback:null,eventCount:0,usage:null,...o,get live(){return ['starting','working','idle'].includes(this.status)},get canSteer(){return this.live},get canInterrupt(){return this.status==='working'}});
const agentSessions=[
 S({id:'orch-1',parentId:null,provider:'claude',role:'execution',kind:'stage',initiativeId:'fixture-plan',status:'working',startedAt:iso(-540000),updatedAt:iso(0),model:'claude-opus-5-5',usage:{inputTokens:182000,cachedInputTokens:150000,outputTokens:9400,totalTokens:191400,costUsd:1.84},lastMessage:'DEMO-3 is in review; DEMO-2 is being implemented.'}),
 S({id:'work-2',parentId:'orch-1',provider:'codex',role:'delivery',kind:'deliver',task:'DEMO-2',initiativeId:'fixture-plan',status:'working',startedAt:iso(-300000),updatedAt:iso(0),model:'gpt-5.6-codex',usage:{inputTokens:96000,outputTokens:5100,totalTokens:101100},lastMessage:'Running the dependency check tests.'}),
 S({id:'work-3',parentId:'orch-1',provider:'codex',role:'delivery',kind:'deliver',task:'DEMO-3',initiativeId:'fixture-plan',status:'idle',startedAt:iso(-520000),updatedAt:iso(-200000),model:'gpt-5.6-codex',usage:{inputTokens:120000,outputTokens:7200,totalTokens:127200},lastMessage:'Envelope written; task moved to Review.'}),
 S({id:'rev-3',parentId:'orch-1',provider:'claude',role:'review',kind:'review',task:'DEMO-3',initiativeId:'fixture-plan',status:'working',startedAt:iso(-190000),updatedAt:iso(0),model:'claude-opus-5-5',usage:{inputTokens:40000,outputTokens:900,totalTokens:40900,costUsd:0.31},lastMessage:'Reading the diff.'}),
 S({id:'intake-0',parentId:null,provider:'claude',role:'intake',kind:'stage',initiativeId:'fixture-uat',status:'completed',startedAt:iso(-86400000),updatedAt:iso(-86000000),endedAt:iso(-86000000),model:'claude-opus-5-5',usage:{inputTokens:52000,outputTokens:3100,totalTokens:55100,costUsd:0.42},lastMessage:'Scope ready for your review.'}),
 S({id:'plan-x',parentId:null,provider:'codex',role:'planning',kind:'stage',initiativeId:'fixture-plan',status:'failed',startedAt:iso(-7200000),updatedAt:iso(-7000000),endedAt:iso(-7000000),model:'gpt-5.6-codex',error:'The owner interrupted this agent. Add an update or retry.',fallback:{from:'claude',to:'codex',reason:'claude is not signed in'},lastMessage:'Drafting phase 2.'}),
];
const agentEvents=Object.fromEntries(agentSessions.map(s=>[s.id,[]]));
let agentSeq=0;
const pushEvent=(id,event)=>{agentEvents[id].push({seq:++agentSeq,at:new Date().toISOString(),...event});const s=agentSessions.find(x=>x.id===id);s.updatedAt=new Date().toISOString();s.eventCount=agentSeq;if(event.kind==='message')s.lastMessage=String(event.text).slice(0,160);};
pushEvent('orch-1',{kind:'session.started',provider:'claude',transport:'cli',model:'claude-opus-5-5'});
pushEvent('orch-1',{kind:'message',text:'Reading the approved plan for **phase 1**. Two tasks can run in parallel: `DEMO-2` and `DEMO-3`. Delegating both to Codex in separate worktrees.'});
pushEvent('orch-1',{kind:'tool',name:'delegate_task',summary:'DEMO-3 → codex (deliver)'});
pushEvent('orch-1',{kind:'tool',name:'delegate_task',summary:'DEMO-2 → codex (deliver)'});
pushEvent('orch-1',{kind:'tool',name:'send_to_worker',summary:'work-3: approach confirmed'});
pushEvent('orch-1',{kind:'tool',name:'wait_for_workers',summary:'work-2, work-3'});
pushEvent('orch-1',{kind:'message',text:'DEMO-3 finished. Starting an independent Claude review, since Codex wrote it.'});
pushEvent('orch-1',{kind:'tool',name:'delegate_task',summary:'DEMO-3 → claude (review)'});
pushEvent('work-3',{kind:'steer',by:'orchestrator',mode:'followup',text:'Approach confirmed. Go ahead.'});
for(const ev of [{kind:'message',text:'Confirming the three-line approach:\n1. Read DEMO-2 and its acceptance criteria.\n2. Extend `check-ready-dependencies` for completed records.\n3. Add regression tests.'},{kind:'command',command:'node --test scripts/check-completed-tasks.test.mjs',status:'completed',exitCode:0},{kind:'file_change',paths:['scripts/check-ready-dependencies.mjs'],status:'completed'},{kind:'command',command:'node --test scripts/flow.test.mjs',status:'failed',exitCode:1}]) pushEvent('work-2',ev);
pushEvent('work-3',{kind:'message',text:'Implemented and tested. Handoff envelope recorded.',final:true});
pushEvent('work-3',{kind:'turn.completed',status:'completed',usage:{totalTokens:127200}});
pushEvent('rev-3',{kind:'message',text:'Reading the diff for DEMO-3 against its acceptance criteria.'});
pushEvent('intake-0',{kind:'message',text:'Scope ready for your review.',final:true});
pushEvent('plan-x',{kind:'notice',level:'warning',text:'claude is not signed in; ran on codex.'});
pushEvent('plan-x',{kind:'interrupt',by:'owner'});
pushEvent('plan-x',{kind:'turn.failed',error:'The owner interrupted this agent.'});
const liveLines=['Running the dependency check tests.','Two tests fail on block-list labels; fixing the parser.','Tests pass. Writing the handoff envelope.'];
let liveIndex=0;
setInterval(()=>{const w=agentSessions.find(s=>s.id==='work-2');if(w.status!=='working')return;pushEvent('work-2',liveIndex%2?{kind:'command',command:'node --test scripts/flow.test.mjs',status:'completed',exitCode:0}:{kind:'message',text:liveLines[Math.min(liveIndex/2|0,2)]});w.usage.totalTokens+=3000;liveIndex++;},4000).unref();
function agentRoute(req,res,p,body){
 const rest=p.slice('/api/projects/ui-fixture/agents'.length);
 if(rest===''&&req.method==='GET')return json(res,{providers:{claude:{available:true,version:'2.1.288',transport:'cli',loggedIn:true,authMethod:'claude.ai'},codex:{available:true,version:'codex-cli 0.153.4',transport:'app-server',diagnostic:''}},settings:agentSettings,routing:routing(),activeRun:activeRun,sessions:agentSessions});
 if(rest==='/settings'&&req.method==='PUT'){if(activeRun)return json(res,{error:'Routing is locked while an agent run is active.'},409);if(body.expectedRevision!==undefined&&body.expectedRevision!==agentSettings.revision)return json(res,{error:'Settings changed. Reload and try again.'},409);const {expectedRevision,...patch}=body;agentSettings={...agentSettings,...patch,roles:{...agentSettings.roles,...(patch.roles||{})},limits:{...agentSettings.limits,...(patch.limits||{})},revision:agentSettings.revision+1};return json(res,{settings:agentSettings,routing:routing()});}
 const m=rest.match(/^\/([^/]+)\/(events|steer|interrupt)$/);const s=m&&agentSessions.find(x=>x.id===decodeURIComponent(m[1]));
 if(!s)return json(res,{error:'Unknown agent session.'},404);
 if(m[2]==='events'){const after=Number(new URL(req.url,'http://x').searchParams.get('after'))||0;const events=agentEvents[s.id].filter(e=>e.seq>after);return json(res,{sessionId:s.id,status:s.status,live:s.live,events,nextAfter:events.at(-1)?.seq??after,more:false});}
 if(m[2]==='steer'){if(!s.canSteer)return json(res,{error:'This session is not live.'},409);const mode=s.status==='idle'?'followup':body.mode==='queue'?'queue':'steer';pushEvent(s.id,{kind:'steer',by:'owner',text:String(body.message||''),mode});setTimeout(()=>pushEvent(s.id,{kind:'message',text:'Understood, adjusting: '+String(body.message||'').slice(0,80)}),1200);if(s.status==='idle')s.status='working';return json(res,{ok:true,sessionId:s.id,mode,turnId:'turn-x'},202);}
 if(m[2]==='interrupt'){if(!s.canInterrupt)return json(res,{error:'No turn is running.'},409);s.status=s.parentId?'idle':'failed';pushEvent(s.id,{kind:'interrupt',by:'owner'});return json(res,{sessionId:s.id,interrupted:true},202);}
}

// Disposable UAT preview: simulates the launcher's states without starting any process.
const previewCommand={display:'npm run dev',hash:'f'.repeat(64),cwd:'',port:null,env:[]};
const previewCandidates=[{name:'integration',path:'C:/state/candidates/0123456789abcdef/integration',head:'4f1c2d9e8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e'},{name:'worker-ui',path:'C:/state/candidates/0123456789abcdef/worker-ui',head:'9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b'}];
let preview;
function seedPreview(mode='idle'){
 preview={mode,configured:!['unconfigured','invalid'].includes(mode),configError:mode==='invalid'?'.switchflow/preview.json: command must be a program name on PATH (such as npm) or an absolute program path, without arguments.':null,candidates:mode==='multi'?previewCandidates:previewCandidates.slice(0,1),runtime:{state:'idle'}};
 const logs=['> app@1.0.0 dev','> vite','','  VITE v7.1.0  ready in 412 ms','','  ➜  Local:   http://localhost:5173/','  ➜  press h + enter to show help'];
 if(mode==='running')preview.runtime={state:'running',initiativeId:'fixture-uat',candidate:'integration',command:'npm run dev',url:'http://localhost:5173/',pid:4242,startedAt:date,logs};
 if(mode==='other')preview.runtime={state:'running',initiativeId:'fixture-plan',candidate:'integration',command:'npm run dev',url:'http://localhost:5173/',pid:4242,startedAt:date,logs};
}
seedPreview(process.env.UI_PREVIEW||'idle');
function previewRoute(req,res,id,action,body){
 const item=initiatives.find(i=>i.id===id);
 if(!item)return json(res,{error:'Initiative not found.'},404);
 const eligible=item.stage==='uat'&&item.status==='awaiting-human'&&!item.approvedUat;
 if(!action)return json(res,{configPath:'.switchflow/preview.json',configured:preview.configured,configError:preview.configError,command:preview.configured?previewCommand:null,eligible,reason:eligible?null:'A preview runs only while a delivered candidate waits for your UAT decision.',candidates:eligible?preview.candidates:[],suggested:eligible?preview.candidates[0].name:null,candidateError:null,runtime:preview.runtime});
 writes.push({path:`preview/${action}`,body});
 if(action==='stop'){if(['starting','running'].includes(preview.runtime.state))preview.runtime={...preview.runtime,state:'stopped',reason:'Stopped by you.'};return json(res,{runtime:preview.runtime});}
 if(['starting','running'].includes(preview.runtime.state))return json(res,{error:'A preview for another initiative is running. Stop it first: one preview runs per project.'},409);
 if(body.commandHash!==previewCommand.hash)return json(res,{error:'The preview command changed since it was shown. Review the current command, then start again.'},409);
 const candidate=body.candidate||preview.candidates[0].name;
 const runtime=preview.runtime={state:'starting',initiativeId:id,candidate,command:'npm run dev',url:null,pid:4242,startedAt:new Date().toISOString(),logs:['> app@1.0.0 dev','> vite']};
 setTimeout(()=>{if(preview.runtime!==runtime||runtime.state!=='starting')return;if(preview.mode==='fail')Object.assign(runtime,{state:'failed',exitCode:1,reason:'The preview stopped unexpectedly (exit code 1).',logs:[...runtime.logs,'failed to load config from C:/state/candidates/0123456789abcdef/integration/vite.config.ts','error when starting dev server:',"Error: Cannot find module 'vite'"]});else Object.assign(runtime,{state:'running',url:'http://localhost:5173/',logs:[...runtime.logs,'','  VITE v7.1.0  ready in 412 ms','','  ➜  Local:   http://localhost:5173/']});},1500);
 return json(res,{runtime},202);
}

const project={id:'ui-fixture',name:'UI review sandbox',available:true,attention:2,activeRun:false,root:'Disposable in-memory project',governanceRoot:'Disposable in-memory project'};
const json=(res,data,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));};
const getBody=async req=>{let raw='';for await(const chunk of req)raw+=chunk;try{return JSON.parse(raw||'{}');}catch{return raw;}};
function stats(){return {totalTasks:tasks.length,completedTasks:tasks.filter(t=>t.status==='Done').length,completionPercentage:100*tasks.filter(t=>t.status==='Done').length/(tasks.length||1),draftCount:0,statusCounts:Object.fromEntries(statuses.map(s=>[s,tasks.filter(t=>t.status===s).length])),priorityCounts:{high:1},noPriorityCount:tasks.length-1};}
const server=http.createServer(async(req,res)=>{try {
 const url=new URL(req.url,'http://localhost'),p=url.pathname,body=await getBody(req);
 if(p==='/__fixture/state')return json(res,{scenario,tasks,milestones,initiatives,writes});
 if(p==='/__fixture/scenario'){seed(url.searchParams.get('name')||'scale');return json(res,{scenario});}
 if(p==='/__fixture/preview'){seedPreview(url.searchParams.get('mode')||'idle');return json(res,{preview});}
 if(p==='/__fixture/offline'){offline=url.searchParams.get('value')==='true';return json(res,{offline});}
 if(p==='/__fixture/fail-save'){failSave=true;return json(res,{failSave});}
 if(p==='/__fixture/lose-response'){loseResponse=true;return json(res,{loseResponse});}
 if(p==='/__fixture/active-run'){activeRun=url.searchParams.get('value')==='true'?{initiativeId:'fixture-plan',status:'running',id:'fixture-runtime',startedAt:date}:null;return json(res,{activeRun});}
 if(p==='/__fixture/delay-task'){delayedTask={id:url.searchParams.get('id'),ms:Math.min(10000,Number(url.searchParams.get('ms'))||2000)};return json(res,{delayedTask});}
 if(p==='/__fixture/conflict'){tasks[0].description='Concurrent description change';tasks[0].labels=['concurrent'];tasks[0].revision+='x';return json(res,{ok:true});}
 if(p==='/fixture-observer.js'){res.setHeader('content-type','text/javascript');return res.end(`for(const type of ['dragstart','drop','dragend']) document.addEventListener(type,e=>console.log('fixture gesture',type,JSON.stringify({target:e.target.closest('[data-id]')?.dataset.id,status:e.target.closest('[data-status]')?.dataset.status,x:e.clientX,y:e.clientY,visible:[...document.querySelectorAll('[data-status]')].filter(x=>!x.hidden).map(x=>x.dataset.status),marker:document.querySelector('[data-drop-position]')?.dataset.dropPosition})));`);}
 if(!p.startsWith('/api/')){const file=p==='/'?'index.html':p.slice(1);if(!/^[a-z0-9-]+\.(?:js|css|html)$/.test(file))return json(res,{error:'Missing'},404);res.setHeader('content-type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html');res.setHeader('cache-control','no-store');res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'");let bytes=await fs.readFile(path.join(root,file));if(file==='index.html')bytes=Buffer.from(bytes.toString().replace('</body>','<script src="/fixture-observer.js"></script></body>'));return res.end(bytes);}
 if(offline)return json(res,{error:'Disposable connection interruption'},503);
 if(p==='/api/projects')return json(res,{csrfToken:'disposable-token',projects:[project]});
 const base='/api/projects/ui-fixture';
 if(p===base+'/state')return json(res,{schemaVersion:1,revision:1,project:{...project,activeRun:!!activeRun},csrfToken:'disposable-token',tasks,initiatives,activeRun,capabilities:{codex:true}});
 if(p.startsWith(base+'/agents'))return agentRoute(req,res,p,body);
 if(p===base+'/skills')return json(res,{skills:[{id:'intake/SKILL.md',name:'intake',description:'Shape a clear human outcome',title:'Intake'}]});
 if(p===base+'/skills/content')return json(res,{id:'intake/SKILL.md',title:'Intake',markdown:'# Intake\n\nShape a clear human outcome.'});
 if(p===base+'/operations')return json(res,{issues:[],metrics:{},worktrees:[],retention:[]});
 const previewMatch=p.match(/^\/api\/projects\/ui-fixture\/initiatives\/([^/]+)\/preview(?:\/(start|stop))?$/);
 if(previewMatch)return previewRoute(req,res,previewMatch[1],previewMatch[2],body);
 if(p.startsWith(base+'/initiatives/')){const id=p.split('/')[5];if(['accept-uat','request-rework','scope-change'].includes(body.action)&&preview.runtime.initiativeId===id&&['starting','running'].includes(preview.runtime.state))preview.runtime={...preview.runtime,state:'stopped',reason:body.action==='accept-uat'?'Stopped because you accepted the delivery.':'Stopped because you requested rework.'};const item=initiatives.find(i=>i.id===id);writes.push({path:p,body});applyAction(item,body);item.pending=false;return json(res,{initiatives});}
 const route=p.slice((base+'/native').length);
 if(req.method!=='GET'){
  writes.push({path:route,method:req.method,body});
  if(failSave){failSave=false;return json(res,{error:'Simulated rejected save. Your edits remain available.'},500);}
  if(route==='/tasks/reorder'){const task=tasks.find(t=>t.id===body.taskId);task.status=body.targetStatus;body.orderedTaskIds.forEach((id,i)=>{tasks.find(t=>t.id===id).ordinal=i+1;});return json(res,{success:true});}
  if(route.startsWith('/tasks/')){const t=tasks.find(t=>t.id===decodeURIComponent(route.split('/')[2]));if(body.expectedRevision!==t.revision)return json(res,{error:'Record changed'},409);Object.assign(t,body);t.revision+='x';for(const comment of body.commentsAppend||[])t.comments.push({author:body.commentAuthor,body:comment,createdDate:date});if(loseResponse){loseResponse=false;return json(res,{error:'Response unavailable after the disposable write was applied.'},503);}return json(res,t);}
  if(route==='/config'){config=body;return json(res,config);}
  if(route.startsWith('/docs/')||route.startsWith('/decisions/')){const list=route.startsWith('/docs/')?docs:decisions;const r=list.find(d=>d.id===route.split('/')[2]);Object.assign(r,body);return json(res,r);}
  if(route.startsWith('/milestones/')){const m=milestones.find(m=>m.id===route.split('/')[2]);if(body.expectedRevision!==m.revision)return json(res,{error:'Milestone changed'},409);Object.assign(m,body);m.revision+='x';return json(res,m);}
  return json(res,{error:'Mutation not implemented in disposable fixture'},400);
 }
 if(route==='/tasks')return json(res,tasks);
 if(route==='/drafts')return json(res,[]);
 if(route.startsWith('/task/')){const id=decodeURIComponent(route.split('/')[2]);if(delayedTask?.id===id){const delay=delayedTask;delayedTask=null;await new Promise(resolve=>setTimeout(resolve,delay.ms));}return json(res,tasks.find(t=>t.id===id));}
 if(route==='/statuses')return json(res,scenario==='drag'?['Ready','Done']:statuses);
 if(route==='/config')return json(res,config);
 if(route==='/milestones')return json(res,milestones);
 if(route==='/milestones/archived')return json(res,[]);
 if(route.startsWith('/milestones/'))return json(res,milestones.find(m=>m.id===route.split('/')[2]));
 if(route==='/statistics')return json(res,stats());
 if(route==='/docs')return json(res,docs);
 if(route==='/decisions')return json(res,decisions);
 if(route.startsWith('/docs/'))return json(res,docs.find(d=>d.id===route.split('/')[2]));
 if(route.startsWith('/decisions/'))return json(res,decisions.find(d=>d.id===route.split('/')[2]));
 if(route==='/search'){const q=url.searchParams.get('query').toLowerCase();return json(res,[...tasks.filter(t=>(t.title+' '+t.description+' '+t.id).toLowerCase().includes(q)).map(task=>({type:'task',task})),...docs.filter(d=>d.rawContent.toLowerCase().includes(q)).map(document=>({type:'document',document}))].slice(0,Number(url.searchParams.get('limit')||40)));}
 return json(res,{error:`Fixture route unavailable: ${p}`},404);
}catch(error){return json(res,{error:error.message},500);}});
const port=Number(process.env.UI_PORT)||65440;
server.listen(port,'127.0.0.1',()=>console.log(`Disposable UI verification: http://127.0.0.1:${port}/?project=ui-fixture&view=board`));
