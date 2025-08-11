// Minimal UI that calls the bridge API and renders todos

function formatYMD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseYMD(ymd) {
  const [y, m, d] = ymd.split('-').map(v => parseInt(v, 10));
  return new Date(y, m - 1, d);
}

function getWeekRange(anchorYmd) {
  const dt = parseYMD(anchorYmd);
  const weekday = dt.getDay(); // 0=Sun..6=Sat
  const mondayOffset = (weekday + 6) % 7;
  const monday = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - mondayOffset);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return { from: formatYMD(monday), to: formatYMD(sunday) };
}

function getMonthRange(anchorYmd) {
  const dt = parseYMD(anchorYmd);
  const first = new Date(dt.getFullYear(), dt.getMonth(), 1);
  const last = new Date(dt.getFullYear(), dt.getMonth() + 1, 0);
  return { from: formatYMD(first), to: formatYMD(last) };
}

const state = {
  view: 'day',
  anchor: formatYMD(new Date()),
  showCompleted: false,
};

const anchorInput = document.getElementById('anchor');
const viewSelect = document.getElementById('view');
const showCompleted = document.getElementById('showCompleted');
const msg = document.getElementById('message');
const todosList = document.getElementById('todos');
const backlogList = document.getElementById('backlog');
const searchInput = document.getElementById('search');
const searchResults = document.getElementById('searchResults');
const addForm = document.getElementById('addForm');
const inputTitle = document.getElementById('title');
const inputNotes = document.getElementById('notes');
const inputScheduledFor = document.getElementById('scheduledFor');
const inputPriority = document.getElementById('priority');
const llmForm = document.getElementById('llmForm');
const instructionInput = document.getElementById('instruction');
const proposalDiv = document.getElementById('proposal');
const applyOpsBtn = document.getElementById('applyOps');

anchorInput.value = state.anchor;
viewSelect.value = state.view;

async function checkHealth() {
  try {
    const res = await fetch('/health');
    const data = await res.json();
    if (!data.ok) throw new Error('Unhealthy');
    msg.textContent = '';
  } catch (e) {
    msg.textContent = 'Bridge not ready';
  }
}

function computeRange() {
  if (state.view === 'day') return { from: state.anchor, to: state.anchor };
  if (state.view === 'week') return getWeekRange(state.anchor);
  return getMonthRange(state.anchor);
}

function priorityBadge(priority) {
  const p = String(priority || 'medium');
  const cls = p === 'high' ? 'prio-high' : p === 'low' ? 'prio-low' : 'prio-medium';
  return `<span class="badge ${cls}">${p}</span>`;
}

function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.substring(2).toLowerCase(), v);
    else if (k === 'html') n.innerHTML = v;
    else n.setAttribute(k, v);
  });
  children.forEach(c => n.appendChild(c));
  return n;
}

async function fetchJSON(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'request_failed');
  return data;
}

async function loadTodos() {
  const { from, to } = computeRange();
  const params = new URLSearchParams();
  params.set('from', from);
  params.set('to', to);
  if (!state.showCompleted) params.set('completed', 'false');
  const data = await fetchJSON(`/api/todos?${params.toString()}`);
  return data.todos || [];
}

async function loadBacklog() {
  const data = await fetchJSON('/api/todos/backlog');
  let items = data.todos || [];
  if (!state.showCompleted) items = items.filter(t => !t.completed);
  return items;
}

function renderList(container, items) {
  container.innerHTML = '';
  for (const t of items) {
    const left = el('div', { class: 'left' });
    const checkbox = el('input', { type: 'checkbox' });
    checkbox.checked = !!t.completed;
    checkbox.addEventListener('change', () => toggleCompleted(t));
    const titleSpan = el('span', { html: `${priorityBadge(t.priority)} ${t.title}` });
    left.appendChild(checkbox);
    left.appendChild(document.createTextNode(' '));
    left.appendChild(titleSpan);

    const actions = el('div', { class: 'actions' }, [
      el('button', { onClick: () => startInlineEdit(t) }, [document.createTextNode('Edit')]),
      el('button', { onClick: () => deleteTodo(t) }, [document.createTextNode('Delete')]),
    ]);

    const li = el('li', { class: t.completed ? 'todo-completed' : '' }, [left, actions]);
    container.appendChild(li);
  }
}

