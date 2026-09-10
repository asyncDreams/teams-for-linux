'use strict';

/**
 * Settings window renderer. Renders the schema snapshot from
 * configSettingsService (derived from app/config/options.js) and applies
 * changes through validated IPC. DOM is built with createElement/textContent
 * only — no innerHTML — so option descriptions and values can never inject
 * markup.
 */

const api = globalThis.configSettingsApi;

const state = {
  schema: null,
  values: null,
  overrides: {},
  activeGroup: null,
  query: '',
  dirtyPaths: new Set(),
};

const navItems = document.getElementById('nav-items');
const optionsRoot = document.getElementById('options');
const groupTitle = document.getElementById('group-title');
const groupCount = document.getElementById('group-count');
const searchBox = document.getElementById('search');
const emptyNotice = document.getElementById('empty');
const restartHint = document.getElementById('restart-hint');
const restartButton = document.getElementById('restart');

function text(element, value) {
  element.textContent = value;
  return element;
}

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** Formats a value compactly for the "default: …" hint. */
function previewValue(value) {
  if (value === undefined) return 'unset';
  if (typeof value === 'string') return value.length > 40 ? `"${value.slice(0, 40)}…"` : `"${value}"`;
  try {
    const json = JSON.stringify(value);
    return json && json.length > 40 ? `${json.slice(0, 40)}…` : json;
  } catch {
    return String(value);
  }
}

function isOverridden(entry) {
  if (Object.hasOwn(state.overrides, entry.name)) return true;
  return Boolean(entry.fields?.some((field) => {
    const stored = state.overrides[entry.name];
    if (!stored || typeof stored !== 'object') return false;
    const segments = field.path.split('.');
    let cursor = stored;
    for (const segment of segments) {
      if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, segment)) return false;
      cursor = cursor[segment];
    }
    return true;
  }));
}

function setFlash(node, message, kind) {
  node.textContent = message;
  node.className = `msg ${kind}`;
  if (message) {
    window.setTimeout(() => {
      if (node.textContent === message) {
        node.textContent = '';
        node.className = 'msg';
      }
    }, 2600);
  }
}

function handleResult(msgNode, result) {
  if (!result) return;
  if (!result.ok) {
    setFlash(msgNode, result.error || 'Not applied', 'error');
    return;
  }
  state.dirtyPaths.clear();
  setFlash(msgNode, result.applyMode === 'live' ? 'Applied now' : 'Saved — restart to apply', 'ok');
  if (result.applyMode === 'restart') {
    restartHint.textContent = 'Pending restart changes';
  } else if (!document.querySelector('.msg.error')) {
    restartHint.textContent = '';
  }
}

/** Builds the editor row for one scalar entry/field. Returns { row, input }. */
function buildScalarEditor({ label, type, choices, value, onChange }) {
  const row = el('div', 'row');
  let input;
  if (type === 'boolean') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = value === true;
    input.addEventListener('change', () => onChange(input.checked));
    const box = el('label', 'row');
    box.append(input, text(el('span'), 'Enabled'));
    row.append(box);
    return { row, input };
  }
  if (Array.isArray(choices) && choices.length) {
    input = document.createElement('select');
    for (const choice of choices) {
      const option = document.createElement('option');
      option.value = String(choice);
      option.textContent = String(choice);
      input.append(option);
    }
    input.value = value === undefined || value === null ? '' : String(value);
    input.addEventListener('change', () => onChange(input.value));
    row.append(input);
    return { row, input };
  }
  if (type === 'number') {
    input = document.createElement('input');
    input.type = 'number';
    input.value = value === undefined || value === null ? '' : String(value);
    input.addEventListener('change', () => onChange(input.value));
    row.append(input);
    return { row, input };
  }
  input = document.createElement('input');
  input.type = 'text';
  input.value = value === undefined || value === null ? '' : String(value);
  const apply = () => onChange(input.value);
  input.addEventListener('change', apply);
  if (label) row.append(text(el('span', 'desc'), label));
  row.append(input);
  return { row, input };
}

function buildObjectEditor(entry, msgNode) {
  const container = el('div');
  for (const field of entry.fields) {
    const segments = field.path.split('.');
    let cursor = state.values?.[entry.name] ?? {};
    let found = true;
    for (const segment of segments) {
      if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, segment)) {
        found = false;
        break;
      }
      cursor = cursor[segment];
    }
    const currentValue = found ? cursor : field.default;
    const head = el('div', 'opt-head');
    head.append(text(el('code'), field.path));
    container.append(head, text(el('div', 'desc'), field.description || ''));
    const { row } = buildScalarEditor({
      label: '',
      type: field.type,
      choices: field.choices,
      value: currentValue,
      onChange: (raw) => {
        const value = field.type === 'number' ? Number(raw) : raw;
        api.setValue({ name: entry.name, path: field.path, value }).then((result) => {
          handleResult(msgNode, result);
          if (result?.ok) return api.getValues();
        }).then((fresh) => {
          if (fresh) {
            state.values = fresh.values;
            state.overrides = fresh.overrides;
            renderActiveGroup();
          }
        }).catch(() => setFlash(msgNode, 'Failed to apply change', 'error'));
      },
    });
    container.append(row);
  }
  return container;
}

