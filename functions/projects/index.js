import { queryPublishedCaseStudies } from '../_lib/case-studies.js';

function esc(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

export async function onRequestGet({ env, next }) {
  const response = await next();
  if (!response.ok || !String(response.headers.get('Content-Type') || '').includes('text/html')) return response;
  let jobs = [];
  try { jobs = await queryPublishedCaseStudies(env); } catch { return response; }
  if (!jobs.length) return response;
  const cards = jobs
    .sort((a, b) => String(b.caseStudy.publishedAt || '').localeCompare(String(a.caseStudy.publishedAt || '')))
    .map(({ caseStudy: study }) => `<article class="project-card reveal"><p class="project-card-meta">${esc(study.city)} · ${esc(study.serviceType)} · ${esc(study.duration || 'Completed project')}</p><h3><a href="/projects/${encodeURIComponent(study.slug)}">${esc(study.title)}</a></h3><p>${esc(study.description)}</p><a href="/projects/${encodeURIComponent(study.slug)}" class="project-card-link content-link">Read case study →</a></article>`)
    .join('');
  const html = (await response.text())
    .replace('<!-- DYNAMIC_PROJECTS -->', `<!-- DYNAMIC_PROJECTS -->${cards}`)
    .replace(/<article class="project-card reveal" id="projects-empty">[\s\S]*?<\/article>/, '');
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'public, max-age=300');
  headers.delete('Content-Length');
  return new Response(html, { status: response.status, headers });
}
