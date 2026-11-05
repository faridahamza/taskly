/**
 * Taskly – script.js
 * Vanilla JS To-Do List. No frameworks, no server.
 * Features: Add / Edit / Delete / Complete / Search / Filter /
 *           Stats / Progress bar / Priority / Due time /
 *           In-browser reminders / Toast notifications.
 */

'use strict';

/* ============================================================
   CONSTANTS & STATE
   ============================================================ */
const STORAGE_KEY = 'taskly_tasks_v1';

/** @type {Task[]} */
let tasks        = [];
let activeFilter = 'all';  // 'all' | 'pending' | 'completed'
let searchQuery  = '';
let taskToDelete = null;

/** Map<taskId, timeoutId> – active reminder timeouts */
const reminderTimers = new Map();

/* ============================================================
   TYPEDEF
   @typedef {Object} Task
   @property {string}  id
   @property {string}  name
   @property {string}  desc
   @property {string}  due            YYYY-MM-DD or ''
   @property {string}  dueTime        HH:MM or ''
   @property {string}  priority       'none'|'low'|'medium'|'high'
   @property {boolean} reminder
   @property {number}  reminderOffset minutes before due
   @property {boolean} completed
   @property {number}  createdAt
   ============================================================ */

/* ============================================================
   LOCAL STORAGE
   ============================================================ */
function loadTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(t => t && typeof t === 'object' &&
                   typeof t.id === 'string' &&
                   typeof t.name === 'string')
      .map(sanitiseTask);
  } catch {
    console.warn('Taskly: localStorage data was corrupted. Starting fresh.');
    return [];
  }
}

function saveTasks() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch (e) {
    console.error('Taskly: Could not save to localStorage.', e);
  }
}

/** Fill in any missing fields — backward-compatible with old task objects. */
function sanitiseTask(t) {
  return {
    id:             typeof t.id             === 'string'  ? t.id             : generateId(),
    name:           typeof t.name           === 'string'  ? t.name.trim()    : '',
    desc:           typeof t.desc           === 'string'  ? t.desc.trim()    : '',
    due:            typeof t.due            === 'string'  ? t.due            : '',
    dueTime:        typeof t.dueTime        === 'string'  ? t.dueTime        : '',
    priority:       ['none','low','medium','high'].includes(t.priority) ? t.priority : 'none',
    reminder:       typeof t.reminder       === 'boolean' ? t.reminder       : false,
    reminderOffset: typeof t.reminderOffset === 'number'  ? t.reminderOffset : 15,
    completed:      typeof t.completed      === 'boolean' ? t.completed      : false,
    createdAt:      typeof t.createdAt      === 'number'  ? t.createdAt      : Date.now(),
  };
}

/* ============================================================
   UTILITIES
   ============================================================ */
function generateId() {
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** YYYY-MM-DD for today in local time. */
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

/** Format YYYY-MM-DD → "5 Nov 2026" */
function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric'
  });
}

/** Format HH:MM → "9:00 AM" (locale-aware) */
function formatTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function isOverdue(task) {
  if (!task.due || task.completed) return false;
  return task.due < todayISO();
}

function isDueSoon(task) {
  if (!task.due || task.completed) return false;
  const today    = todayISO();
  const d = new Date(); d.setDate(d.getDate() + 1);
  const tomorrow = d.toISOString().slice(0, 10);
  return task.due === today || task.due === tomorrow;
}

/** Escape HTML to prevent XSS when setting innerHTML. */
function escHtml(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g, '&#39;');
}

/** Wrap search matches in a yellow highlight mark. */
function highlight(text, query) {
  if (!query) return escHtml(text);
  const safe  = escHtml(text);
  const safeQ = escHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(
    new RegExp(`(${safeQ})`, 'gi'),
    '<mark style="background:#fef08a;border-radius:3px;padding:0 2px">$1</mark>'
  );
}

/* ============================================================
   TOAST NOTIFICATIONS
   ============================================================ */
function showToast(msg, type = 'info', duration = 3000) {
  const icons = { success: '✅', warning: '⚠️', error: '❌', info: 'ℹ️' };
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ️'}</span><span class="toast-msg">${escHtml(msg)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('removing');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, duration);
}

