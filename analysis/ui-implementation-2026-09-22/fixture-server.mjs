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
const project={id:'ui-fixture',name:'UI review sandbox',available:true,attention:2,activeRun:false,root:'Disposable in-memory project',governanceRoot:'Disposable in-memory project'};
const json=(res,data,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));};
const getBody=async req=>{let raw='';for await(const chunk of req)raw+=chunk;try{return JSON.parse(raw||'{}');}catch{return raw;}};
function stats(){return {totalTasks:tasks.length,completedTasks:tasks.filter(t=>t.status==='Done').length,completionPercentage:100*tasks.filter(t=>t.status==='Done').length/(tasks.length||1),draftCount:0,statusCounts:Object.fromEntries(statuses.map(s=>[s,tasks.filter(t=>t.status===s).length])),priorityCounts:{high:1},noPriorityCount:tasks.length-1};}
const server=http.createServer(async(req,res)=>{try {
 const url=new URL(req.url,'http://localhost'),p=url.pathname,body=await getBody(req);
 if(p==='/__fixture/state')return json(res,{scenario,tasks,milestones,initiatives,writes});
 if(p==='/__fixture/scenario'){seed(url.searchParams.get('name')||'scale');return json(res,{scenario});}
 if(p==='/__fixture/offline'){offline=url.searchParams.get('value')==='true';return json(res,{offline});}
 if(p==='/__fixture/fail-save'){failSave=true;return json(res,{failSave});}
 if(p==='/__fixture/lose-response'){loseResponse=true;return json(res,{loseResponse});}
 if(p==='/__fixture/active-run'){activeRun=url.searchParams.get('value')==='true'?{initiativeId:'fixture-plan',status:'running',id:'fixture-runtime',startedAt:date}:null;return json(res,{activeRun});}
 if(p==='/__fixture/delay-task'){delayedTask={id:url.searchParams.get('id'),ms:Math.min(10000,Number(url.searchParams.get('ms'))||2000)};return json(res,{delayedTask});}
 if(p==='/__fixture/conflict'){tasks[0].description='Concurrent description change';tasks[0].labels=['concurrent'];tasks[0].revision+='x';return json(res,{ok:true});}
 if(p==='/fixture-observer.js'){res.setHeader('content-type','text/javascript');return res.end(`for(const type of ['dragstart','drop','dragend']) document.addEventListener(type,e=>console.log('fixture gesture',type,JSON.stringify({target:e.target.closest('[data-id]')?.dataset.id,status:e.target.closest('[data-status]')?.dataset.status,x:e.clientX,y:e.clientY,visible:[...document.querySelectorAll('[data-status]')].filter(x=>!x.hidden).map(x=>x.dataset.status),marker:document.querySelector('[data-drop-position]')?.dataset.dropPosition})));`);}
 if(!p.startsWith('/api/')){const file=p==='/'?'index.html':p.slice(1);if(!/^[a-z0-9-]+\.(?:js|css|html)$/.test(file))return json(res,{error:'Missing'},404);res.setHeader('content-type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html');res.setHeader('cache-control','no-store');let bytes=await fs.readFile(path.join(root,file));if(file==='index.html')bytes=Buffer.from(bytes.toString().replace('</body>','<script src="/fixture-observer.js"></script></body>'));return res.end(bytes);}
 if(offline)return json(res,{error:'Disposable connection interruption'},503);
 if(p==='/api/projects')return json(res,{csrfToken:'disposable-token',projects:[project]});
 const base='/api/projects/ui-fixture';
 if(p===base+'/state')return json(res,{schemaVersion:1,revision:1,project:{...project,activeRun:!!activeRun},csrfToken:'disposable-token',tasks,initiatives,activeRun,capabilities:{codex:true}});
 if(p===base+'/skills')return json(res,{skills:[{id:'intake/SKILL.md',name:'intake',description:'Shape a clear human outcome',title:'Intake'}]});
 if(p===base+'/skills/content')return json(res,{id:'intake/SKILL.md',title:'Intake',markdown:'# Intake\n\nShape a clear human outcome.'});
 if(p===base+'/operations')return json(res,{issues:[],metrics:{},worktrees:[],retention:[]});
 if(p.startsWith(base+'/initiatives/')){const id=p.split('/')[5];const item=initiatives.find(i=>i.id===id);writes.push({path:p,body});applyAction(item,body);item.pending=false;return json(res,{initiatives});}
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
server.listen(65440,'127.0.0.1',()=>console.log('Disposable UI verification: http://127.0.0.1:65440/?project=ui-fixture&view=board'));
