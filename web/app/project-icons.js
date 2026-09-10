import { ICONS, PROJECTS } from './project-catalog.js';

export function projectIcon(project) {
  const id = project.icon || PROJECTS[project.key]?.icon || (project.key === 'all' ? 'grid' : 'folder');
  const body = Object.hasOwn(ICONS, id) ? ICONS[id].body : ICONS.folder.body;
  return `<svg class="project-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}
