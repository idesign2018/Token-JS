'use strict';
const builtinData = [
  ['rc-sol', 'Right Code', 'GPT-6.2 Sol', 'Pro 号池起价', 'https://www.helpaio.com/transit/info/rightcode', ['0.8', '4', '1', '0.04'], '1:1'],
  ['cherry-sol', 'CherryIN', 'GPT-6.2 Sol', 'default 分组标准档（≤272K）', 'https://open.cherryin.ai/pricing', ['2.2', '11', '2.75', '0.11'], '67.8:10'],
  ['zelda-sol', '塞尔达传说', 'GPT-6.2 Sol', 'Pro20x 号池，已折人民币', 'https://apivs.si/models/gpt-6.2-sol', ['0.4', '2', '0.5', '0.04']],
  ['lizhi-sol', '荔枝 AI', 'GPT-6.2 Sol', 'Codex 混池起价，已折人民币', 'https://apivs.si/models/gpt-6.2-sol', ['0.14', '0.7', '0.175', '0.007']],
  ['rc-terra', 'Right Code', 'GPT-6.1 Terra', 'Pro 号池起价', 'https://www.helpaio.com/transit/info/rightcode', ['0.4', '2', '0.5', '0.02'], '1:1'],
  ['rc-sonnet', 'Right Code', 'Claude Sonnet 5.5', 'Max 号池', 'https://www.helpaio.com/transit/info/rightcode', ['4', '20', '5', '0.4'], '1:1'],
  ['packy-sonnet', 'PackyAPI', 'Claude Sonnet 5.5', 'cc-sale，已折人民币；缓存创建价未核实', 'https://shice.ai/providers/packycode', ['1.6', '8', '', '0.08']],
  ['rc-opus', 'Right Code', 'Claude Opus 5.5', 'Max 号池', 'https://www.helpaio.com/transit/info/rightcode', ['8', '40', '10', '0.4'], '1:1'],
  ['packy-opus', 'PackyAPI', 'Claude Opus 5.5', 'cc-sale，已折人民币；缓存创建价未核实', 'https://shice.ai/providers/packycode', ['3.2', '16', '', '0.16']],
  ['rc-fable', 'Right Code', 'Claude Fable 5.2', 'Max 号池', 'https://www.helpaio.com/transit/info/rightcode', ['16', '80', '20', '0.4'], '1:1'],
  ['cherry-fable', 'CherryIN', 'Claude Fable 5.2', 'default 分组', 'https://open.cherryin.ai/pricing', ['8', '40', '10', '0.2'], '67.8:10'],
  ['packy-fable', 'PackyAPI', 'Claude Fable 5.2', 'cc-sale，已折人民币；缓存创建价未核实', 'https://shice.ai/providers/packycode', ['6.4', '32', '', '0.16']]
];
const presets = new Map(builtinData.map(([key, platform, model, group, url, values, ratio]) => [key, {
  platform, model, group, url, unit: ratio ? 'credit' : 'cny', ratio: ratio || '',
  prices: Object.fromEntries(fields.map(({ id }, index) => [id, values[index]]))
}]));
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

function quoteIdentity(data) {
  return JSON.stringify([data.platform, data.model, data.group]);
}

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
  if (loadedSystemRows.length) {
    const fallback = new Map([...presets.values()].map(row => [quoteIdentity(row), row]));
    const systemGroups = new Map();
    for (const [index, row] of loadedSystemRows.entries()) {
      const identity = quoteIdentity(row);
      if (!systemGroups.has(row.platform)) systemGroups.set(row.platform, []);
      const ref = fallback.get(identity);
      systemGroups.get(row.platform).push(['system-' + index, { ...row, url: ref?.url }]);
    }
    for (const [platform, items] of systemGroups) addGroup('系统报价单 · ' + platform, items);
  } else addGroup('内置参考报价', presets);
  for (const entry of quoteEntries) syncGroupOptions(entry);
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
  controls.unit.value = data.unit ?? 'cny';
  controls.ratio.value = options.imported ? (data.ratio || '') : (data.ratio || '1:1');
  if (options.imported && !data.ratio) controls.ratio.placeholder = '请填写';
  for (const { id } of fields) {
    const input = controls[id];
    input.value = data.prices?.[id] || '';
    if (!data.starting?.includes(id)) continue;
    const marker = element('span', '起价', 'money-mark starting-mark');
    marker.id = 'quote-starting-' + domId + '-' + id;
    input.parentElement.classList.add('has-starting');
    input.parentElement.append(marker);
    input.setAttribute('aria-describedby', marker.id);
    input.addEventListener('input', () => {
      const visible = Boolean(input.value.trim());
      marker.hidden = !visible;
      input.parentElement.classList.toggle('has-starting', visible);
      if (visible) input.setAttribute('aria-describedby', marker.id);
      else input.removeAttribute('aria-describedby');
    });
  }
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
  controls.extra.id = 'quote-extra-' + domId;
  controls.options.setAttribute('aria-controls', controls.extra.id);
  numberQuote(entry, quoteEntries.length);
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
    }
    render();
  });
  groupEditor.addEventListener('input', () => syncGroupOptions(entry, groupEditor.value.trim()));
  function confirmGroup() {
    rememberGroup();
    entry.editingGroup = false;
    syncGroupOptions(entry, groupEditor.value.trim());
    refreshGroupOptions();
    render();
    controls.group.focus();
  }
  controls['confirm-group'].addEventListener('click', confirmGroup);
  groupEditor.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    confirmGroup();
  });
  controls.platform.addEventListener('change', refreshGroupOptions);
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
