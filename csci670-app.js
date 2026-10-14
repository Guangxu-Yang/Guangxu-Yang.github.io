(() => {
  'use strict';

  const OWNER = 'Guangxu-Yang';
  const REPOSITORY = 'Guangxu-Yang.github.io';
  const BRANCH = 'master';
  const API_ROOT = 'https://api.github.com';
  const REPO_PATH = `/repos/${OWNER}/${REPOSITORY}`;
  const CONTENT_PATH = `${REPO_PATH}/contents/csci670-status.json`;
  const STATE_URL = `https://raw.githubusercontent.com/${OWNER}/${REPOSITORY}/${BRANCH}/csci670-status.json`;
  const FIELDS = ['mode', 'slidesSubmitted', 'reportSubmitted'];
  const MODES = [null, 'In person', 'Video'];
  const byId = id => document.getElementById(id);
  const students = JSON.parse(byId('roster-data').textContent);
  const studentIds = new Set(students.map(student => String(student.order)));
  const body = byId('roster-body');
  const search = byId('name-search');
  const empty = byId('empty-state');
  const count = byId('result-count');
  const status = byId('sync-status');
  const retryButton = byId('retry-button');
  const manageButton = byId('manage-button');
  const signoutButton = byId('signout-button');
  const dialog = byId('admin-dialog');
  const form = byId('admin-form');
  const tokenInput = byId('github-token');
  const connectButton = byId('connect-button');
  const dialogError = byId('dialog-error');

  // The token exists only in this closure and is sent only to GitHub's API.
  let token = null;
  let isAdmin = false;
  let connecting = false;
  let connectionAttempt = 0;
  let publishedState = null;
  let latestState = null;
  let publicLoading = false;
  let publicError = false;
  let saving = false;
  let saveBlocked = false;
  let saveError = '';
  let lastSavedAt = null;
  let saveTimer = null;
  let revision = 0;
  let printing = false;
  const dirty = new Map();

  class RequestError extends Error {
    constructor(message, code = 0) {
      super(message);
      this.code = code;
    }
  }

  const timestamp = state => state && state.updatedAt ? Date.parse(state.updatedAt) : 0;
  const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('en').trim();
  const submissionLabel = value => value === true ? 'Submitted' : value === false ? 'Not submitted' : 'Not marked';
  const formatTime = value => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const isAuthError = error => error instanceof RequestError && (error.code === 401 || error.code === 403);

  function validateState(value) {
    if (!isObject(value) || value.version !== 1 || !isObject(value.students) ||
        !(value.updatedAt === null || (typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt)))) ||
        Object.keys(value.students).length !== students.length) {
      throw new RequestError('The shared status file has an invalid format.');
    }
    const clean = { version: 1, updatedAt: value.updatedAt, students: {} };
    for (const id of studentIds) {
      if (!Object.prototype.hasOwnProperty.call(value.students, id)) {
        throw new RequestError('The shared status file does not match this roster.');
      }
      const entry = value.students[id];
      if (!isObject(entry) || !MODES.includes(entry.mode) ||
          ![null, true, false].includes(entry.slidesSubmitted) ||
          ![null, true, false].includes(entry.reportSubmitted)) {
        throw new RequestError('The shared status file contains an invalid student status.');
      }
      clean.students[id] = {
        mode: entry.mode,
        slidesSubmitted: entry.slidesSubmitted,
        reportSubmitted: entry.reportSubmitted
      };
    }
    return clean;
  }

  async function fetchJson(url, options = {}) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer'
      });
      if (!response.ok) throw new RequestError('The request was not accepted.', response.status);
      try {
        return await response.json();
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        throw new RequestError('The response was not valid JSON.');
      }
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError(error.name === 'AbortError' ? 'The request timed out. Please try again.' : 'The connection failed. Check your connection and try again.');
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function github(path, credential, method = 'GET', payload) {
    const url = new URL(path, API_ROOT);
    if (url.origin !== API_ROOT || !path.startsWith('/')) throw new RequestError('Invalid API destination.');
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${credential}`,
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    return fetchJson(url.href, { method, headers, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  }

  function decodeContent(content) {
    try {
      const bytes = Uint8Array.from(atob(content.replace(/\s/g, '')), character => character.charCodeAt(0));
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (_) {
      throw new RequestError('The shared status file could not be read.');
    }
  }

  function encodeContent(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value, null, 2) + '\n');
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  async function readRepositoryState(credential) {
    const file = await github(`${CONTENT_PATH}?ref=${encodeURIComponent(BRANCH)}`, credential);
    if (!isObject(file) || file.type !== 'file' || file.encoding !== 'base64' ||
        typeof file.sha !== 'string' || typeof file.content !== 'string') {
      throw new RequestError('The shared status file could not be read.');
    }
    return { state: validateState(decodeContent(file.content)), sha: file.sha };
  }

  function acceptLatest(next) {
    if (!latestState || timestamp(next) >= timestamp(latestState)) latestState = next;
  }

  function syncStatus() {
    manageButton.hidden = isAdmin;
    signoutButton.hidden = !isAdmin;
    manageButton.disabled = connecting;
    retryButton.hidden = true;
    status.dataset.state = 'ready';
    if (connecting) {
      status.textContent = 'Connecting to GitHub…';
    } else if (isAdmin && saving) {
      status.dataset.state = 'saving';
      status.textContent = 'Saving changes to GitHub… Keep this page open.';
    } else if (dirty.size) {
      status.dataset.state = saveBlocked || !isAdmin ? 'error' : 'pending';
      if (!isAdmin) {
        status.textContent = 'Editing is locked. Unsaved changes are still in this tab. Reconnect as Guangxu-Yang to save them. ' + saveError;
        retryButton.hidden = false;
        retryButton.textContent = 'Reconnect GitHub';
      } else if (saveBlocked) {
        status.textContent = 'Changes are not saved. ' + saveError + ' Choose Retry save.';
        retryButton.hidden = false;
        retryButton.textContent = 'Retry save';
      } else {
        status.textContent = 'Unsaved changes — saving automatically… Keep this page open.';
      }
    } else if (isAdmin) {
      status.textContent = lastSavedAt
        ? `Saved to GitHub at ${formatTime(lastSavedAt)}. Student pages check the shared status file every 30 seconds.`
        : 'Owner editing enabled. Changes save automatically to the shared status file.';
    } else if (publicError) {
      status.dataset.state = 'error';
      status.textContent = publishedState
        ? 'Could not refresh shared status. Showing the last loaded data' + (publishedState.updatedAt ? ` from ${formatTime(publishedState.updatedAt)}.` : '.')
        : 'Shared status could not be loaded. Submission status is unavailable. Please retry.';
      retryButton.hidden = false;
      retryButton.textContent = 'Retry loading';
    } else if (!publishedState) {
      status.textContent = 'Loading shared status…';
    } else {
      status.textContent = (publishedState.updatedAt
        ? `Shared status updated ${formatTime(publishedState.updatedAt)}.`
        : 'Shared status loaded. No updates have been recorded yet.') + ' Refreshes automatically every 30 seconds.';
    }
  }

  function statusFor(student) {
    const id = String(student.order);
    const state = isAdmin || dirty.size ? latestState : publishedState;
    if (!state) return null;
    const values = { ...state.students[id] };
    if (isAdmin || dirty.size) {
      for (const [field, change] of Object.entries(dirty.get(id) || {})) values[field] = change.value;
    }
    return values;
  }

  function appendText(row, value, className) {
    const cell = document.createElement('td');
    cell.textContent = value;
    if (className) cell.className = className;
    row.append(cell);
    return cell;
  }

  function modeCell(row, student, value) {
    const cell = document.createElement('td');
    const select = document.createElement('select');
    select.id = `mode-${student.order}`;
    select.className = 'status-control mode-select';
    select.setAttribute('aria-label', `Presentation mode for ${student.firstName} ${student.lastName}`);
    for (const mode of MODES) {
      const option = document.createElement('option');
      option.value = mode || '';
      option.textContent = mode || 'Not set';
      select.append(option);
    }
    select.value = value || '';
    select.addEventListener('change', () => recordChange(student.order, 'mode', select.value || null));
    cell.append(select);
    row.append(cell);
  }

  function submissionCell(row, student, field, value) {
    const cell = document.createElement('td');
    const wrapper = document.createElement('div');
    wrapper.className = 'submission-control';
    const label = document.createElement('label');
    label.className = 'submission-label';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `${field}-${student.order}`;
    checkbox.checked = value === true;
    checkbox.indeterminate = value === null;
    checkbox.setAttribute('aria-label', `${field === 'slidesSubmitted' ? 'Slides' : 'Report'} submitted for ${student.firstName} ${student.lastName}`);
    checkbox.setAttribute('aria-checked', value === null ? 'mixed' : String(value));
    checkbox.addEventListener('change', () => recordChange(student.order, field, checkbox.checked));
    const text = document.createElement('span');
    text.textContent = submissionLabel(value);
    label.append(checkbox, text);
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.id = `reset-${field}-${student.order}`;
    reset.className = 'status-reset';
    reset.textContent = 'Reset';
    reset.disabled = value === null;
    reset.setAttribute('aria-label', `Reset ${field === 'slidesSubmitted' ? 'slides' : 'report'} status to not marked for ${student.firstName} ${student.lastName}`);
    reset.addEventListener('click', () => recordChange(student.order, field, null));
    wrapper.append(label, reset);
    cell.append(wrapper);
    row.append(cell);
  }

  function render() {
    const activeId = document.activeElement && document.activeElement.id;
    const terms = printing ? [] : normalize(search.value).split(/\s+/).filter(Boolean);
    const visible = students.filter(student => terms.every(term => normalize(`${student.firstName} ${student.lastName} ${student.lastName}, ${student.firstName}`).includes(term)));
    const fragment = document.createDocumentFragment();
    for (const student of visible) {
      const row = document.createElement('tr');
      if (dirty.has(String(student.order))) row.className = 'pending-row';
      appendText(row, student.order);
      appendText(row, student.lastName);
      appendText(row, student.firstName);
      const values = statusFor(student);
      if (values && isAdmin && !printing) {
        modeCell(row, student, values.mode);
        submissionCell(row, student, 'slidesSubmitted', values.slidesSubmitted);
        submissionCell(row, student, 'reportSubmitted', values.reportSubmitted);
      } else {
        appendText(row, values ? values.mode || 'Not set' : 'Unavailable', 'status-label');
        appendText(row, values ? submissionLabel(values.slidesSubmitted) : 'Unavailable', 'status-label');
        appendText(row, values ? submissionLabel(values.reportSubmitted) : 'Unavailable', 'status-label');
      }
      fragment.append(row);
    }
    body.replaceChildren(fragment);
    count.textContent = terms.length ? `${visible.length} of ${students.length} students` : `${students.length} students`;
    empty.hidden = visible.length !== 0;
    if (!printing && activeId && body.contains(byId(activeId))) byId(activeId).focus({ preventScroll: true });
  }

  async function refreshPublished() {
    if (document.hidden || publicLoading) return;
    publicLoading = true;
    try {
      const url = new URL(STATE_URL);
      url.searchParams.set('v', String(Math.floor(Date.now() / 30000)));
      const next = validateState(await fetchJson(url.href));
      if (!publishedState || timestamp(next) >= timestamp(publishedState)) publishedState = next;
      acceptLatest(next);
      publicError = false;
      render();
    } catch (_) {
      publicError = true;
    } finally {
      publicLoading = false;
      syncStatus();
    }
  }

  function recordChange(order, field, value) {
    if (!isAdmin || !token || !latestState || !FIELDS.includes(field)) return;
    const id = String(order);
    if (!studentIds.has(id) || (field === 'mode' ? !MODES.includes(value) : ![null, true, false].includes(value))) return;
    const changes = dirty.get(id) || {};
    changes[field] = { value, revision: ++revision };
    dirty.set(id, changes);
    render();
    syncStatus();
    window.clearTimeout(saveTimer);
    if (!saveBlocked) saveTimer = window.setTimeout(savePending, 1000);
  }

  function takeSnapshot() {
    return Array.from(dirty, ([id, fields]) => [id, Object.fromEntries(Object.entries(fields).map(([field, change]) => [field, { ...change }]))]);
  }

  async function commitSnapshot(snapshot, credential) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await readRepositoryState(credential);
      const next = validateState(current.state);
      let changed = false;
      for (const [id, fields] of snapshot) {
        for (const [field, change] of Object.entries(fields)) {
          if (next.students[id][field] !== change.value) changed = true;
          next.students[id][field] = change.value;
        }
      }
      // A timed-out PUT might have succeeded. A read confirming every field is enough.
      if (!changed) return current.state;
      next.updatedAt = new Date(Math.max(Date.now(), timestamp(current.state) + 1)).toISOString();
      try {
        const result = await github(CONTENT_PATH, credential, 'PUT', {
          message: 'Update CSCI 670 presentation status',
          content: encodeContent(next),
          sha: current.sha,
          branch: BRANCH
        });
        if (!isObject(result) || !isObject(result.content) || typeof result.content.sha !== 'string') {
          throw new RequestError('GitHub did not confirm the save. Retry to check and save your changes.');
        }
        return next;
      } catch (error) {
        if (error.code === 409 && attempt < 2) continue;
        throw error;
      }
    }
    throw new RequestError('The status file changed during saving. Please retry.');
  }

  function describeSaveError(error) {
    if (isAuthError(error)) return 'GitHub authorization expired or no longer allows this update.';
    if (error.code === 409) return 'Another update changed the status file. Please retry.';
    if (error.code === 404) return 'GitHub could not find the status file or your token cannot access it.';
    if (error.code === 422) return 'GitHub rejected the update. Check repository write permissions and branch rules.';
    if (error.code === 429) return 'GitHub is temporarily limiting requests. Wait briefly, then retry.';
    return error instanceof RequestError ? error.message : 'The update could not be saved. Please retry.';
  }

  async function savePending() {
    window.clearTimeout(saveTimer);
    if (saving || !isAdmin || !token || !dirty.size || saveBlocked) return;
    saving = true;
    syncStatus();
    try {
      while (dirty.size && isAdmin && token && !saveBlocked) {
        const snapshot = takeSnapshot();
        const saved = await commitSnapshot(snapshot, token);
        acceptLatest(saved);
        lastSavedAt = saved.updatedAt || new Date().toISOString();
        for (const [id, fields] of snapshot) {
          const pending = dirty.get(id);
          if (!pending) continue;
          for (const [field, change] of Object.entries(fields)) {
            if (pending[field] && pending[field].revision === change.revision) delete pending[field];
          }
          if (Object.keys(pending).length === 0) dirty.delete(id);
        }
        saveError = '';
        render();
      }
    } catch (error) {
      saveBlocked = true;
      saveError = describeSaveError(error);
      if (isAuthError(error)) {
        token = null;
        isAdmin = false;
      }
      render();
    } finally {
      saving = false;
      syncStatus();
    }
  }

  function openAdminDialog() {
    if (isAdmin || connecting) return;
    dialogError.textContent = '';
    tokenInput.value = '';
    dialog.showModal();
    tokenInput.focus();
  }

  function cancelConnection() {
    connectionAttempt++;
    connecting = false;
    tokenInput.value = '';
    connectButton.disabled = false;
    dialog.close();
    syncStatus();
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (connecting) return;
    let candidate = tokenInput.value.trim();
    tokenInput.value = '';
    if (!/^github_pat_[A-Za-z0-9_]+$/.test(candidate)) {
      candidate = null;
      dialogError.textContent = 'Enter a fine-grained personal access token beginning with github_pat_.';
      return;
    }
    const attempt = ++connectionAttempt;
    connecting = true;
    connectButton.disabled = true;
    dialogError.textContent = '';
    syncStatus();
    try {
      const account = await github('/user', candidate);
      if (attempt !== connectionAttempt) return;
      if (!account || typeof account.login !== 'string' || account.login.toLowerCase() !== OWNER.toLowerCase()) {
        throw new RequestError('Only the Guangxu-Yang account can edit this roster.');
      }
      const repository = await github(REPO_PATH, candidate);
      if (attempt !== connectionAttempt) return;
      if (!repository || !repository.permissions || repository.permissions.push !== true) {
        throw new RequestError('This token does not have write access to the website repository.');
      }
      const current = await readRepositoryState(candidate);
      if (attempt !== connectionAttempt) return;
      acceptLatest(current.state);
      token = candidate;
      isAdmin = true;
      saveBlocked = false;
      saveError = '';
      dialog.close();
      render();
    } catch (error) {
      if (attempt !== connectionAttempt) return;
      dialogError.textContent = isAuthError(error)
        ? 'GitHub could not authorize this token. Check its expiration, repository selection, and Contents read/write permission.'
        : describeSaveError(error);
    } finally {
      candidate = null;
      if (attempt === connectionAttempt) {
        connecting = false;
        connectButton.disabled = false;
        syncStatus();
        if (isAdmin && dirty.size) savePending();
      }
    }
  });

  manageButton.addEventListener('click', openAdminDialog);
  byId('cancel-admin').addEventListener('click', cancelConnection);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    cancelConnection();
  });
  dialog.addEventListener('close', () => { tokenInput.value = ''; });
  signoutButton.addEventListener('click', () => {
    if (dirty.size || saving) {
      status.dataset.state = 'error';
      status.textContent = 'Cannot sign out while changes are unsaved. Keep this tab open until saving finishes, or choose Retry save.';
      return;
    }
    token = null;
    isAdmin = false;
    lastSavedAt = null;
    saveError = '';
    saveBlocked = false;
    render();
    syncStatus();
    refreshPublished();
  });
  retryButton.addEventListener('click', () => {
    if (dirty.size && !isAdmin) {
      openAdminDialog();
    } else if (dirty.size && isAdmin) {
      saveBlocked = false;
      saveError = '';
      savePending();
    } else {
      refreshPublished();
    }
  });
  byId('refresh-button').addEventListener('click', refreshPublished);
  search.addEventListener('input', render);
  byId('print-button').addEventListener('click', () => window.print());
  window.addEventListener('beforeprint', () => { printing = true; render(); });
  window.addEventListener('afterprint', () => { printing = false; render(); });
  window.addEventListener('beforeunload', event => {
    if (dirty.size || saving) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  window.addEventListener('pagehide', () => {
    token = null;
    isAdmin = false;
    connectionAttempt++;
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) {
      connecting = false;
      connectButton.disabled = false;
      if (dialog.open) dialog.close();
      render();
      syncStatus();
      refreshPublished();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshPublished();
  });
  window.setInterval(() => { if (!document.hidden) refreshPublished(); }, 30000);
  render();
  syncStatus();
  refreshPublished();
})();
