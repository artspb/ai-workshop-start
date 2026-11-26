// The page: a thin client of /api/scan. The address holds the scan: /?repo=<URL | directory>.
import { filterSkills } from './filter.js';

const $ = (id) => document.getElementById(id);
const form = $('scan');
const input = $('repo');
const status = $('status');
const result = $('result');
const filter = $('filter');

/** The last scan's skills; the filter shows a part of them. */
let skills = [];
/** Only the latest scan is shown, whatever order the answers come in. */
let latest = 0;

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const repo = input.value.trim();
  if (!repo) return;
  history.pushState(null, '', `/?repo=${encodeURIComponent(repo)}`);
  scanAddress();
});
window.addEventListener('popstate', scanAddress);
filter.addEventListener('input', showSkills);
scanAddress();

/** Scans what the address names, if anything. */
async function scanAddress() {
  const repo = new URLSearchParams(location.search).get('repo')?.trim() ?? '';
  input.value = repo;
  if (!repo) {
    status.hidden = result.hidden = true;
    return;
  }
  const scan = ++latest;
  showStatus(`Scanning ${repo}…`);
  result.hidden = true;
  let answer;
  try {
    const response = await fetch(`/api/scan?repo=${encodeURIComponent(repo)}`);
    answer = await response.json();
  } catch (error) {
    answer = { error: `The Skill Atlas server does not answer: ${error.message}` };
  }
  if (scan !== latest) return;
  if (answer.error) return showStatus(answer.error, true);
  status.hidden = true;
  showResult(answer);
}

function showStatus(text, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
  status.hidden = false;
}

function showResult({ repository, skills: scanned, warnings }) {
  skills = scanned;
  const link = $('repository');
  link.textContent = repository.id;
  link.href = repository.url;
  $('count').textContent = `${scanned.length} ${scanned.length === 1 ? 'skill' : 'skills'}`;
  $('commit').textContent = repository.commit ? `at ${repository.commit.slice(0, 12)}` : 'local directory';
  $('commit').title = repository.commit;
  filter.value = '';
  filter.hidden = scanned.length === 0;
  showSkills();
  const list = $('warnings').querySelector('ul');
  list.replaceChildren(...warnings.map((warning) => element('li', {}, warning)));
  $('warnings').hidden = warnings.length === 0;
  result.hidden = false;
}

function showSkills() {
  const shown = filterSkills(skills, filter.value);
  $('skills').replaceChildren(...shown.map(skillItem));
  $('empty').hidden = shown.length > 0 || skills.length === 0;
}

function skillItem(skill) {
  const item = element('li', { className: 'skill' }, element('h3', {}, skill.name));
  if (skill.description) item.append(element('p', { className: 'description' }, skill.description));
  item.append(linkLine(skill.link));
  if (skill.copies.length > 0) item.append(element('p', { className: 'copies' }, `also in ${skill.copies.join(', ')}`));
  return item;
}

/** A GitHub link opens; a browser does not open file:// from a page, so that one is text to copy. */
function linkLine(link) {
  if (!link.startsWith('file:')) return element('p', { className: 'link' }, element('a', { href: link }, link));
  const copy = element('button', { type: 'button', className: 'copy' }, 'Copy');
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(link);
    copy.textContent = 'Copied';
    setTimeout(() => (copy.textContent = 'Copy'), 1500);
  });
  return element('p', { className: 'link' }, element('code', {}, link), copy);
}

function element(tag, properties, ...children) {
  const node = Object.assign(document.createElement(tag), properties);
  node.append(...children);
  return node;
}
