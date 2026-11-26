'use strict';
const quoteEntries = [];
const catalog = new Map();
let nextQuoteId = 0;

function quoteLetter(index) {
  if (index < 26) return String.fromCharCode(65 + index);
  return quoteLetter(Math.floor(index / 26) - 1) + quoteLetter(index % 26);
}

function quoteName(data) {
  return [data.platform, data.model, data.group].filter(Boolean).join(' · ');
}

const customGroup = 'custom';
const groupsByPlatform = new Map();
const platformGroupKey = name => name.normalize('NFKC').trim().toLowerCase().replace(/[\s._-]+/g, '');
let groupRefreshQueued = false;

function refreshGroupOptions() {
  for (const entry of quoteEntries) syncGroupOptions(entry);
  refreshQuoteSuggestions();
}

function queueGroupRefresh() {
  if (groupRefreshQueued) return;
  groupRefreshQueued = true;
  queueMicrotask(() => {
    groupRefreshQueued = false;
    refreshGroupOptions();
  });
}

function groupValue({ controls }) {
  return controls.group.value === customGroup ? controls['custom-group'].value.trim() : controls.group.value.slice(2);
}

function syncGroupOptions(entry, selected = groupValue(entry)) {
  const { controls } = entry;
  const platform = platformGroupKey(controls.platform.value);
  const groups = new Set(platform ? groupsByPlatform.get(platform) : entry.customGroups);
  if (platform) {
    for (const row of catalog.values()) {
      if (platformGroupKey(row.platform) === platform && row.group) groups.add(row.group);
    }
    for (const peer of quoteEntries) {
      if (peer.editingGroup || platformGroupKey(peer.controls.platform.value) !== platform) continue;
      const group = groupValue(peer);
      if (group) groups.add(group);
    }
  }
  if (selected) groups.add(selected);
  controls.group.replaceChildren(new Option('默认', ''), ...[...groups].map(group => new Option(group, 'g:' + group)), new Option('自定义…', customGroup));
  controls.group.value = selected ? 'g:' + selected : entry.editingGroup ? customGroup : '';
  controls.group.title = groupValue(entry) || '默认';
}

function syncQuoteAction({ controls, detailsOpen: open, editingGroup }) {
  controls.extra.hidden = !open && !editingGroup;
  controls['group-field'].hidden = !editingGroup;
  controls['quote-details'].hidden = !open;
  controls.options.setAttribute('aria-expanded', String(open));
  const exchange = controls.unit.value === 'credit';
  const icon = open ? 'collapse' : exchange ? 'exchange' : 'details';
  const label = open ? '收起' : exchange ? '换算' : '详情';
  const button = controls.options;
  if (button.title !== label) {
    button.title = label;
    for (const svg of button.querySelectorAll('[data-icon]')) svg.toggleAttribute('hidden', svg.dataset.icon !== icon);
  }
  button.setAttribute('aria-label', label + '报价 ' + controls.letter.textContent);
}

let loadedSystemRows = [];

function refreshCatalog(workbookRows = [], systemRows = loadedSystemRows) {
  loadedSystemRows = systemRows || [];
  const select = byId('quote-preset');
  catalog.clear();
  select.replaceChildren(new Option('请选择平台与模型', ''));
  function addGroup(label, items) {
    const options = element('optgroup');
    options.label = label;
    for (const [id, data] of items) {
      catalog.set(id, data);
      const fullName = quoteName(data);
      const option = new Option(fullName, id);
      option.title = fullName + ' · ' + label;
      options.append(option);
    }
    if (options.childElementCount) select.append(options);
  }
  const sheets = new Map();
  for (const [index, row] of workbookRows.entries()) {
    const label = [row.file || row.workbook || (typeof row.source === 'string' ? row.source : 'Excel'), row.platform].join(' · ');
    if (!sheets.has(label)) sheets.set(label, []);
    sheets.get(label).push(['xlsx-' + index, row]);
  }
  for (const [label, items] of sheets) addGroup(label, items);
  const systemGroups = new Map();
  for (const [index, row] of loadedSystemRows.entries()) {
    if (!systemGroups.has(row.platform)) systemGroups.set(row.platform, []);
    systemGroups.get(row.platform).push(['system-' + index, row]);
  }
  for (const [platform, items] of systemGroups) addGroup('系统报价单 · ' + platform, items);
  refreshGroupOptions();
  refreshQuoteSearch();
}