/* ============================================================
   REMINDERS
   ============================================================ */
function getReminderDate(task) {
  if (!task.reminder || !task.due) return null;
  const time = task.dueTime || '09:00';
  const [h, m] = time.split(':').map(Number);
  const due = new Date(task.due);
  due.setHours(h, m, 0, 0);
  const fireAt = new Date(due.getTime() - task.reminderOffset * 60000);
  return fireAt > new Date() ? fireAt : null;
}

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function cancelReminder(taskId) {
  if (reminderTimers.has(taskId)) {
    clearTimeout(reminderTimers.get(taskId));
    reminderTimers.delete(taskId);
  }
}

function scheduleReminder(task) {
  cancelReminder(task.id);
  if (task.completed) return;
  const fireAt = getReminderDate(task);
  if (!fireAt) return;
  const timerId = setTimeout(() => {
    const timeStr = task.dueTime ? ` at ${formatTime(task.dueTime)}` : '';
    const body = `"${task.name}" is due${timeStr} on ${formatDate(task.due)}.`;
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('⏰ Taskly Reminder', { body });
    } else {
      showToast(`⏰ Reminder: ${body}`, 'warning', 8000);
    }
    reminderTimers.delete(task.id);
  }, fireAt.getTime() - Date.now());
  reminderTimers.set(task.id, timerId);
}

function rescheduleAllReminders() {
  reminderTimers.forEach((_, id) => cancelReminder(id));
  tasks.forEach(scheduleReminder);
}

/* ============================================================
   STATS & PROGRESS
   ============================================================ */
function updateStats() {
  const total     = tasks.length;
  const completed = tasks.filter(t => t.completed).length;
  const pending   = total - completed;
  const overdue   = tasks.filter(t => isOverdue(t)).length;
  const pct       = total === 0 ? 0 : Math.round((completed / total) * 100);

  document.getElementById('stat-total').textContent     = total;
  document.getElementById('stat-pending').textContent   = pending;
  document.getElementById('stat-completed').textContent = completed;
  document.getElementById('stat-overdue').textContent   = overdue;

  document.getElementById('progress-fill').style.width  = pct + '%';
  document.getElementById('progress-label').textContent = `${pct}% complete`;

  // Filter chip counts
  const fcAll       = document.getElementById('fc-all');
  const fcPending   = document.getElementById('fc-pending');
  const fcCompleted = document.getElementById('fc-completed');
  if (fcAll)       fcAll.textContent       = total     || '';
  if (fcPending)   fcPending.textContent   = pending   || '';
  if (fcCompleted) fcCompleted.textContent = completed || '';
}

/* ============================================================
   FILTERING & SORTING
   ============================================================ */
function getFilteredTasks() {
  let result = [...tasks];

  if (activeFilter === 'completed') {
    result = result.filter(t => t.completed);
  } else if (activeFilter === 'pending') {
    result = result.filter(t => !t.completed);
  }

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    result = result.filter(t =>
      t.name.toLowerCase().includes(q) ||
      t.desc.toLowerCase().includes(q)
    );
  }

  // Sort: overdue first → by due date asc → no-due newest first
  result.sort((a, b) => {
    const aOver = isOverdue(a), bOver = isOverdue(b);
    if (aOver !== bOver) return aOver ? -1 : 1;
    if (a.due && b.due)   return a.due.localeCompare(b.due);
    if (a.due && !b.due)  return -1;
    if (!a.due && b.due)  return 1;
    return b.createdAt - a.createdAt;
  });

  return result;
}

/* ============================================================
   RENDER
   ============================================================ */
function render() {
  updateStats();

  const filtered = getFilteredTasks();
  const list     = document.getElementById('task-list');
  const empty    = document.getElementById('empty-state');

  if (filtered.length === 0) {
    list.innerHTML = '';
    empty.hidden   = false;
    return;
  }

  empty.hidden       = true;
  list.innerHTML     = filtered.map(taskCard).join('');
}

