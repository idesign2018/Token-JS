'use strict';
const formats = { chat: 'OpenAI Chat Completions', responses: 'OpenAI Responses', anthropic: 'Anthropic Messages' };
const usageFields = makeUsageFields(byId('usage-fields'));
const usageNote = byId('usage-note');
const usageJson = byId('usage-json');
const assumeZero = byId('assume-zero');

function rank(a, b) {
  const diff = a.total.n * b.total.d - b.total.n * a.total.d;
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}

const platformAliases = new Map([
  ['rightcode', 'RC'], ['cherryin', 'CIN'], ['packyapi', 'PA'], ['packycode', 'PC'],
  ['荔枝ai', '荔枝'], ['塞尔达传说', '塞尔达']
]);

function platformShortName(name) {
  const key = name.normalize('NFKC').toLowerCase().replace(/[\s._-]+/g, '');
  const alias = platformAliases.get(key);
  if (alias) return alias;
  if (!/^[a-z][a-z\d ._-]*$/i.test(name)) return name;
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[ ._-]+/).filter(Boolean);
  return words.length > 1 ? words.map(word => word[0]).join('').toUpperCase() : name;
}

function displayName(quote) {
  const { platform, model, group } = quote.parts;
  const shortPlatform = platformShortName(platform);
  const shortGroup = group.replace(/，.*$/, '').replace(/号池起价$/, '').replace(/号池$/, '')
    .replace(/^default 分组(?:标准档)?/i, '默认').replace(/（/g, ' (').replace(/）/g, ')').trim();
  const label = quoteName({ platform: shortPlatform, model, group: shortGroup });
  return quote.letter + ' · ' + (label || '未命名报价');
}

function renderTotals(quotes) {
  const ranked = quotes.filter(quote => quote.total !== null).sort(rank);
  const best = ranked[0];
  const unresolved = quotes.length - ranked.length;
  const ties = best ? ranked.filter(quote => rank(quote, best) === 0) : [];
  const cheapest = best && ranked.length > 1;
  const caption = cheapest ? (ties.length > 1 ? '最低费用 · ' + ties.length + ' 项并列' : '最低费用 · ' + displayName(best))
    : quotes.length ? displayName(best || quotes[0]) : '未选中报价';
  const amount = best ? money(best.total) : !quotes.length ? '请在报价单中勾选' : '待补充用量、价格或比例';
  byId('total').replaceChildren(element('p', amount, 'amount' + (best ? '' : ' pending-total')), element('h3', caption));

  const rows = quotes.map(quote => {
    const row = element('tr', '', cheapest && ties.includes(quote) ? 'best' : '');
    const title = element('th', displayName(quote));
    title.scope = 'row';
    title.title = quote.name;
    if (quote.unit === 'credit' && quote.native !== null) title.title += ' · ' + format(quote.native, { prefix: '$', min: 2 }) + ' 站内额度';
    row.append(title);
    for (const key of ['input', 'output', 'read', 'write']) {
      const { cost, reason } = quote.rows[fields.findIndex(field => field.id === key)];
      row.append(element('td', cost === null ? reason : money(cost), cost === null ? 'pending' : ''));
    }
    row.append(element('td', quote.total === null ? '待计算' : money(quote.total), quote.total === null ? 'cost-sum pending' : 'cost-sum'));
    return row;
  });
  byId('cost-details').hidden = !rows.length;
  byId('result-rows').replaceChildren(...rows);

  const notes = [];
  if (ranked.length > 1 && ties.length === 1) {
    const next = ranked[1];
    const result = compare(best.total, next.total);
    const label = ranked.length === 2 ? '比 ' + next.letter + ' 少' : '比次低价少';
    notes.push(best.letter + ' ' + label + ' ' + money(result.difference) + '（约 ' + format(result.savings, { max: 2, suffix: '%' }) + '）。');
  }
  if (unresolved && quotes.length > 1) notes.push('另有 ' + unresolved + ' 项数据不全，未计入排名。');
  message(byId('comparison'), notes.join(' '));
}

function render() {
  const errors = [];
  const counts = Object.fromEntries(fields.map(({ id, label }) => [id, readField(usageFields[id], parseMillions, label, errors)]));
  message(byId('usage-error'), errors.join(' '), true);
  const all = quoteEntries.map(entry => readQuote(entry, counts));
  const chosen = all.filter(quote => quote.active);
  const invalid = all.filter(quote => quote.errors.length);
  message(byId('quote-errors'), invalid.map(quote => '报价 ' + quote.letter + ' · ' + quote.errors.join(' ')).join('；'), true);
  byId('quote-count').textContent = '参与对比 ' + chosen.length + ' / ' + all.length;
  renderTotals(chosen);
  byId('add-preset').disabled = !chosen.length;
  syncQuoteSearchChecks();
}

function setUsage(counts) {
  for (const { id } of fields) usageFields[id].value = millions(counts[id]);
}

byId('usage-fields').addEventListener('input', () => { message(usageNote, ''); render(); });
usageJson.addEventListener('input', () => {
  assumeZero.checked = false;
  usageJson.removeAttribute('aria-invalid');
});
byId('no-cache').addEventListener('click', () => {
  usageFields.write.value = '0';
  usageFields.read.value = '0';
  message(usageNote, '缓存写和缓存读已设为 0。');
  render();
});
byId('clear').addEventListener('click', () => {
  setUsage({});
  usageJson.value = '';
  usageJson.removeAttribute('aria-invalid');
  assumeZero.checked = false;
  message(usageNote, '已清空用量，报价保留。');
  render();
});
byId('import').addEventListener('click', () => {
  try {
    const result = importUsage(usageJson.value, byId('usage-format').value, assumeZero.checked);
    setUsage(result.counts);
    usageJson.removeAttribute('aria-invalid');
    message(usageNote, ['已导入 ' + formats[result.kind] + '。已按百万 Token 回填。', ...result.notes].join(' '));
    render();
  } catch (error) {
    usageJson.setAttribute('aria-invalid', 'true');
    message(usageNote, '未导入，当前用量未改动。' + error.message, true);
  }
});
connectQuoteSearch();
byId('add-preset').addEventListener('click', () => {
  byId('result-title').scrollIntoView({ block: 'nearest' });
});
byId('add-blank').addEventListener('click', () => { addQuote({}, { focus: true }); render(); });

refreshCatalog();
render();
connectWorkbookControls();
connectHtmlImport();
