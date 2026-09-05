"""Locate the three latest FH orchestration runs and their delivery/review agents."""
import json
from pathlib import Path
BASE = Path(r'C:\Users\keech\.codex')
OUT = Path(__file__).parent
ROOTS = {'01a0700d-eef1-78b0-949c-b573deae12f2','01a06f88-2017-7f32-a830-18f516a4ad42','01a06f5e-35f8-7241-ba84-d3ab2c4b9bf5'}
index = {}
for p in list((BASE/'sessions').rglob('*.jsonl')) + list((BASE/'archived_sessions').glob('*.jsonl')):
 try:
  with p.open(encoding='utf-8') as f: row=json.loads(next(f))
  m=row.get('payload',{})
  if row['type']=='session_meta':
   index[m['id']]={'path':str(p),'meta':{k:m[k] for k in ('id','parent_thread_id','timestamp','agent_path','forked_from_id') if k in m}}
 except (ValueError, StopIteration, KeyError): pass
selected=set(ROOTS)
while True:
 expanded=selected | {sid for sid,e in index.items() if e['meta'].get('parent_thread_id') in selected and e['meta'].get('agent_path')}
 if expanded==selected: break
 selected=expanded
result={sid:index[sid] for sid in sorted(selected)}
(OUT/'session-index.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
print(f'Located {len(ROOTS)} orchestrators and {len(result)-len(ROOTS)} delivery/review agents.')
