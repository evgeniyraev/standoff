// Settings UI shared by the kiosk's settings window and the admin page.
// It only talks to a transport object, so the same UI works over Electron IPC
// (settings window) and over WebRTC (admin page):
//
//   api = {
//     getConfig(): Promise<config>        setConfig(patch): Promise<config>
//     onConfig(cb): unsubscribe           getStatus(): Promise<status>
//     onStatus(cb): unsubscribe           command(name, args?): Promise
//     local: boolean                      // true inside the kiosk
//   }

import './settings.css';
import defaultLogo from '../../assets/logo-white.png';
import { BRAND_COLORS, CORNERS, accentFor } from '../defaults.js';
import { LETTERS, makeId } from '../questions.js';
import { parseQuestionFile, questionsToXlsxBlob } from '../excel.js';

const TABS = [
  ['questions', 'Questions'],
  ['game', 'Game'],
  ['theme', 'Theme'],
  ['kiosk', 'Kiosk'],
  ['system', 'System'],
];

const COLOR_LABELS = {
  navy: 'Flutter Navy',
  blue: 'Flutter Blue',
  sky: 'Sky Blue',
  darkNavy: 'Dark Navy',
  green: 'Flutter Green',
  red: 'Flutter Red',
  yellow: 'Flutter Yellow',
  purple: 'Flutter Purple',
};

// ---- tiny DOM helper ------------------------------------------------------------

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') for (const [p, sv] of Object.entries(v)) el.style.setProperty(p, sv);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Builds { a: { b: value } } from 'a.b'.
const patchAt = (path, value) =>
  path
    .split('.')
    .reverse()
    .reduce((acc, key) => ({ [key]: acc }), value);
const getAt = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);

// ---- mount ----------------------------------------------------------------------

