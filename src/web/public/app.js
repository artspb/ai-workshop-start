// The page: a thin client of /api/scan and /api/scans. The address holds the scan:
// /?repo=<URL | directory> scans, /?scan=<id> opens a stored scan.
import { filterSkills } from './filter.js';
import { addressRequest, historyView, storedBox } from './history.js';

const $ = (id) => document.getElementById(id);
const form = $('scan');
const input = $('repo');
const status = $('status');
const result = $('result');
const filter = $('filter');
const earlier = $('history');

/** The last scan's skills; the filter shows a part of them. */
let skills = [];
/** Only the latest scan is shown, whatever order the answers come in. */
let latest = 0;
/** The stored scan on the page, if any: the one marked in Scanned before. */
let shown = null;

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const repo = input.value.trim();
  if (!repo) return;
  history.pushState(null, '', `/?repo=${encodeURIComponent(repo)}`);
  scanAddress();
});
window.addEventListener('popstate', scanAddress);
filter.addEventListener('input', showSkills);
// A stored scan opens in place: the address changes, the page does not reload.
earlier.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-scan]');
  if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  history.pushState(null, '', link.getAttribute('href'));
  scanAddress();
});
scanAddress();

/** Scans what the address names, or opens the stored scan it names, if anything. */
async function scanAddress() {
  const request = addressRequest(location.search);
  input.value = request?.repo ?? '';
  // Every address cancels the scan before it, an empty one too.
  const scan = ++latest;
  shown = null;
  if (!request) {
    status.hidden = result.hidden = true;
    return showHistory();
  }
  showStatus(request.repo ? `Scanning ${request.repo}…` : 'Opening the stored scan…');
  result.hidden = true;
  let answer;
  try {
    answer = await (await fetch(request.url)).json();
  } catch (error) {
    answer = { error: `The Skill Atlas server does not answer: ${error.message}` };
  }
  if (scan !== latest) return;
  if (answer.error) {
    showStatus(answer.error, true);
  } else {
    status.hidden = true;
    if (request.scan) input.value = storedBox(answer.repository);
    shown = answer.stored;
    showResult(answer);
  }
  // A new scan may be stored now.
  showHistory();
}

/** Every stored scan, the latest first; the one on the page is marked. */
async function showHistory() {
  const asked = latest;
  let scans;
  try {
    ({ scans } = await (await fetch('/api/scans')).json());
  } catch {
    return;
  }
  if (asked !== latest) return;
  const view = historyView(scans, shown);
  earlier.querySelector('ul').replaceChildren(
    ...view.rows.map((row) => {
      const link = element('a', { href: row.href }, row.name);
      link.dataset.scan = row.id;
      return element('li', { className: row.current ? 'current' : '' }, link, ' at ', element('code', { title: row.commit }, row.short), ` · ${row.details}`);
    }),
  );
  earlier.hidden = view.hidden;
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
  // A browser does not open file:// from a page: a local directory's name is text.
  if (repository.url.startsWith('file:')) link.removeAttribute('href');
  else link.href = repository.url;
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
