export function workspaceLocation(href) {
  const url = new URL(href);
  const allowed = ['board','tasks','milestones','documents','decisions','drafts','statistics','skills','settings'];
  const requested = url.searchParams.get('view');
  return {project:url.searchParams.get('project'),view:allowed.includes(requested) ? requested : 'board',task:url.searchParams.get('task'),record:url.searchParams.get('record')};
}

export function createNativeClient({projectId,token,canWrite = () => true,onWrite = () => {},fetcher = fetch}) {
  return async (route,{method = 'GET',body} = {}) => {
    if (!projectId || !route.startsWith('/') || route.startsWith('//') || /[\\\u0000-\u001f]/.test(route) || route.split('?')[0].split('/').some(part => ['.','..'].includes(decodeURIComponent(part)))) throw new Error('Invalid project API route.');
    const writing = !['GET','HEAD'].includes(method);
    if (writing && !canWrite()) throw new Error('Changes are paused until this project is connected and its agents are idle. Your draft is retained.');
    if (writing) onWrite(1);
    try {
      const response = await fetcher(`/api/projects/${encodeURIComponent(projectId)}/native${route}`,{
        method,credentials:'same-origin',cache:'no-store',
        ...(writing ? {headers:{'Content-Type':'application/json','X-Switchflow-Token':token()},...(body === undefined ? {} : {body:JSON.stringify(body)})} : {}),
      });
      const data = response.status === 204 ? null : await response.json();
      if (!response.ok) {
        const error = new Error(typeof data?.error === 'string' ? data.error : data?.message || `Request failed (${response.status}).`);
        error.status = response.status;
        // A server failure may follow an applied write. Only an explicit client
        // rejection establishes that retry cannot duplicate an earlier effect.
        if (writing) error.outcome = response.status < 500 ? 'rejected' : 'unknown';
        throw error;
      }
      return data;
    } catch (error) {
      if (writing && (!error.status || error.outcome === 'unknown')) {
        error.outcome = 'unknown';
        error.requiresReconciliation = true;
        error.message += ' The save outcome is uncertain. Check the saved record before retrying.';
      }
      throw error;
    } finally { if (writing) onWrite(-1); }
  };
}
