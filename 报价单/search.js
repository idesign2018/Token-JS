'use strict';

let refreshQuoteSearch = () => {};
let syncQuoteSearchChecks = () => {};

function quoteSearchKey(row, scope) {
  return JSON.stringify([scope, row.file || row.workbook || '', row.sheet || '', row.platform, row.model, row.group, row.unit, row.ratio,
    fields.map(({ id }) => row.prices?.[id] ?? '')]);
}
const searchableText = value => String(value ?? '').normalize('NFKC').toLowerCase();
const compactQuoteText = value => searchableText(value).replace(/[^\p{L}\p{N}]/gu, '');

function fuzzyQuoteToken(token, fields) {
  const needle = compactQuoteText(token);
  if (!needle) return false;
  return fields.some(value => {
    const text = compactQuoteText(value);
    if (text.includes(needle)) return true;
    if (needle.length < 3 || !/^[a-z0-9]+$/.test(needle)) return false;
    let at = 0;
    for (const letter of text) if (letter === needle[at] && ++at === needle.length) return true;
    return false;
  });
}

function connectQuoteSearch() {
  const select = byId('quote-preset');
  const trigger = byId('quote-search-trigger');
  const panel = byId('quote-search-panel');
  const editor = byId('quote-search-editor');
  const selections = new Map();
  const input = byId('quote-search-input');
  const list = byId('quote-search-results');
  const count = byId('quote-search-count');
  let options = [];
  let active = -1;

  function resize() {
    if (panel.hidden) return;
    const rect = editor.getBoundingClientRect();
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop ?? 0;
    const bottom = top + (viewport?.height ?? innerHeight);
    const above = rect.top - top;
    const below = bottom - rect.bottom;
    panel.classList.toggle('opens-up', below < 260 && above > below);
    const space = panel.classList.contains('opens-up') ? above : below;
    panel.style.setProperty('--search-list-height', Math.max(36, Math.floor(space - 40)) + 'px');
  }

  function highlight(index, scroll = true) {
    if (active >= 0) options[active]?.classList.remove('active');
    active = index;
    if (index < 0) { input.removeAttribute('aria-activedescendant'); return; }
    const option = options[index];
    option.classList.add('active');
    input.setAttribute('aria-activedescendant', option.id);
    if (scroll) option.scrollIntoView({ block: 'nearest' });
  }

  function close(restoreFocus = false) {
    panel.hidden = true;
    editor.hidden = true;
    trigger.hidden = false;
    input.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }

  function updateSelection(items, action) {
    const picked = new Map(quoteEntries.filter(entry => entry.searchKey).map(entry => [entry.searchKey, entry]));
    const remove = new Set();
    const visited = new Set();
    for (const option of items) {
      const selection = selections.get(option.dataset.choice);
      if (!selection || visited.has(selection.key)) continue;
      visited.add(selection.key);
      const existing = picked.get(selection.key);
      if (existing) {
        if (action !== 'all') remove.add(existing);
      } else if (action !== 'none') {
        const entry = addQuote(selection.row);
        entry.searchKey = selection.key;
        entry.searchLabel = option.dataset.label;
        picked.set(selection.key, entry);
      }
    }
    removeQuotes(remove, false);
    render();
  }

  function choose(index) {
    if (!options[index]) return;
    highlight(index, false);
    updateSelection([options[index]], 'invert');
    input.focus({ preventScroll: true });
  }

  function buildHeading(group, bucket) {
    const heading = element('div', '', 'quote-search-heading');
    const system = group.label.startsWith('系统报价单 · ');
    const label = element('span', system ? group.label.slice('系统报价单 · '.length) : group.label, 'quote-search-group-label');
    label.title = label.textContent;
    if (system) {
      const toolbar = element('span', '', 'quote-search-bulk');
      toolbar.setAttribute('role', 'group');
      toolbar.setAttribute('aria-label', group.label + '的批量选择');
      for (const [action, text, paths] of [
        ['all', '全选', 'M3 3h18v18H3z M7 12l3 3 7-7'],
        ['none', '全不选', 'M3 3h18v18H3z M8 12h8'],
        ['invert', '反选', 'M3 7h16m-4-4 4 4-4 4 M21 17H5m4-4-4 4 4 4']
      ]) {
        const button = element('button', '', 'icon-button');
        button.type = 'button';
        button.dataset.bulk = action;
        button.title = text + '当前组搜索结果';
        button.setAttribute('aria-label', button.title + '：' + group.label);
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.8');
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS(ns, 'path');
        path.setAttribute('d', paths);
        svg.append(path);
        button.append(svg);
        button.addEventListener('click', () => updateSelection(bucket.querySelectorAll('[data-choice]'), action));
        toolbar.append(button);
      }
      heading.append(toolbar);
    }
    heading.append(label);
    return heading;
  }

  function draw() {
    if (panel.hidden) return;
    const query = searchableText(input.value).trim().split(/\s+/).filter(Boolean);
    const content = document.createDocumentFragment();
    options = [];
    for (const group of select.querySelectorAll('optgroup')) {
      const bucket = element('div', '', 'quote-search-group');
      bucket.setAttribute('role', 'group');
      bucket.setAttribute('aria-label', group.label.replace(/^系统报价单 · /, ''));
      bucket.append(buildHeading(group, bucket));
      for (const option of group.children) {
        const row = catalog.get(option.value);
        if (!row) continue;
        const fields = [row.platform, platformShortName(row.platform), row.model, row.group, group.label];
        if (!query.every(token => fuzzyQuoteToken(token, fields))) continue;
        const item = element('div', '', 'quote-search-option');
        const checkbox = element('input');
        checkbox.type = 'checkbox';
        checkbox.tabIndex = -1;
        checkbox.setAttribute('aria-hidden', 'true');
        item.append(checkbox, element('span', quoteName({ ...row, platform: platformShortName(row.platform) })));
        item.dataset.label = option.textContent;
        item.id = 'quote-search-option-' + options.length;
        item.dataset.choice = option.value;
        item.dataset.index = options.length;
        item.title = option.title;
        item.setAttribute('role', 'option');
        options.push(item);
        bucket.append(item);
      }
      if (bucket.childElementCount > 1) content.append(bucket);
    }
    list.replaceChildren(content);
    count.textContent = options.length ? '找到 ' + options.length + ' 条报价' : '未找到匹配报价';
    list.scrollTop = 0;
    active = -1;
    highlight(options.length ? 0 : -1, false);
    syncQuoteSearchChecks();
    resize();
  }

  function open() {
    trigger.hidden = true;
    editor.hidden = false;
    panel.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-expanded', 'true');
    input.value = '';
    draw();
    input.focus({ preventScroll: true });
    if (active >= 0) options[active].scrollIntoView({ block: 'nearest' });
  }

  syncQuoteSearchChecks = () => {
    const added = quoteEntries.filter(entry => entry.searchKey);
    trigger.firstElementChild.textContent = added.length > 1 ? '已选择 ' + added.length + ' 条报价' : added[0]?.searchLabel || '请选择平台与模型';
    trigger.title = added.length === 1 ? added[0].searchLabel : '搜索并勾选报价，自动加入下方表格';
    if (panel.hidden) return;
    const picked = new Set(added.map(entry => entry.searchKey));
    for (const option of options) {
      const checked = picked.has(selections.get(option.dataset.choice)?.key);
      option.setAttribute('aria-selected', String(checked));
      option.firstElementChild.checked = checked;
    }
  };
  refreshQuoteSearch = () => {
    selections.clear();
    for (const group of select.querySelectorAll('optgroup')) {
      for (const option of group.children) {
        const row = catalog.get(option.value);
        if (row) selections.set(option.value, { row, key: quoteSearchKey(row, group.label) });
      }
    }
    syncQuoteSearchChecks();
    draw();
  };
  trigger.addEventListener('click', () => panel.hidden ? open() : close(true));
  trigger.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(); }
  });
  input.addEventListener('input', draw);
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); close(true); }
    else if (event.key === 'Enter') { event.preventDefault(); choose(active); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (options.length) highlight(active < 0 ? (event.key === 'ArrowDown' ? 0 : options.length - 1) : Math.max(0, Math.min(options.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1))));
    }
  });
  list.addEventListener('mousedown', event => { if (event.target.closest('[data-choice]')) event.preventDefault(); });
  list.addEventListener('click', event => {
    const option = event.target.closest('[data-choice]');
    if (option) choose(Number(option.dataset.index));
  });
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(true); }
  });
  for (const eventName of ['pointerdown', 'focusin']) document.addEventListener(eventName, event => {
    if (!panel.hidden && !trigger.parentElement.contains(event.target)) close();
  });
  for (const target of [window, window.visualViewport].filter(Boolean)) {
    target.addEventListener('resize', resize, { passive: true });
    target.addEventListener('scroll', resize, { passive: true });
  }
  refreshQuoteSearch();
}