const quoteFieldLabels = Object.entries({ platform: '平台', model: '模型名称', group: '分组', unit: '计费', ratio: '充值比例',
  ...Object.fromEntries(fields.map(({ id, label }) => [id, label])) });

function numberQuote(entry, index) {
  const { controls } = entry;
  const letter = quoteLetter(index);
  entry.letter = letter;
  controls.letter.textContent = letter;
  controls.active.setAttribute('aria-label', '将报价 ' + letter + ' 纳入对比');
  controls.remove.setAttribute('aria-label', '移除报价 ' + letter);
  for (const [role, label] of quoteFieldLabels) controls[role].setAttribute('aria-label', '报价 ' + letter + ' ' + label);
  syncQuoteAction(entry);
}

function setQuoteSource(controls, data) {
  controls.source.replaceChildren();
  controls.source.hidden = true;
  if (data.importNote) {
    controls.source.textContent = data.importNote;
    controls.source.hidden = false;
  } else if (data.url) {
    const link = element('a', '参考来源');
    link.href = data.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'external-source';
    link.setAttribute('aria-label', '参考来源（在新标签页打开）');
    link.title = '在新标签页打开参考来源';
    const external = element('span', '↗', 'external-mark');
    external.setAttribute('aria-hidden', 'true');
    link.append(external);
    controls.source.append('2026 年 11 月内置参考 · ', link);
    controls.source.hidden = false;
  } else if (data.file || data.workbook || typeof data.source === 'string') {
    controls.source.textContent = '来源：' + [data.file || data.workbook || data.source, data.sheet || data.platform].filter(Boolean).join(' · ');
    controls.source.hidden = false;
  }
}

const identityField = value => String(value ?? '').normalize('NFKC').trim().toLowerCase();