function taskCard(task) {
  const overdue = isOverdue(task);
  const soon    = isDueSoon(task);

  const classes = ['task-item',
    task.completed ? 'completed' : '',
    overdue        ? 'overdue'   : '',
  ].filter(Boolean).join(' ');

  const priorityAttr = (task.priority && task.priority !== 'none')
    ? `data-priority="${escHtml(task.priority)}"` : '';

  // Priority badge
  const pLabels = { low: '🟢 Low', medium: '🟡 Medium', high: '🔴 High' };
  const priorityBadge = (task.priority && task.priority !== 'none')
    ? `<span class="priority-badge ${escHtml(task.priority)}">${pLabels[task.priority]}</span>` : '';

  // Due date + time badge
  let dueBadge = '';
  if (task.due) {
    let cls  = 'due-badge';
    let icon = '📅';
    if (overdue)       { cls += ' overdue-badge'; icon = '⚠️';  }
    else if (soon)     { cls += ' soon-badge';    icon = '🔔';  }
    else               { cls += ' ok-badge';                     }
    const timeStr = task.dueTime ? ` · ${escHtml(formatTime(task.dueTime))}` : '';
    dueBadge = `<span class="${cls}">${icon} ${escHtml(formatDate(task.due))}${timeStr}</span>`;
  }

  // Reminder badge
  const reminderBadge = (task.reminder && task.due)
    ? `<span class="reminder-badge">🔔 Reminder</span>` : '';

  // Status badge
  const statusClass = task.completed ? 'completed' : 'pending';
  const statusLabel = task.completed ? 'Done' : 'Pending';
  const statusBadge = `<span class="status-badge ${statusClass}">${statusLabel}</span>`;

  // Description
  const descHtml = task.desc
    ? `<p class="task-desc">${highlight(task.desc, searchQuery)}</p>` : '';

  return `
    <li class="${classes}" ${priorityAttr} data-id="${escHtml(task.id)}">
      <input
        type="checkbox"
        class="task-checkbox"
        aria-label="Mark '${escHtml(task.name)}' as ${task.completed ? 'pending' : 'done'}"
        ${task.completed ? 'checked' : ''}
        onchange="handleToggle('${escHtml(task.id)}')"
      />
      <div class="task-body">
        <p class="task-name">${highlight(task.name, searchQuery)}</p>
        ${descHtml}
        <div class="task-meta">
          ${dueBadge}${reminderBadge}${priorityBadge}${statusBadge}
        </div>
      </div>
      <div class="task-actions">
        <button class="icon-btn icon-btn-edit"
          title="Edit task"
          aria-label="Edit '${escHtml(task.name)}'"
          onclick="openEditModal('${escHtml(task.id)}')">✏️</button>
        <button class="icon-btn icon-btn-delete"
          title="Delete task"
          aria-label="Delete '${escHtml(task.name)}'"
          onclick="openConfirmDelete('${escHtml(task.id)}')">🗑️</button>
      </div>
    </li>`;
}

/* ============================================================
   TASK OPERATIONS
   ============================================================ */
function addTask(name, desc, due, dueTime, priority, reminder, reminderOffset) {
  const task = sanitiseTask({
    id: generateId(), name, desc, due, dueTime,
    priority, reminder, reminderOffset,
    completed: false, createdAt: Date.now()
  });
  tasks.unshift(task);
  saveTasks();
  scheduleReminder(task);
  render();
  showToast(`"${name}" added!`, 'success');
}

function updateTask(id, name, desc, due, dueTime, priority, reminder, reminderOffset) {
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return;
  tasks[idx] = { ...tasks[idx], name: name.trim(), desc: desc.trim(), due, dueTime, priority, reminder, reminderOffset };
  saveTasks();
  scheduleReminder(tasks[idx]);
  render();
  showToast(`"${name}" updated.`, 'info');
}

function toggleTask(id) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  task.completed = !task.completed;
  saveTasks();
  if (task.completed) {
    cancelReminder(task.id);
    showToast(`"${task.name}" marked done! 🎉`, 'success');
  } else {
    scheduleReminder(task);
    showToast(`"${task.name}" marked pending.`, 'info');
  }
  render();
}

