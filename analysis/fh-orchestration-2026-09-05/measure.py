import json, re, statistics
from pathlib import Path
from collections import Counter, defaultdict
from datetime import datetime

OUT=Path(__file__).parent
index=json.loads((OUT/'session-index.json').read_text())
ROOTS={
 '01a0700d-eef1-78b0-949c-b573deae12f2':'Orchestrate advanced foundations',
 '01a06f88-2017-7f32-a830-18f516a4ad42':'Orchestrate designer release',
 '01a06f5e-35f8-7241-ba84-d3ab2c4b9bf5':'Prepare designer phase',
}
def read(sid):
 return [json.loads(l) for l in Path(index[sid]['path']).read_text(encoding='utf-8').split('\n') if l.strip()]
def plain(c):
 return '\n'.join(x.get('text','') for x in c if isinstance(x,dict)) if isinstance(c,list) else str(c or '')
def own_rows(sid):
 rows=read(sid)
 start=index[sid]['meta']['timestamp']
 own_turns={r['payload']['turn_id'] for r in rows if r['type']=='token_usage_record' and r['payload'].get('thread_id')==sid}
 first=next((i for i,r in enumerate(rows,1) if r['type']=='turn_context' and r['payload'].get('turn_id') in own_turns),1)
 return [(i,r) for i,r in enumerate(rows,1) if i>=first and r.get('timestamp','')>=start]
def measure(sid):
 rows=own_rows(sid); meta=index[sid]['meta']
 usages=[]; seen=set(); contexts=[]; calls=[]; commands=[]; waits=[]; messages=[]; turns=[]
 for i,r in rows:
  p=r['payload']; typ=r['type']
  if typ=='token_usage_record' and p.get('thread_id')==sid and p.get('response_id') not in seen:
   seen.add(p.get('response_id')); usages.append({'line':i,'time':r['timestamp'],**p['usage']})
  if typ=='turn_context': contexts.append((p.get('model'),p.get('effort')))
  if typ=='response_item' and p.get('type') in ('function_call','custom_tool_call'):
   arg=p.get('arguments',p.get('input',''))
   try: a=json.loads(arg)
   except (ValueError,TypeError): a={}
   a={k:v for k,v in a.items() if k not in ('message','prompt')}
   calls.append({'line':i,'time':r['timestamp'],'name':p['name'],'args':a,'code':arg if p.get('type')=='custom_tool_call' else '', 'call_id':p.get('call_id')})
  if typ=='event_msg' and p.get('type')=='task_complete':
   turns.append({k:v for k,v in p.items() if k in ('turn_id','started_at','completed_at','duration_ms','last_agent_message')})
  if typ=='event_msg' and p.get('type')=='item_completed':
   x=p['item']; t=x['type']
   if t=='CommandExecution':
    commands.append({'line':i,'time':r['timestamp'],'command':'\n'.join(x['command'][2:]),'output':x.get('stdout','')+x.get('stderr',''),'status':x.get('status'),'duration_ms':x.get('duration_ms'), 'start_ms':p.get('started_at_ms'),'end_ms':p.get('completed_at_ms')})
   elif t in ('AgentMessage','UserMessage'):
    messages.append({'line':i,'time':r['timestamp'],'type':t,'text':plain(x.get('content'))})
 # Capture actual wait outputs, and associate cost with the model response that issued each wait.
 outputs={r['payload'].get('call_id'):(i,r) for i,r in rows if r['type']=='response_item' and r['payload'].get('type') in ('function_call_output','custom_tool_call_output')}
 for c in calls:
  if c['name'] not in ('wait_agent','wait','list_agents'): continue
  pair=outputs.get(c['call_id']); result=plain(pair[1]['payload'].get('output')) if pair else ''
  after=next((u for u in usages if u['line']>c['line']),None)
  waits.append({**{k:v for k,v in c.items() if k!='code'},'result':result,'end_time':pair[1]['timestamp'] if pair else None,'issuing_response':after})
 # Newer runs have per-response records; older runs use positive changes in cumulative counters.
 method='per-response records'
 if not usages:
  method='cumulative token_count deltas'; prior=Counter()
  for i,r in rows:
   p=r['payload']
   if r['type']=='event_msg' and p.get('type')=='token_count' and p.get('info'):
    cur=p['info']['total_token_usage']; delta={k:cur[k]-prior[k] if cur[k]>=prior[k] else cur[k] for k in cur}
    if any(delta.values()): usages.append({'line':i,'time':r['timestamp'],**delta})
    prior=Counter(cur)
 total={k:sum(u.get(k,0) for u in usages) for k in ('input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens')}
 total['uncached_input_tokens']=total['input_tokens']-total['cached_input_tokens']
 latest_record=next((r['payload'] for _,r in reversed(rows) if r['type']=='token_usage_record' and r['payload'].get('thread_id')==sid),None)
 if latest_record:
  assert all(total[k]==v for k,v in latest_record['thread_token_usage'].items()), f'Usage reconciliation failed: {sid}'
 docs=Counter(d.lower() for c in commands for d in re.findall(r'\bdoc view (doc-\d+)',c['command'],re.I))
 tasks=Counter(d.upper() for c in commands for d in re.findall(r'\btask view (FH-[\d.]+)',c['command'],re.I))
 return {'id':sid,'path':index[sid]['path'],'agent':meta.get('agent_path','/root'),'parent':meta.get('parent_thread_id'),'forked':bool(meta.get('forked_from_id')),'models':dict(Counter('/'.join(str(y) for y in x) for x in contexts)), 'method':method,'usage':total,'responses':len(usages),'first_input':usages[0]['input_tokens'] if usages else None,'max_input':max((u['input_tokens'] for u in usages),default=0),'last_input':usages[-1]['input_tokens'] if usages else None,'calls':dict(Counter(c['name'] for c in calls)), 'compactions':sum(r['type']=='compacted' for _,r in rows),'commands_count':len(commands),'doc_reads':dict(docs),'task_reads':dict(tasks),'turns':turns,'usages':usages,'waits':waits,'commands':commands,'messages':messages,'call_details':calls}

results={}
for rid,title in ROOTS.items():
 ids=[rid]
 for sid in ids:
  ids.extend(k for k,e in index.items() if e['meta'].get('parent_thread_id')==sid and e['meta'].get('agent_path') and k not in ids)
 records=[measure(s) for s in ids]
 results[rid]={'title':title,'records':records}
compact={}
for rid,g in results.items():
 records=[]
 for r in g['records']:
  row={k:v for k,v in r.items() if k not in ('usages','commands','messages','call_details','waits')}
  timed=[w for w in r['waits'] if '"timed_out":true' in w['result']]
  assert len({w['issuing_response']['line'] for w in timed})==len(timed)
  row['empty_waits']={'count':len(timed),'source_lines':[w['line'] for w in timed], 'issuing_response_usage':{k:sum(w['issuing_response'][k] for w in timed) for k in ('input_tokens','cached_input_tokens','output_tokens')}}
  records.append(row)
 compact[rid]={'title':g['title'],'records':records}
(OUT/'metrics.json').write_text(json.dumps(compact,indent=2),encoding='utf-8')

print('Measured three runs; all ten per-thread token aggregates reconcile.')