function buildAdvancedEditor(entry, msgNode) {
  const container = el('div');
  const head = el('div', 'opt-head');
  head.append(text(el('code'), entry.name), text(el('span', 'tag custom'), 'advanced'));
  container.append(head, text(el('div', 'desc'), entry.description || ''));
  const area = document.createElement('textarea');
  area.spellcheck = false;
  try {
    area.value = JSON.stringify(state.values?.[entry.name] ?? entry.default, null, 2);
  } catch {
    area.value = '';
  }
  const row = el('div', 'row');
  const apply = el('button', 'action secondary');
  text(apply, 'Apply JSON');
  apply.addEventListener('click', () => {
    let parsed;
    try {
      parsed = JSON.parse(area.value);
    } catch (error) {
      setFlash(msgNode, `Invalid JSON: ${error.message}`, 'error');
      return;
    }
    api.setValue({ name: entry.name, value: parsed }).then((result) => {
      handleResult(msgNode, result);
      if (result?.ok) return api.getValues();
    }).then((fresh) => {
      if (fresh) {
        state.values = fresh.values;
        state.overrides = fresh.overrides;
      }
    }).catch(() => setFlash(msgNode, 'Failed to apply change', 'error'));
  });
  row.append(area, apply);
  container.append(row);
  return container;
}

function buildOptionCard(entry) {
  const card = el('div', 'opt');
  const head = el('div', 'opt-head');
  head.append(text(el('code'), entry.name));
  head.append(text(el('span', 'tag'), entry.applyMode === 'live' ? 'applies now' : 'needs restart'));
  if (isOverridden(entry)) head.append(text(el('span', 'tag custom'), 'customized'));
  card.append(head);
  card.append(text(el('div', 'desc'), `${entry.description || ''} Default: ${previewValue(entry.default)}`));

  const msgNode = el('span', 'msg');
  const actions = el('div', 'row');

  if (entry.advanced) {
    card.append(buildAdvancedEditor(entry, msgNode));
  } else if (entry.type === 'boolean' || entry.type === 'string' || entry.type === 'number') {
    const { row } = buildScalarEditor({
      label: '',
      type: entry.type,
      choices: entry.choices,
      value: state.values?.[entry.name],
      onChange: (raw) => {
        const value = entry.type === 'number' ? Number(raw) : raw;
        api.setValue({ name: entry.name, value }).then((result) => {
          handleResult(msgNode, result);
          if (result?.ok) return api.getValues();
        }).then((fresh) => {
          if (fresh) {
            state.values = fresh.values;
            state.overrides = fresh.overrides;
            renderActiveGroup();
          }
        }).catch(() => setFlash(msgNode, 'Failed to apply change', 'error'));
      },
    });
    actions.append(row);
  } else if (entry.type === 'object' && entry.fields?.length) {
    card.append(buildObjectEditor(entry, msgNode));
  } else {
    card.append(buildAdvancedEditor(entry, msgNode));
  }

  const reset = el('button', 'action secondary');
  text(reset, 'Reset');
  reset.addEventListener('click', () => {
    api.reset({ name: entry.name }).then((result) => {
      handleResult(msgNode, result);
      return api.getValues();
    }).then((fresh) => {
      state.values = fresh.values;
      state.overrides = fresh.overrides;
      renderActiveGroup();
    }).catch(() => setFlash(msgNode, 'Failed to reset', 'error'));
  });
  actions.append(reset, msgNode);
  card.append(actions);
  return card;
}

function matchesQuery(entry) {
  if (!state.query) return true;
  const haystack = `${entry.name} ${entry.description}`.toLowerCase();
  return haystack.includes(state.query);
}

function renderActiveGroup() {
  const entries = state.schema.entries.filter((entry) => {
    if (state.query) return matchesQuery(entry);
    return entry.group === state.activeGroup;
  });
  optionsRoot.replaceChildren();
  emptyNotice.classList.toggle('hidden', entries.length > 0);
  if (state.query) {
    text(groupTitle, `Search: “${state.query}”`);
  } else {
    text(groupTitle, state.activeGroup);
  }
  text(groupCount, `${entries.length} setting${entries.length === 1 ? '' : 's'}`);
  for (const entry of entries) {
    optionsRoot.append(buildOptionCard(entry));
  }
}

function renderNav() {
  navItems.replaceChildren();
  for (const group of state.schema.groups) {
    const count = state.schema.entries.filter((entry) => entry.group === group).length;
    if (!count) continue;
    const button = document.createElement('button');
    text(button, group);
    if (group === state.activeGroup && !state.query) button.classList.add('active');
    button.addEventListener('click', () => {
      state.activeGroup = group;
      state.query = '';
      searchBox.value = '';
      renderNav();
      renderActiveGroup();
    });
    navItems.append(button);
  }
}

async function init() {
  try {
    const [schema, values] = await Promise.all([api.getSchema(), api.getValues()]);
    state.schema = schema;
    state.values = values.values;
    state.overrides = values.overrides;
    state.activeGroup = schema.groups[0] || 'General';
    renderNav();
    renderActiveGroup();
  } catch {
    text(optionsRoot, 'Failed to load configuration schema.');
  }
}

searchBox.addEventListener('input', () => {
  state.query = searchBox.value.trim().toLowerCase();
  renderActiveGroup();
});

document.getElementById('reset-group').addEventListener('click', () => {
  const names = state.schema.entries
    .filter((entry) => entry.group === state.activeGroup)
    .map((entry) => entry.name);
  Promise.all(names.map((name) => api.reset({ name })))
    .then(() => api.getValues())
    .then((fresh) => {
      state.values = fresh.values;
      state.overrides = fresh.overrides;
      renderActiveGroup();
      restartHint.textContent = 'Pending restart changes';
    })
    .catch(() => {});
});

document.getElementById('reset-all').addEventListener('click', () => {
  api.reset({}).then(() => api.getValues()).then((fresh) => {
    state.values = fresh.values;
    state.overrides = fresh.overrides;
    renderActiveGroup();
    restartHint.textContent = 'Pending restart changes';
  }).catch(() => {});
});

restartButton.addEventListener('click', () => api.restart());

init();