function renderScheduledGrouped(container, items) {
  container.innerHTML = '';
  // group by scheduledFor
  const groups = new Map();
  for (const t of items) {
    const key = t.scheduledFor || 'unscheduled';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const keys = Array.from(groups.keys()).sort();
  for (const k of keys) {
    const header = el('li', { class: 'date-header' }, [document.createTextNode(k)]);
    container.appendChild(header);
    renderList(container, groups.get(k));
  }
}

async function updateUI() {
  try {
    await checkHealth();
    const [todos, backlog] = await Promise.all([loadTodos(), loadBacklog()]);
    renderScheduledGrouped(todosList, todos);
    renderList(backlogList, backlog);
  } catch (e) {
    msg.textContent = `Error: ${e.message}`;
  }
}

async function createTodo(evt) {
  evt.preventDefault();
  const title = inputTitle.value.trim();
  if (!title) return;
  const payload = {
    title,
    notes: inputNotes.value || '',
    scheduledFor: inputScheduledFor.value ? inputScheduledFor.value : null,
    priority: inputPriority.value || 'medium',
  };
  try {
    await fetchJSON('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    inputTitle.value = '';
    inputNotes.value = '';
    inputScheduledFor.value = '';
    inputPriority.value = 'medium';
    await updateUI();
  } catch (e) {
    msg.textContent = `Create failed: ${e.message}`;
  }
}

async function toggleCompleted(todo) {
  try {
    await fetchJSON(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ completed: !todo.completed }),
    });
    await updateUI();
  } catch (e) {
    msg.textContent = `Toggle failed: ${e.message}`;
  }
}

async function editTodo(todo) {
  const newTitle = window.prompt('New title (leave blank to keep):', todo.title);
  const newNotes = window.prompt('New notes (leave blank to keep):', todo.notes || '');
  const newPriority = window.prompt('Priority low|medium|high (leave blank to keep):', todo.priority || 'medium');
  const newDate = window.prompt('Scheduled for YYYY-MM-DD or empty for unscheduled (leave blank to keep):', todo.scheduledFor || '');
  const update = {};
  if (newTitle !== null && newTitle !== '' && newTitle !== todo.title) update.title = newTitle;
  if (newNotes !== null && newNotes !== '' && newNotes !== (todo.notes || '')) update.notes = newNotes;
  if (newPriority !== null && newPriority !== '' && newPriority !== todo.priority) update.priority = newPriority;
  if (newDate !== null) {
    if (newDate === '') update.scheduledFor = null;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(newDate)) update.scheduledFor = newDate;
  }
  if (Object.keys(update).length === 0) return;
  try {
    await fetchJSON(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(update),
    });
    await updateUI();
  } catch (e) {
    msg.textContent = `Edit failed: ${e.message}`;
  }
}

// Inline edit UI
let editingId = null;
function startInlineEdit(todo) {
  if (editingId !== null) return; // simple guard: one at a time
  editingId = todo.id;

  const liNodes = Array.from(document.querySelectorAll('#todos li, #backlog li'));
  const target = liNodes.find((n) => n.textContent && n.textContent.includes(todo.title));
  if (!target) { editingId = null; return; }

  target.innerHTML = '';
  const titleInput = el('input', { type: 'text', value: todo.title });
  const notesInput = el('input', { type: 'text', value: todo.notes || '', placeholder: 'Notes' });
  const dateInput = el('input', { type: 'date', value: todo.scheduledFor || '' });
  const prioSelect = el('select');
  ['low','medium','high'].forEach(p => {
    const opt = document.createElement('option');
    opt.value = p; opt.textContent = p; if ((todo.priority || 'medium') === p) opt.selected = true; prioSelect.appendChild(opt);
  });
  const saveBtn = el('button', { onClick: () => submitInlineEdit(todo.id, titleInput.value, notesInput.value, dateInput.value || null, prioSelect.value) }, [document.createTextNode('Save')]);
  const cancelBtn = el('button', { onClick: () => { editingId = null; updateUI(); } }, [document.createTextNode('Cancel')]);
  const form = el('div', { class: 'edit-form' }, [titleInput, notesInput, dateInput, prioSelect, saveBtn, cancelBtn]);
  target.appendChild(form);
}