export async function mountSettings(root, api, { title = 'Settings' } = {}) {
  let config = await api.getConfig();
  let status = await api.getStatus();
  let tab = 'questions';
  let toastTimer = null;

  root.classList.add('sx');
  const toast = h('div', { class: 'sx-toast', role: 'status' });
  const statusBar = h('div', { class: 'sx-statusbar' });
  const nav = h('nav', { class: 'sx-tabs' });
  const body = h('div', { class: 'sx-body' });
  root.replaceChildren(
    h(
      'header',
      { class: 'sx-header' },
      h('h1', {}, title),
      api.local
        ? h('button', { class: 'sx-btn sx-close', onClick: () => api.command('settings:close') }, 'Close ✕')
        : null,
    ),
    statusBar,
    nav,
    body,
    toast,
  );

  function notify(message, kind = 'ok') {
    toast.textContent = message;
    toast.dataset.kind = kind;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
  }

  async function save(patch, message = 'Saved') {
    try {
      config = await api.setConfig(patch);
      notify(message);
    } catch (err) {
      notify(`Save failed: ${err.message}`, 'error');
    }
  }

  async function run(name, okMessage) {
    try {
      await api.command(name);
      if (okMessage) notify(okMessage);
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  // ---- fields -------------------------------------------------------------------

  function numberField(path, label, { min, max, suffix, help } = {}) {
    return h(
      'label',
      { class: 'sx-field' },
      h('span', { class: 'sx-label' }, label),
      h(
        'span',
        { class: 'sx-input-row' },
        h('input', {
          type: 'number',
          inputMode: 'numeric',
          min,
          max,
          value: getAt(config, path),
          onChange: (e) => save(patchAt(path, Number(e.target.value))),
        }),
        suffix ? h('span', { class: 'sx-suffix' }, suffix) : null,
      ),
      help ? h('small', {}, help) : null,
    );
  }

  function toggleField(path, label, help) {
    return h(
      'label',
      { class: 'sx-field sx-toggle' },
      h('input', { type: 'checkbox', checked: Boolean(getAt(config, path)), onChange: (e) => save(patchAt(path, e.target.checked)) }),
      h('span', { class: 'sx-label' }, label),
      help ? h('small', {}, help) : null,
    );
  }

  function textField(path, label, { placeholder, help, type = 'text' } = {}) {
    return h(
      'label',
      { class: 'sx-field' },
      h('span', { class: 'sx-label' }, label),
      h('input', { type, value: getAt(config, path) ?? '', placeholder, onChange: (e) => save(patchAt(path, e.target.value.trim())) }),
      help ? h('small', {}, help) : null,
    );
  }

  const card = (heading, ...children) => h('section', { class: 'sx-card' }, heading ? h('h2', {}, heading) : null, ...children);

  // ---- tabs -----------------------------------------------------------------------

  function renderQuestions() {
    const questions = config.questions;
    const commit = (next, message) => save({ questions: next }, message);
    const update = (id, fn) => commit(questions.map((q) => (q.id === id ? fn(structuredClone(q)) : q)));

    const fileInput = h('input', {
      type: 'file',
      accept: '.xlsx,.xls,.csv,.ods',
      hidden: true,
      onChange: (e) => e.target.files[0] && importFile(e.target.files[0]),
    });

    async function importFile(file) {
      try {
        const { questions: parsed, errors } = await parseQuestionFile(file);
        if (!parsed.length) return notify(errors[0] ?? 'No questions found in the file', 'error');
        showImportChoice(parsed, errors);
      } catch (err) {
        notify(`Could not read ${file.name}: ${err.message}`, 'error');
      }
    }

    function showImportChoice(parsed, errors) {
      const dialog = h(
        'div',
        { class: 'sx-dialog' },
        h(
          'div',
          { class: 'sx-dialog-box' },
          h('h2', {}, `Import ${parsed.length} question${parsed.length === 1 ? '' : 's'}`),
          errors.length ? h('ul', { class: 'sx-errors' }, errors.slice(0, 8).map((e) => h('li', {}, e))) : null,
          errors.length > 8 ? h('p', {}, `…and ${errors.length - 8} more skipped rows`) : null,
          h(
            'div',
            { class: 'sx-actions' },
            h('button', { class: 'sx-btn primary', onClick: () => (dialog.remove(), commit(parsed, 'Questions replaced')) }, 'Replace all'),
            h('button', { class: 'sx-btn', onClick: () => (dialog.remove(), commit([...questions, ...parsed], 'Questions added')) }, 'Add to existing'),
            h('button', { class: 'sx-btn ghost', onClick: () => dialog.remove() }, 'Cancel'),
          ),
        ),
      );
      root.append(dialog);
    }

    const drop = h(
      'div',
      {
        class: 'sx-drop',
        onClick: () => fileInput.click(),
        onDragover: (e) => (e.preventDefault(), drop.classList.add('over')),
        onDragleave: () => drop.classList.remove('over'),
        onDrop: (e) => {
          e.preventDefault();
          drop.classList.remove('over');
          const file = e.dataTransfer.files[0];
          if (file) importFile(file);
        },
      },
      h('strong', {}, 'Drop an Excel file here'),
      h('span', {}, 'or tap to choose · columns: Question | A | B | C | D | Correct (A–D)'),
      fileInput,
    );

    const exportBtn = h(
      'button',
      {
        class: 'sx-btn',
        onClick: () => {
          const url = URL.createObjectURL(questionsToXlsxBlob(questions));
          h('a', { href: url, download: 'standoff-questions.xlsx' }).click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        },
      },
      'Export .xlsx',
    );

    const list = questions.map((q, n) =>
      h(
        'article',
        { class: 'sx-question', style: { '--accent': accentFor(config, n + 1) } },
        h(
          'div',
          { class: 'sx-q-head' },
          h('span', { class: 'sx-q-num' }, String(n + 1).padStart(2, '0')),
          h('textarea', {
            rows: 2,
            value: q.text,
            placeholder: 'Question',
            onChange: (e) => e.target.value.trim() && update(q.id, (x) => ((x.text = e.target.value.trim()), x)),
          }),
          h(
            'button',
            {
              class: 'sx-btn ghost danger',
              title: 'Delete question',
              onClick: () => confirm(`Delete question ${n + 1}?`) && commit(questions.filter((x) => x.id !== q.id), 'Question deleted'),
            },
            'Delete',
          ),
        ),
        h(
          'div',
          { class: 'sx-q-answers' },
          q.answers.map((a, i) =>
            h(
              'label',
              { class: `sx-q-answer${q.correct === i ? ' correct' : ''}` },
              h('input', {
                type: 'radio',
                name: `correct-${q.id}`,
                checked: q.correct === i,
                title: 'Correct answer',
                onChange: () => update(q.id, (x) => ((x.correct = i), x)),
              }),
              h('b', {}, LETTERS[i]),
              h('input', {
                type: 'text',
                value: a,
                onChange: (e) => e.target.value.trim() && update(q.id, (x) => ((x.answers[i] = e.target.value.trim()), x)),
              }),
            ),
          ),
        ),
      ),
    );

    const addForm = (() => {
      const text = h('textarea', { rows: 2, placeholder: 'New question' });
      const answers = LETTERS.map((l) => h('input', { type: 'text', placeholder: `Answer ${l}` }));
      const correct = h('select', {}, LETTERS.map((l, i) => h('option', { value: i }, `Correct: ${l}`)));
      return card(
        'Add a question',
        text,
        h('div', { class: 'sx-grid2' }, answers),
        h(
          'div',
          { class: 'sx-actions' },
          correct,
          h(
            'button',
            {
              class: 'sx-btn primary',
              onClick: () => {
                const q = { id: makeId(), text: text.value.trim(), answers: answers.map((a) => a.value.trim()), correct: Number(correct.value) };
                if (!q.text || q.answers.some((a) => !a)) return notify('Fill in the question and all four answers', 'error');
                commit([...questions, q], 'Question added');
              },
            },
            'Add question',
          ),
        ),
      );
    })();

    return [
      card(`Questions (${questions.length})`, h('p', { class: 'sx-muted' }, 'Drawn at random; colours follow the question order in the game.'), drop, h('div', { class: 'sx-actions' }, exportBtn)),
      questions.length < 2 ? h('p', { class: 'sx-warn' }, 'Add at least a few questions — the game reshuffles when it runs out.') : null,
      ...list,
      addForm,
    ];
  }

  function renderGame() {
    return [
      card(
        'Rules',
        h(
          'div',
          { class: 'sx-grid2' },
          numberField('game.pointsToWin', 'Points to win', { min: 1, max: 20 }),
          numberField('game.displayTotal', 'Show “OF NN” up to question', { min: 0, max: 99, help: 'After this number the “OF 05” label is hidden.' }),
        ),
        toggleField('game.stealOnWrong', 'Other player gets a chance after a wrong answer'),
      ),
      card(
        'Timers',
        h(
          'div',
          { class: 'sx-grid2' },
          numberField('game.buzzSeconds', 'Time to press a buzzer', { min: 3, max: 120, suffix: 's' }),
          numberField('game.answerSeconds', 'Time to answer', { min: 3, max: 120, suffix: 's' }),
          numberField('game.resultSeconds', 'Result screen', { min: 1, max: 60, suffix: 's' }),
          numberField('game.handoverSeconds', 'Hand-over to other player', { min: 1, max: 30, suffix: 's' }),
          numberField('game.countdownSeconds', 'Get-ready countdown', { min: 0, max: 10, suffix: 's' }),
        ),
      ),
    ];
  }

  function renderTheme() {
    const logoInput = h('input', {
      type: 'file',
      accept: 'image/png,image/svg+xml,image/jpeg,image/webp',
      hidden: true,
      onChange: async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          save({ theme: { logo: await imageToDataUrl(file) } }, 'Logo updated');
        } catch (err) {
          notify(err.message, 'error');
        }
      },
    });
    const colors = config.theme.colors;
    return [
      card(
        'Logo (top-left)',
        h('div', { class: 'sx-logo-preview' }, h('img', { src: config.theme.logo ?? defaultLogo, alt: 'Logo' })),
        h(
          'div',
          { class: 'sx-actions' },
          h('button', { class: 'sx-btn primary', onClick: () => logoInput.click() }, 'Upload logo…'),
          config.theme.logo ? h('button', { class: 'sx-btn ghost', onClick: () => save({ theme: { logo: null } }, 'Logo reset') }, 'Use default') : null,
          logoInput,
        ),
        h('small', { class: 'sx-muted' }, 'White/transparent PNG or SVG works best. Large images are scaled down to 1000 px.'),
      ),
      card(
        'Colours',
        h(
          'div',
          { class: 'sx-colors' },
          Object.keys(BRAND_COLORS).map((key) =>
            h(
              'label',
              { class: 'sx-color' },
              h('input', { type: 'color', value: colors[key], onChange: (e) => save({ theme: { colors: { [key]: e.target.value.toUpperCase() } } }) }),
              h('span', {}, COLOR_LABELS[key], h('small', {}, colors[key])),
            ),
          ),
        ),
        h('div', { class: 'sx-actions' }, h('button', { class: 'sx-btn ghost', onClick: () => save({ theme: { colors: { ...BRAND_COLORS } } }, 'Colours reset') }, 'Reset to brand colours')),
      ),
      card(
        'Question colour order',
        h('p', { class: 'sx-muted' }, 'Question 1 uses the first colour, question 2 the second… and then it repeats.'),
        h(
          'div',
          { class: 'sx-order' },
          config.theme.accentOrder.map((name, i) =>
            h(
              'span',
              { class: 'sx-order-item', style: { '--c': colors[name] } },
              h('i', {}),
              h(
                'select',
                {
                  onChange: (e) => {
                    const next = [...config.theme.accentOrder];
                    next[i] = e.target.value;
                    save({ theme: { accentOrder: next } });
                  },
                },
                Object.keys(BRAND_COLORS).map((c) => h('option', { value: c, selected: c === name }, COLOR_LABELS[c])),
              ),
              config.theme.accentOrder.length > 1
                ? h('button', { class: 'sx-btn ghost small', title: 'Remove', onClick: () => save({ theme: { accentOrder: config.theme.accentOrder.filter((_, j) => j !== i) } }) }, '✕')
                : null,
            ),
          ),
          h('button', { class: 'sx-btn small', onClick: () => save({ theme: { accentOrder: [...config.theme.accentOrder, 'blue'] } }) }, '+ Add'),
        ),
      ),
    ];
  }

  function renderKiosk() {
    const corners = h(
      'div',
      { class: 'sx-corners' },
      CORNERS.map((c) =>
        h('button', { class: `sx-corner ${c}${config.kiosk.hiddenCorner === c ? ' active' : ''}`, onClick: () => save({ kiosk: { hiddenCorner: c } }, 'Hidden button moved') }, c.replace('-', ' ')),
      ),
    );
    return [
      card(
        'Idle fallback',
        numberField('kiosk.idleTimeoutSeconds', 'Return to start screen after no activity for', { min: 5, max: 3600, suffix: 's', help: 'Any touch or buzzer press counts as activity. Not active on the start screen.' }),
      ),
      card(
        'Hidden operator button',
        h('p', { class: 'sx-muted' }, 'Invisible square in a screen corner. Double tap → back to start. Hold → open settings. Ctrl/Cmd + , also opens settings.'),
        corners,
        h(
          'div',
          { class: 'sx-grid2' },
          numberField('kiosk.hiddenSize', 'Size', { min: 40, max: 400, suffix: 'px' }),
          numberField('kiosk.holdSeconds', 'Hold to open settings', { min: 2, max: 60, suffix: 's' }),
          numberField('kiosk.doubleTapMs', 'Double tap window', { min: 150, max: 1500, suffix: 'ms' }),
        ),
      ),
    ];
  }

  function renderSystem() {
    const u = status.update ?? {};
    const b = status.ble ?? {};
    const r = status.remote ?? {};
    const updateText = {
      disabled: 'Disabled in development builds',
      idle: 'Waiting for first check',
      checking: 'Checking…',
      'up-to-date': 'Up to date',
      downloading: `Downloading ${u.version ?? ''} ${u.progress ?? 0}%`,
      downloaded: `Version ${u.version} ready — installs automatically on the start screen`,
      installing: 'Installing…',
      error: `Error: ${u.error}`,
    }[u.state] ?? u.state;
    return [
      card(
        'App',
        h('dl', { class: 'sx-dl' }, h('dt', {}, 'Version'), h('dd', {}, `${status.app?.version ?? '?'} (${status.app?.commit ?? 'dev'})`), h('dt', {}, 'Computer'), h('dd', {}, status.app?.hostname ?? '?'), h('dt', {}, 'Update'), h('dd', {}, updateText)),
        h(
          'div',
          { class: 'sx-actions' },
          h('button', { class: 'sx-btn', onClick: () => run('update:check', 'Checking for updates…') }, 'Check for updates'),
          h('button', { class: 'sx-btn primary', onClick: () => run('update:install', 'Update will install as soon as it is downloaded') }, 'Install update now'),
          h('button', { class: 'sx-btn', onClick: () => run('game:reset', 'Game reset') }, 'Back to start screen'),
          h('button', { class: 'sx-btn', onClick: () => confirm('Restart the app?') && run('app:restart') }, 'Restart app'),
          api.local ? h('button', { class: 'sx-btn danger', onClick: () => confirm('Quit the kiosk app?') && run('app:quit') }, 'Quit app') : null,
        ),
      ),
      card(
        'Buzzers (Bluetooth)',
        h('dl', { class: 'sx-dl' }, h('dt', {}, 'State'), h('dd', {}, `${b.state ?? '?'}${b.device ? ` · ${b.device}` : ''}`), b.error ? [h('dt', {}, 'Last error'), h('dd', {}, b.error)] : null, b.lastButton ? [h('dt', {}, 'Last press'), h('dd', {}, `Player ${b.lastButton.player} · #${b.lastButton.seq}`)] : null),
        toggleField('ble.enabled', 'Use Bluetooth buzzers'),
        toggleField('ble.keyboardFallback', 'Keyboard fallback (keys 1 and 2)'),
        toggleField('ble.autoReconnect', 'Reconnect automatically', 'Off: after a drop or failed attempt the app stops and waits for "Reconnect buzzers".'),
        h('div', { class: 'sx-actions' }, h('button', { class: 'sx-btn', onClick: () => run('ble:reconnect', 'Reconnecting buzzers…') }, 'Reconnect buzzers')),
        h('small', { class: 'sx-muted' }, 'If it connects then drops immediately: forget the device in Windows Bluetooth settings and hold both buzzers for 3 s while powering on.'),
        h('h3', { class: 'sx-subhead' }, 'Connection log'),
        bleLog(b.log),
      ),
      card(
        'Admin link (WebRTC)',
        h('dl', { class: 'sx-dl' }, h('dt', {}, 'State'), h('dd', {}, `${r.state ?? '?'}${r.admins ? ` · ${r.admins} admin(s) connected` : ''}`), r.room ? [h('dt', {}, 'Room'), h('dd', { class: 'sx-mono' }, r.room)] : null, r.error ? [h('dt', {}, 'Error'), h('dd', {}, r.error)] : null),
        toggleField('remote.enabled', 'Allow remote admin'),
        h(
          'div',
          { class: 'sx-grid2' },
          textField('remote.roomOverride', 'Room override', { placeholder: 'Built-in room', help: 'Leave empty to use the room from the build.' }),
          textField('remote.pinOverride', 'PIN override', { placeholder: 'Built-in PIN', type: 'password' }),
        ),
        h('div', { class: 'sx-actions' }, h('button', { class: 'sx-btn', onClick: () => run('remote:reconnect', 'Rejoining room…') }, 'Rejoin room')),
      ),
    ];
  }

  // Newest first so the latest event is visible without scrolling.
  function bleLog(entries = []) {
    const time = (t) => new Date(t).toLocaleTimeString([], { hour12: false });
    return h(
      'div',
      { class: 'sx-log sx-mono' },
      entries.length
        ? [...entries].reverse().map((e) => h('div', { class: `sx-log-line ${e.level}` }, h('span', { class: 'sx-log-time' }, time(e.t)), e.msg))
        : h('div', { class: 'sx-muted' }, 'No events yet'),
    );
  }

  const RENDERERS = { questions: renderQuestions, game: renderGame, theme: renderTheme, kiosk: renderKiosk, system: renderSystem };

  function renderStatusBar() {
    const g = status.game ?? {};
    const pill = (label, value, state) => h('span', { class: 'sx-pill', 'data-state': state }, h('b', {}, label), value);
    statusBar.replaceChildren(
      pill('Screen', g.screen ?? '?', 'info'),
      pill('Score', `${g.scores?.[0] ?? 0} : ${g.scores?.[1] ?? 0}`, 'info'),
      pill('Buzzers', status.ble?.state ?? '?', status.ble?.state === 'connected' ? 'ok' : 'warn'),
      pill('Update', status.update?.state ?? '?', status.update?.state === 'error' ? 'warn' : 'info'),
      pill('Admin', status.remote?.state ?? '?', status.remote?.state === 'connected' ? 'ok' : 'info'),
    );
  }

  function renderNav() {
    nav.replaceChildren(
      ...TABS.map(([id, label]) =>
        h('button', { class: `sx-tab${tab === id ? ' active' : ''}`, onClick: () => ((tab = id), render()) }, label),
      ),
    );
  }

  function render() {
    const scroll = body.scrollTop;
    renderNav();
    renderStatusBar();
    body.replaceChildren(...RENDERERS[tab]().flat().filter(Boolean));
    body.scrollTop = scroll;
  }

  // Re-render on external changes, but never while the user is typing.
  let pending = false;
  const isEditing = () => root.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  function renderWhenIdle() {
    if (!isEditing()) return render();
    if (pending) return;
    pending = true;
    document.activeElement.addEventListener('blur', () => ((pending = false), setTimeout(renderWhenIdle)), { once: true });
  }

  const offConfig = api.onConfig((next) => {
    config = next;
    renderWhenIdle();
  });
  const offStatus = api.onStatus((next) => {
    status = next;
    renderStatusBar();
    if (tab === 'system') renderWhenIdle();
  });

  render();
  return () => {
    offConfig?.();
    offStatus?.();
  };
}

// Scales big uploads down so the config (and WebRTC messages) stay small.
async function imageToDataUrl(file, maxSize = 1000) {
  if (file.size > 8 * 1024 * 1024) throw new Error('Logo file is too large (max 8 MB)');
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  if (file.type === 'image/svg+xml') return dataUrl;
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('Not a valid image'));
    i.src = dataUrl;
  });
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
  const canvas = h('canvas', { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}
