// Reading position is separate from recoverable writing and server revisions.
export function captureTaskView(root, active, state = {}) {
  const controls = [...root.querySelectorAll('button,input,textarea,select,a,summary,[tabindex]')];
  const focusIndex = controls.indexOf(active);
  const identity = active && root.contains(active) ? ['name','data-related','data-doc-link','data-doc-anchor','id'].map(attribute => ({attribute,value:active.getAttribute(attribute)})).find(item => item.value) : null;
  return {...state,scrollTop:root.scrollTop,focusIndex,identity,disclosures:[...root.querySelectorAll('details')].map(el => el.open)};
}

export function restoreTaskView(root, snapshot) {
  if (!snapshot) return;
  [...root.querySelectorAll('details')].forEach((el,index) => {if (snapshot.disclosures?.[index] !== undefined) el.open = snapshot.disclosures[index];});
  const controls = [...root.querySelectorAll('button,input,textarea,select,a,summary,[tabindex]')];
  const visible = el => el && !el.disabled && !el.closest('[hidden]') && (!el.getClientRects || el.getClientRects().length > 0);
  const matches = el => !snapshot.identity || el.getAttribute(snapshot.identity.attribute) === snapshot.identity.value;
  const indexed = controls[snapshot.focusIndex];
  // Repeated document addresses can occur in both hidden narrative and visible discussion.
  const target = visible(indexed) && matches(indexed) ? indexed : snapshot.identity ? controls.find(el => visible(el) && matches(el)) : null;
  target?.focus({preventScroll:true});
  root.scrollTop = Number.isFinite(snapshot.scrollTop) ? Math.max(0,snapshot.scrollTop) : 0;
}
