// The page: a thin client of /api/scan and /api/scans. The address holds the scan:
// /?repo=<URL | directory | organization URL> scans, /?scan=<id> opens a stored scan.
import { filterRepositories, filterSkills } from './filter.js';
import { addressRequest, historyView, scanSignals, searchAsker, searchView, storedBox, storedOnPage } from './history.js';
import { errorText, progressText, progressUrl, quotaText, readAnswer, requestsText, stoppedText } from './progress.js';

const $ = (id) => document.getElementById(id);
const form = $('scan');
const input = $('repo');
const status = $('status');
const result = $('result');
const filter = $('filter');
const earlier = $('history');
const stop = $('stop');
const bar = $('progress');
const search = $('search');
const requests = $('requests');

/** The last scan's skills; the filter shows a part of them. */
let skills = [];
/** The last scan's repositories with skills, for an organization; null for one repository. */
let repositories = null;
/** Only the latest scan is shown, whatever order the answers come in. */
let latest = 0;
/** Aborts the scan asked for last, the server then stops asking GitHub for it, and gives the next one's signal. */
const nextScan = scanSignals();
/** The stored scan on the page, if any: the one marked in Scanned before. */
let shown = null;
/** The last quota the page heard of, from an answer or the server: shown under the box before a scan's own line. */
let quota = null;
/** The scan running, for Stop: what it scans and how far it got; null when none runs. */
let running = null;
/** The search, asked once the typing pauses; only the latest word's answer is shown. */
const searchFor = searchAsker(async (query) => (await fetch(`/api/search?q=${encodeURIComponent(query)}`)).json(), showSearch);

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const repo = input.value.trim();
  if (!repo) return;
  history.pushState(null, '', `/?repo=${encodeURIComponent(repo)}`);
  scanAddress();
});
window.addEventListener('popstate', scanAddress);
filter.addEventListener('input', showSkills);
search.addEventListener('input', () => searchFor(search.value));
// Stop: the scan is aborted, as on another scan, so the server stops asking GitHub for it; the address stays.
stop.addEventListener('click', () => {
  if (!running) return;
  const { repo, progress } = running;
  latest++;
  nextScan();
  showRunning(null);
  showStatus(stoppedText(repo, progress));
  // The repositories scanned before the stop are stored.
  showHistory();
});
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
  const signal = nextScan();
  shown = null;
  showRunning(null);
  if (!request) {
    status.hidden = result.hidden = true;
    showQuota();
    return showHistory();
  }
  showRequests(quotaText(quota));
  showStatus(request.repo ? progressText(request.repo) : 'Opening the stored scan…');
  if (request.repo) showRunning({ repo: request.repo, progress: null });
  result.hidden = true;
  let answer;
  try {
    answer = await readAnswer(await fetch(progressUrl(request), { signal }), (progress, line) => {
      if (scan !== latest) return;
      showRunning({ repo: request.repo, progress });
      showStatus(progressText(request.repo, progress));
      // The counts and the quota as the scan goes: Stop before the quota runs out.
      if (line.quota) quota = line.quota;
      showRequests(requestsText(line));
    });
  } catch (error) {
    answer = { error: `The Skill Atlas server does not answer: ${error.message}` };
  }
  if (scan !== latest) return;
  showRunning(null);
  if (answer.quota) quota = answer.quota;
  if (answer.requests) showRequests(requestsText(answer));
  if (answer.error) {
    showStatus(errorText(answer), true);
  } else {
    status.hidden = true;
    if (request.scan) input.value = storedBox(answer.repository);
    shown = storedOnPage(answer);
    if (answer.organization) showOrganization(answer);
    else showResult(answer);
  }
  // A new scan may be stored now.
  showHistory();
}

/** A scan's requests and the quota left, under the box; '' hides the line. */
function showRequests(text) {
  requests.textContent = text;
  requests.hidden = !text;
}