function deleteTask(id) {
  const task = tasks.find(t => t.id === id);
  const name = task ? task.name : 'Task';
  cancelReminder(id);
  tasks = tasks.filter(t => t.id !== id);
  saveTasks();
  render();
  showToast(`"${name}" deleted.`, 'warning');
}

/* ============================================================
   GLOBAL HANDLERS (called from inline onclick in task cards)
   ============================================================ */
window.handleToggle       = id => toggleTask(id);
window.openEditModal      = id => { const t = tasks.find(x => x.id === id); if (t) openModal({ mode: 'edit', task: t }); };
window.openConfirmDelete  = id => { taskToDelete = id; document.getElementById('confirm-overlay').hidden = false; };

/* ============================================================
   MODAL – Add / Edit
   ============================================================ */
function openModal({ mode = 'add', task = null } = {}) {
  const overlay        = document.getElementById('modal-overlay');
  const title          = document.getElementById('modal-title');
  const saveBtn        = document.getElementById('save-btn');
  const idField        = document.getElementById('task-id');
  const nameField      = document.getElementById('task-name');
  const descField      = document.getElementById('task-desc');
  const dueField       = document.getElementById('task-due');
  const timeField      = document.getElementById('task-time');
  const priorityField  = document.getElementById('task-priority');
  const reminderCheck  = document.getElementById('task-reminder');
  const offsetField    = document.getElementById('reminder-offset');

  clearFormErrors();

  if (mode === 'edit' && task) {
    title.textContent         = 'Edit Task';
    saveBtn.textContent       = 'Save Changes';
    idField.value             = task.id;
    nameField.value           = task.name;
    descField.value           = task.desc;
    dueField.value            = task.due;
    timeField.value           = task.dueTime        || '';
    priorityField.value       = task.priority       || 'none';
    reminderCheck.checked     = task.reminder       || false;
    offsetField.value         = task.reminderOffset != null ? task.reminderOffset : 15;
  } else {
    title.textContent         = 'Add Task';
    saveBtn.textContent       = 'Add Task';
    idField.value             = '';
    nameField.value           = '';
    descField.value           = '';
    dueField.value            = '';
    timeField.value           = '';
    priorityField.value       = 'none';
    reminderCheck.checked     = false;
    offsetField.value         = 15;
  }

  updateReminderUI();
  overlay.hidden = false;
  setTimeout(() => nameField.focus(), 60);
}

function closeModal() {
  document.getElementById('modal-overlay').hidden = true;
  clearFormErrors();
}

function clearFormErrors() {
  document.getElementById('task-name').classList.remove('error');
  document.getElementById('name-error').textContent = '';
}

/* ============================================================
   REMINDER UI  (live hint under toggle)
   ============================================================ */
function updateReminderUI() {
  const reminderCheck = document.getElementById('task-reminder');
  const offsetWrap    = document.getElementById('reminder-offset-wrap');
  const toggleText    = document.getElementById('reminder-toggle-text');
  const hintEl        = document.getElementById('reminder-hint');
  const dueField      = document.getElementById('task-due');
  const timeField     = document.getElementById('task-time');
  const offsetField   = document.getElementById('reminder-offset');

  const on   = reminderCheck.checked;
  const due  = dueField.value;
  const time = timeField.value || '09:00';

  toggleText.textContent = on ? 'On' : 'Off';
  offsetWrap.hidden = !on;

  if (on && due) {
    const [h, m]  = time.split(':').map(Number);
    const dueDate = new Date(due);
    dueDate.setHours(h, m, 0, 0);
    const fireAt  = new Date(dueDate.getTime() - (parseInt(offsetField.value, 10) || 0) * 60000);
    hintEl.textContent = fireAt <= new Date()
      ? '⚠️ That time is in the past — reminder won\'t fire.'
      : `🔔 You'll be reminded on ${fireAt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.`;
  } else if (on && !due) {
    hintEl.textContent = 'Set a due date above to enable the reminder.';
  } else {
    hintEl.textContent = '';
  }
}

/* ============================================================
   FORM SUBMISSION
   ============================================================ */