function suggestionValues(role, platform = '') {
  const current = quoteEntries.map(({ controls }) => ({ platform: controls.platform.value.trim(), model: controls.model.value.trim() }));
  const all = [...catalog.values(), ...current];
  const key = platformGroupKey(platform);
  const scoped = role === 'model' && key ? all.filter(row => platformGroupKey(row.platform || '') === key) : all;
  const options = new Map();
  for (const row of scoped.length ? scoped : all) {
    const value = row[role];
    if (!value) continue;
    const normalized = role === 'platform' ? platformGroupKey(value) : identityField(value);
    if (!options.has(normalized)) options.set(normalized, value);
  }
  return [...options.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

let suggestionMenu;

function getSuggestionMenu() {
  if (suggestionMenu) return suggestionMenu;
  const panel = element('div', '', 'quote-suggest-menu');
  panel.id = 'quote-suggest-options';
  panel.setAttribute('role', 'listbox');
  panel.setAttribute('aria-label', '可用选项');
  panel.hidden = true;
  document.body.append(panel);
  let field = null;
  let choices = [];
  let active = -1;
  let filter = '';
  function close() {
    field?.input.setAttribute('aria-expanded', 'false');
    field?.input.removeAttribute('aria-activedescendant');
    field = null;
    panel.hidden = true;
  }
  function position() {
    if (!field || panel.hidden) return;
    const { input } = field;
    const r = input.getBoundingClientRect();
    const host = input.closest('.table-wrap');
    const hostRect = host?.getBoundingClientRect();
    if (!input.isConnected || !r.width || r.bottom <= 0 || r.top >= innerHeight ||
        (hostRect && (r.right <= hostRect.left || r.left >= hostRect.right))) { close(); return; }
    const below = innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const upward = below < 140 && above > below;
    const width = Math.min(Math.max(r.width, 180), innerWidth - 12);
    panel.style.width = width + 'px';
    panel.style.left = Math.max(6, Math.min(r.left, innerWidth - width - 6)) + 'px';
    panel.style.maxHeight = Math.max(25, Math.min(upward ? above : below, 305)) + 'px';
    panel.style.top = (upward ? r.top - 4 - panel.offsetHeight : r.bottom + 4) + 'px';
  }
  function draw() {
    if (!field) return;
    const value = field.input.value;
    const tokens = filter.trim().split(/\s+/).filter(Boolean);
    choices = field.values().filter(option => tokens.every(token => fuzzyQuoteToken(token, [option])));
    active = -1;
    field.input.removeAttribute('aria-activedescendant');
    panel.replaceChildren(...choices.map((label, i) => {
      const option = element('div', label, 'quote-suggest-option');
      option.id = panel.id + '-' + i;
      option.dataset.index = i;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(label === value));
      return option;
    }));
    const selected = choices.indexOf(value);
    panel.hidden = !choices.length;
    field.input.setAttribute('aria-expanded', String(!panel.hidden));
    panel.scrollTop = 0;
    position();
    if (selected >= 0 && !filter) panel.children[selected].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function open(next, query = '') {
    if (field !== next) close();
    field = next;
    filter = query;
    draw();
  }
  function choose(index) {
    if (!field || !choices[index]) return;
    const input = field.input;
    const value = choices[index];
    close();
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  panel.addEventListener('mousedown', event => event.preventDefault());
  panel.addEventListener('click', event => {
    const item = event.target.closest('[data-index]');
    if (item) choose(Number(item.dataset.index));
  });
  document.addEventListener('pointerdown', event => {
    if (field && !panel.contains(event.target) && !field.wrapper.contains(event.target)) close();
  });
  window.addEventListener('resize', position);
  window.addEventListener('scroll', event => { if (event.target !== panel) position(); }, true);
  suggestionMenu = {
    open, close,
    isOpen: next => field === next && !panel.hidden,
    refresh(next) { if (field === next) draw(); },
    keyboard(next, event) {
      if (event.isComposing) return;
      if (event.key === 'Escape' && field === next) { event.preventDefault(); close(); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (field !== next || panel.hidden) open(next);
        if (!choices.length || panel.hidden) return;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        panel.children[active]?.classList.remove('active');
        active = active < 0 ? (step === 1 ? 0 : choices.length - 1) : Math.max(0, Math.min(choices.length - 1, active + step));
        const item = panel.children[active];
        item.classList.add('active');
        next.input.setAttribute('aria-activedescendant', item.id);
        item.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (field === next && active >= 0 && !panel.hidden) choose(active);
        else { close(); next.input.blur(); }
      }
    }
  };
  return suggestionMenu;
}

function connectQuoteSuggestions(platform, model) {
  const menu = getSuggestionMenu();
  for (const [role, input] of [['platform', platform], ['model', model]]) {
    const wrapper = element('span', '', 'quote-suggest-field');
    input.before(wrapper);
    wrapper.append(input);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', 'quote-suggest-options');
    input.setAttribute('aria-expanded', 'false');
    const arrow = element('button', '▼', 'quote-suggest-arrow');
    arrow.type = 'button';
    arrow.tabIndex = -1;
    arrow.setAttribute('aria-label', role === 'platform' ? '展开平台选项' : '展开模型选项');
    wrapper.append(arrow);
    const field = { input, wrapper, values: () => suggestionValues(role, platform.value) };
    arrow.addEventListener('mousedown', event => event.preventDefault());
    arrow.addEventListener('click', event => {
      event.preventDefault();
      if (menu.isOpen(field)) menu.close();
      else { input.focus({ preventScroll: true }); menu.open(field); }
    });
    input.refreshQuoteSuggestions = () => menu.refresh(field);
    input.addEventListener('input', () => { if (document.activeElement === input) menu.open(field, input.value); });
    input.addEventListener('blur', () => { if (menu.isOpen(field)) menu.close(); });
    input.addEventListener('keydown', event => menu.keyboard(field, event));
  }
}

function refreshQuoteSuggestions() {
  for (const [platform, model] of [
    [byId('html-import-platform'), byId('html-import-model')],
    ...quoteEntries.map(({ controls }) => [controls.platform, controls.model])
  ]) {
    // Do not eagerly build a full model list for every table row.
    if (platform === byId('html-import-platform') || [platform, model].includes(document.activeElement)) {
      platform.refreshQuoteSuggestions?.();
      model.refreshQuoteSuggestions?.();
    }
  }
}

function applyMatchingQuote(entry) {
  const { controls, letter } = entry;
  const status = byId('quote-match-status');
  const platform = platformGroupKey(controls.platform.value);
  const model = identityField(controls.model.value);
  const group = identityField(groupValue(entry));
  const identity = JSON.stringify([platform, model, group]);
  if (entry.matchIdentity !== identity) {
    if (entry.matchIdentity !== undefined) delete entry.searchKey;
    entry.matchIdentity = identity;
  }
  if (!platform || !model) { message(status, ''); return; }
  const matches = [...catalog.values()].filter(row => platformGroupKey(row.platform || '') === platform &&
    identityField(row.model) === model && identityField(row.group) === group);
  if (matches.length !== 1) {
    message(status, '报价 ' + letter + (matches.length ? '有多条 Excel 记录匹配，请直接从「选择报价」指定来源。' : '没有匹配的 Excel 记录。') + ' 已保留当前单价、币种和比例。');
    return;
  }
  const row = matches[0];
  controls.unit.value = row.unit;
  controls.ratio.value = row.ratio || '';
  for (const { id } of fields) {
    const input = controls[id];
    input.value = row.prices?.[id] ?? '';
    const marker = input.parentElement.querySelector('.starting-mark');
    if (marker) {
      marker.hidden = true;
      input.parentElement.classList.remove('has-starting');
      input.removeAttribute('aria-describedby');
      input.removeEventListener('input', input.updateStartingMark);
    }
  }
  setQuoteSource(controls, row);
  message(status, '报价 ' + letter + ' 已按 Excel 更新单价、币种和充值比例。');
}

function addQuote(data = {}, options = {}) {
  const fragment = byId('quote-template').content.cloneNode(true);
  const main = fragment.firstElementChild;
  const controls = Object.fromEntries([...fragment.querySelectorAll('[data-role]')].map(node => [node.dataset.role, node]));
  // Keep DOM IDs stable when visible letters change after a removal.
  const domId = nextQuoteId++;
  const entry = { controls, main, letter: '', anchor: 'paid', detailsOpen: false, editingGroup: false, customGroups: new Set() };
  controls.active.checked = options.active !== false;
  controls.platform.value = data.platform || '';
  controls.model.value = data.model || '';
  syncGroupOptions(entry, data.group || '');
  entry.matchIdentity = JSON.stringify([platformGroupKey(controls.platform.value), identityField(controls.model.value), identityField(groupValue(entry))]);
  controls.unit.value = data.unit ?? 'cny';
  controls.ratio.value = options.imported ? (data.ratio || '') : (data.ratio || '1:1');
  if (options.imported && !data.ratio) controls.ratio.placeholder = '请填写';
  for (const { id } of fields) {
    const input = controls[id];
    input.value = data.prices?.[id] ?? '';
    if (!data.starting?.includes(id)) continue;
    const marker = element('span', '起价', 'money-mark starting-mark');
    marker.id = 'quote-starting-' + domId + '-' + id;
    input.parentElement.classList.add('has-starting');
    input.parentElement.append(marker);
    input.setAttribute('aria-describedby', marker.id);
    input.updateStartingMark = () => {
      const visible = Boolean(input.value.trim());
      marker.hidden = !visible;
      input.parentElement.classList.toggle('has-starting', visible);
      if (visible) input.setAttribute('aria-describedby', marker.id);
      else input.removeAttribute('aria-describedby');
    };
    input.addEventListener('input', input.updateStartingMark);
  }
  setQuoteSource(controls, data);
  controls.extra.id = 'quote-extra-' + domId;
  controls.options.setAttribute('aria-controls', controls.extra.id);
  numberQuote(entry, quoteEntries.length);
  connectQuoteSuggestions(controls.platform, controls.model);
  controls.options.addEventListener('click', () => {
    entry.detailsOpen = !entry.detailsOpen;
    render();
  });
  const groupEditor = controls['custom-group'];
  groupEditor.id = 'quote-custom-group-' + domId;
  controls['custom-label'].htmlFor = groupEditor.id;
  function rememberGroup() {
    const name = groupEditor.value.trim();
    if (!entry.editingGroup || !name) return;
    const platform = platformGroupKey(controls.platform.value);
    if (!platform) entry.customGroups.add(name);
    else {
      if (!groupsByPlatform.has(platform)) groupsByPlatform.set(platform, new Set());
      groupsByPlatform.get(platform).add(name);
    }
  }
  controls.group.addEventListener('change', () => {
    if (controls.group.value === customGroup) {
      entry.editingGroup = true;
      syncGroupOptions(entry, groupEditor.value.trim());
      syncQuoteAction(entry);
      groupEditor.focus();
      groupEditor.select();
    } else {
      rememberGroup();
      entry.editingGroup = false;
      refreshGroupOptions();
      applyMatchingQuote(entry);
    }
    render();
  });
  groupEditor.addEventListener('input', () => syncGroupOptions(entry, groupEditor.value.trim()));
  function confirmGroup() {
    rememberGroup();
    entry.editingGroup = false;
    syncGroupOptions(entry, groupEditor.value.trim());
    refreshGroupOptions();
    applyMatchingQuote(entry);
    render();
    controls.group.focus();
  }
  controls['confirm-group'].addEventListener('click', confirmGroup);
  groupEditor.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    confirmGroup();
  });
  for (const input of [controls.platform, controls.model]) {
    input.addEventListener('change', () => {
      refreshGroupOptions();
      applyMatchingQuote(entry);
      render();
    });
  }
  controls.remove.addEventListener('click', () => removeQuote(entry));
  function onEdit(event) {
    if (event.target === controls.paid || event.target === controls.credit) entry.anchor = event.target.dataset.role;
    render();
  }
  main.addEventListener('input', onEdit);
  controls.extra.addEventListener('input', onEdit);
  quoteEntries.push(entry);
  byId('quote-rows').append(fragment);
  queueGroupRefresh();
  if (options.focus) controls.platform.focus();
  return entry;
}

function removeQuote(entry) {
  const index = quoteEntries.indexOf(entry);
  if (index < 0) return;
  message(byId('quote-match-status'), '');
  entry.main.remove();
  entry.controls.extra.remove();
  quoteEntries.splice(index, 1);
  queueGroupRefresh();
  for (let i = index; i < quoteEntries.length; i++) numberQuote(quoteEntries[i], i);
  render();
}

function resetQuoteTable() {
  quoteEntries.length = 0;
  groupsByPlatform.clear();
  byId('quote-rows').replaceChildren();
  message(byId('quote-match-status'), '');
  refreshQuoteSuggestions();
  render();
}

byId('reset-quotes').addEventListener('click', () => {
  resetQuoteTable();
  message(byId('quote-status'), '已重置报价表。');
  message(byId('html-import-status'), '');
});

function exportRows() {
  if (!quoteEntries.length) throw new Error('请先添加至少一条报价。');
  return quoteEntries.map(entry => {
    const { controls, letter } = entry;
    const { platform, model, unit, ratio } = Object.fromEntries(['platform', 'model', 'unit', 'ratio']
      .map(role => [role, controls[role].value.trim()]));
    const group = groupValue(entry);
    if (!platform || !model) throw new Error('报价 ' + letter + '：请填写平台和模型名称。');
    try {
      const data = validateQuote({ type: 'quote', version: 1, name: model, unit, ratio,
        prices: Object.fromEntries(fields.map(({ id }) => [id, controls[id].value])) });
      return { platform, model, group, unit, ratio: data.ratio, prices: data.prices };
    } catch (error) { throw new Error('报价 ' + letter + '：' + error.message); }
  });
}

function readQuote(entry, counts) {
  const { controls, letter, anchor } = entry;
  const group = groupValue(entry);
  controls.group.title = group || '默认';
  const errors = [];
  const unit = controls.unit.value;
  const isCredit = unit === 'credit';
  syncQuoteAction(entry);
  controls.exchange.hidden = !isCredit || !entry.detailsOpen;
  controls.ratio.hidden = !isCredit;
  controls['no-ratio'].hidden = isCredit;
  controls['extra-empty'].hidden = unit !== 'cny' || !controls.source.hidden;
  let rate = unit ? one : null;
  if (isCredit) {
    rate = controls.ratio.value.trim() ? readField(controls.ratio, parseRatio, '充值比例', errors) : null;
    if (!controls.ratio.value.trim()) controls.ratio.removeAttribute('aria-invalid');
    const target = anchor === 'paid' ? controls.credit : controls.paid;
    const amount = readField(controls[anchor], parseDecimal, anchor === 'paid' ? '实付费用' : '到账额度', errors);
    target.removeAttribute('aria-invalid');
    target.value = amount === null || rate === null ? '' : convertRecharge(amount, rate, anchor);
    controls.rate.textContent = rate === null ? '填好充值比例后即可换算。' : '$1 折合 ' + money(rate) + ' · 金额双向联动';
  }
  const rates = Object.fromEntries(fields.map(({ id, label }) => {
    controls[id].nextElementSibling.textContent = isCredit ? '$' : unit === 'cny' ? '¥' : '';
    const starting = controls[id].parentElement.classList.contains('has-starting');
    controls[id].title = (isCredit ? '$ 站内额度' : unit === 'cny' ? '¥ 人民币' : '待选择币种') + ' / 1M Tokens' + (starting ? ' · 起价，请核对阶梯档' : '');
    return [id, readField(controls[id], parseDecimal, label, errors)];
  }));
  const parts = { platform: controls.platform.value.trim(), model: controls.model.value.trim(), group };
  return { letter, name: quoteName(parts), parts, unit, errors, active: controls.active.checked, ...calculate(counts, rates, rate) };
}