async function submitInlineEdit(id, title, notes, scheduledFor, priority) {
  const payload = {};
  const orig = (await fetchJSON(`/api/todos/${id}`)).todo;
  if (title !== orig.title) payload.title = title;
  if ((notes || '') !== (orig.notes || '')) payload.notes = notes || '';
  if ((scheduledFor || null) !== (orig.scheduledFor || null)) payload.scheduledFor = scheduledFor || null;
  if ((priority || 'medium') !== (orig.priority || 'medium')) payload.priority = priority || 'medium';
  if (Object.keys(payload).length === 0) { editingId = null; updateUI(); return; }
  try {
    await fetchJSON(`/api/todos/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    editingId = null;
    await updateUI();
  } catch (e) {
    msg.textContent = `Edit failed: ${e.message}`;
  }
}

async function deleteTodo(todo) {
  if (!window.confirm('Delete this todo?')) return;
  try {
    await fetchJSON(`/api/todos/${todo.id}`, { method: 'DELETE' });
    await updateUI();
  } catch (e) {
    msg.textContent = `Delete failed: ${e.message}`;
  }
}

// Event handlers
anchorInput.addEventListener('change', () => { state.anchor = anchorInput.value || formatYMD(new Date()); updateUI(); });
viewSelect.addEventListener('change', () => { state.view = viewSelect.value; updateUI(); });
showCompleted.addEventListener('change', () => { state.showCompleted = showCompleted.checked; updateUI(); });
addForm.addEventListener('submit', createTodo);

// Initial load
updateUI();

// ----- LLM proposal-and-verify -----
function renderProposal(operations) {
  proposalDiv.innerHTML = '';
  const checkboxes = [];
  for (const op of operations) {
    const row = el('div', { class: 'proposal-item' });
    const cb = el('input', { type: 'checkbox' });
    cb.checked = true; checkboxes.push({ cb, op });
    const label = el('div', { html: `<span class="proposal-op">${op.op}</span> ${op.id ? `#${op.id}` : ''} ${op.title ? `– ${op.title}` : ''}` });
    row.appendChild(cb);
    row.appendChild(label);
    proposalDiv.appendChild(row);
  }
  applyOpsBtn.style.display = operations.length ? 'inline-block' : 'none';
  applyOpsBtn.onclick = async () => {
    const selected = checkboxes.filter(x => x.cb.checked).map(x => x.op);
    if (!selected.length) { msg.textContent = 'No operations selected.'; return; }
    try {
      const resp = await fetchJSON('/api/llm/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operations: selected }) });
      msg.textContent = `Applied: c=${resp.summary.created}, u=${resp.summary.updated}, d=${resp.summary.deleted}, done=${resp.summary.completed}`;
      proposalDiv.innerHTML = '';
      applyOpsBtn.style.display = 'none';
      instructionInput.value = '';
      await updateUI();
    } catch (e) {
      msg.textContent = `Apply failed: ${e.message}`;
    }
  };
}

async function submitInstruction(evt) {
  evt.preventDefault();
  const instruction = (instructionInput.value || '').trim();
  if (!instruction) return;
  try {
    const resp = await fetchJSON('/api/llm/propose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction }) });
    renderProposal(resp.operations || []);
  } catch (e) {
    msg.textContent = `Propose failed: ${e.message}`;
  }
}

llmForm.addEventListener('submit', submitInstruction);

// ----- Search wiring -----
let searchTimer = null;
async function runSearch(q) {
  if (!q) { searchResults.innerHTML = ''; return; }
  try {
    const data = await fetchJSON(`/api/todos/search?query=${encodeURIComponent(q)}`);
    renderList(searchResults, data.todos || []);
  } catch (e) {
    msg.textContent = `Search failed: ${e.message}`;
  }
}
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(q), 250);
});

// ----- URL state (anchor/view/showCompleted) -----
function applyStateToUrl() {
  const params = new URLSearchParams(window.location.search);
  params.set('anchor', state.anchor);
  params.set('view', state.view);
  params.set('completed', String(state.showCompleted));
  history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
}

function loadStateFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const anchor = params.get('anchor');
  const view = params.get('view');
  const completed = params.get('completed');
  if (anchor && /^\d{4}-\d{2}-\d{2}$/.test(anchor)) state.anchor = anchor;
  if (view && ['day','week','month'].includes(view)) state.view = view;
  if (completed === 'true' || completed === 'false') state.showCompleted = completed === 'true';
  anchorInput.value = state.anchor; viewSelect.value = state.view; showCompleted.checked = state.showCompleted;
}

loadStateFromUrl();
anchorInput.addEventListener('change', applyStateToUrl);
viewSelect.addEventListener('change', applyStateToUrl);
showCompleted.addEventListener('change', applyStateToUrl);