document.getElementById('task-form').addEventListener('submit', function (e) {
  e.preventDefault();

  const nameField      = document.getElementById('task-name');
  const descField      = document.getElementById('task-desc');
  const dueField       = document.getElementById('task-due');
  const timeField      = document.getElementById('task-time');
  const priorityField  = document.getElementById('task-priority');
  const reminderCheck  = document.getElementById('task-reminder');
  const offsetField    = document.getElementById('reminder-offset');
  const idField        = document.getElementById('task-id');

  const name           = nameField.value.trim();
  const desc           = descField.value.trim();
  const due            = dueField.value;
  const dueTime        = timeField.value;
  const priority       = priorityField.value;
  const reminder       = reminderCheck.checked && !!due;  // only valid if due date set
  const reminderOffset = parseInt(offsetField.value, 10) || 15;
  const id             = idField.value;

  if (!name) {
    nameField.classList.add('error');
    document.getElementById('name-error').textContent = 'Task name is required.';
    nameField.focus();
    return;
  }

  if (reminderCheck.checked && !due) {
    showToast('Set a due date to enable reminders.', 'warning');
  }
  if (reminder && 'Notification' in window && Notification.permission === 'denied') {
    showToast("Notification permission denied. Reminders won't fire.", 'warning', 5000);
  }

  if (id) {
    updateTask(id, name, desc, due, dueTime, priority, reminder, reminderOffset);
  } else {
    addTask(name, desc, due, dueTime, priority, reminder, reminderOffset);
  }

  closeModal();
});

/* ============================================================
   CONFIRM DELETE
   ============================================================ */
document.getElementById('confirm-delete').addEventListener('click', () => {
  if (taskToDelete) { deleteTask(taskToDelete); taskToDelete = null; }
  document.getElementById('confirm-overlay').hidden = true;
});

document.getElementById('confirm-cancel').addEventListener('click', () => {
  taskToDelete = null;
  document.getElementById('confirm-overlay').hidden = true;
});

/* ============================================================
   SEARCH
   ============================================================ */
document.getElementById('search-input').addEventListener('input', function () {
  searchQuery = this.value.trim();
  const clearBtn = document.getElementById('search-clear');
  if (clearBtn) clearBtn.hidden = !searchQuery;
  render();
});

const searchClearBtn = document.getElementById('search-clear');
if (searchClearBtn) {
  searchClearBtn.addEventListener('click', () => {
    const input   = document.getElementById('search-input');
    input.value   = '';
    searchQuery   = '';
    searchClearBtn.hidden = true;
    input.focus();
    render();
  });
}

/* ============================================================
   FILTER BUTTONS
   ============================================================ */
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', function () {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    this.classList.add('active');
    activeFilter = this.dataset.filter;
    render();
  });
});

/* ============================================================
   MODAL OPEN / CLOSE WIRING
   ============================================================ */
document.getElementById('open-modal-btn').addEventListener('click', () => openModal({ mode: 'add' }));
document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('cancel-btn').addEventListener('click', closeModal);

document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
document.getElementById('confirm-overlay').addEventListener('click', function (e) {
  if (e.target === this) { taskToDelete = null; this.hidden = true; }
});

/* ============================================================
   REMINDER FIELD LISTENERS
   ============================================================ */
document.getElementById('task-reminder').addEventListener('change', updateReminderUI);
document.getElementById('task-due').addEventListener('change', updateReminderUI);
document.getElementById('task-time').addEventListener('change', updateReminderUI);
document.getElementById('reminder-offset').addEventListener('change', updateReminderUI);

/* ============================================================
   KEYBOARD
   ============================================================ */
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;

  if (!document.getElementById('modal-overlay').hidden) { closeModal(); return; }
  if (!document.getElementById('confirm-overlay').hidden) {
    taskToDelete = null;
    document.getElementById('confirm-overlay').hidden = true;
    return;
  }

  // Escape also clears an active search
  const si = document.getElementById('search-input');
  if (document.activeElement === si && searchQuery) {
    si.value = '';
    searchQuery = '';
    const cb = document.getElementById('search-clear');
    if (cb) cb.hidden = true;
    render();
  }
});

/* ============================================================
   BOOT
   ============================================================ */
(function init() {
  tasks = loadTasks();
  render();
  requestNotificationPermission();
  rescheduleAllReminders();
})();