/** Before any scan: the quota the server last saw, from an earlier scan; it never asks GitHub for it. */
async function showQuota() {
  const asked = latest;
  try {
    ({ quota } = await (await fetch('/api/quota')).json());
  } catch {
    return;
  }
  if (asked === latest) showRequests(quotaText(quota));
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
  $('scans').replaceChildren(
    ...view.rows.map((row) => {
      const link = element('a', { href: row.href }, row.name);
      link.dataset.scan = row.id;
      return element('li', { className: row.current ? 'current' : '' }, link, ' at ', element('code', { title: row.commit }, row.short), ` · ${row.details}`);
    }),
  );
  earlier.hidden = view.hidden;
  // A new scan may be stored now: searched again, without waiting for a pause.
  searchFor(search.value, 0);
}

/** The search across stored scans, from the store only: while it has a word, its results in place of the list. */
function showSearch(query, { results, more }) {
  const view = searchView(query, results, more);
  $('found').replaceChildren(
    ...view.rows.map((row) => {
      const scan = element('a', { href: row.href }, row.repository);
      scan.dataset.scan = row.scan;
      const item = element('li', { className: 'skill' }, element('h3', {}, row.name));
      if (row.sentence) item.append(element('p', { className: 'description' }, row.sentence));
      item.append(
        element('p', { className: 'where' }, scan, ' at ', element('code', { title: row.commit }, row.short), ` · ${row.refs}`),
        element('p', { className: 'link' }, element('a', { href: row.link }, row.link)),
      );
      return item;
    }),
  );
  $('found').hidden = !view.searching || view.empty;
  $('none').hidden = !view.empty;
  $('more').textContent = view.more;
  $('more').hidden = !view.more;
  $('scans').hidden = view.searching;
}

/** The scan running: Stop, and a bar, of the repositories scanned for an organization; none: both hidden. */
function showRunning(scan) {
  running = scan;
  stop.hidden = bar.hidden = !scan;
  if (scan?.progress) {
    bar.max = Math.max(scan.progress.repositories, 1);
    bar.value = scan.progress.scanned;
  } else bar.removeAttribute('value');
}

function showStatus(text, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
  status.hidden = false;
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function showResult({ repository, skills: scanned, warnings }) {
  skills = scanned;
  repositories = null;
  const link = $('repository');
  link.textContent = repository.id;
  // A browser does not open file:// from a page: a local directory's name is text.
  if (repository.url.startsWith('file:')) link.removeAttribute('href');
  else link.href = repository.url;
  $('count').textContent = count(scanned.length, 'skill', 'skills');
  $('commit').textContent = repository.commit ? `at ${repository.commit.slice(0, 12)}` : 'local directory';
  $('commit').title = repository.commit;
  showRest(warnings);
}

/** An organization: the owner and its counts, then each repository with skills, as one is shown. */
function showOrganization({ organization, repositories: scanned, warnings }) {
  repositories = scanned;
  skills = scanned.flatMap((repository) => repository.skills);
  const link = $('repository');
  link.textContent = organization.id;
  link.href = organization.url;
  $('count').textContent = `${count(organization.repositories, 'repository', 'repositories')} · ${count(organization.skills, 'skill', 'skills')}`;
  $('commit').textContent = '';
  $('commit').title = '';
  showRest(warnings);
}

function showRest(warnings) {
  filter.value = '';
  filter.hidden = skills.length === 0;
  showSkills();
  const list = $('warnings').querySelector('ul');
  list.replaceChildren(...warnings.map((warning) => element('li', {}, warning)));
  $('warnings').hidden = warnings.length === 0;
  result.hidden = false;
}

function showSkills() {
  if (repositories) {
    const shown = filterRepositories(repositories, filter.value);
    $('skills').replaceChildren(...shown.map(repositoryItem));
    $('empty').hidden = shown.length > 0 || skills.length === 0;
    return;
  }
  const shown = filterSkills(skills, filter.value);
  $('skills').replaceChildren(...shown.map(skillItem));
  $('empty').hidden = shown.length > 0 || skills.length === 0;
}

/** One repository of an organization: its name, whole skill count and commit, then the skills the filter shows. */
function repositoryItem({ repository, skills: shown, total }) {
  const heading = element(
    'h3',
    {},
    element('a', { href: repository.url }, repository.id),
    ` · ${count(total, 'skill', 'skills')} `,
    element('span', { className: 'commit', title: repository.commit }, `at ${repository.commit.slice(0, 12)}`),
  );
  return element('li', { className: 'repository' }, heading, element('ul', {}, ...shown.map(skillItem)));
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
