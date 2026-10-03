// Agents: live provider sessions with steering. Filled in once the agent API lands.
export function mountAgents(container) {
  container.replaceChildren();
  const heading = document.createElement('h1');
  heading.textContent = 'Agents';
  container.append(heading);
  return { refresh() {}, destroy() {} };
}
