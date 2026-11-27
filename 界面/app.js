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

function renderTotals(quotes, ranked, ties) {
  const best = ranked[0];
  const unresolved = quotes.length - ranked.length;
  const cheapest = ranked.length > 1;
  const caption = cheapest ? (ties.length > 1 ? '最低费用 · ' + ties.length + ' 项并列' : '最低费用 · ' + displayName(best))
    : quotes.length ? displayName(best || quotes[0]) : '未选中报价';
  const amount = best ? money(best.total) : !quotes.length ? '请在报价单中勾选' : '待补充用量、价格或比例';
  const heading = element('div', '', 'total-caption');
  heading.append(element('h3', caption));
  if (best) heading.append(element('p', '费用仅供参考，以平台计费为准。', 'total-note'));
  byId('total').replaceChildren(element('p', amount, 'amount' + (best ? '' : ' pending-total')), heading);

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

let lowestQuoteEntry = null;
let quoteOrder = [];

function syncQuoteOrder() {
  const rows = byId('quote-rows');
  const focused = document.activeElement;
  if (rows.contains(focused) && focused.matches('input:not([type=checkbox])')) return;
  let next = null;
  for (let index = quoteOrder.length - 1; index >= 0; index--) {
    const { main, controls: { extra } } = quoteOrder[index];
    if (extra.nextElementSibling !== next || main.nextElementSibling !== extra) {
      if (rows.moveBefore) {
        rows.moveBefore(extra, next);
        rows.moveBefore(main, extra);
      } else {
        rows.insertBefore(extra, next);
        rows.insertBefore(main, extra);
      }
    }
    next = main;
  }
}

byId('quote-rows').addEventListener('focusout', () => queueMicrotask(syncQuoteOrder));

function renderQuoteCost(quote, isLowest, tied, amount) {
  const { controls } = quote.entry;
  const total = controls['cost-amount'];
  const badge = controls['cost-badge'];
  total.hidden = !quote.active;
  controls['cost-inactive'].hidden = quote.active;
  badge.hidden = !isLowest;
  fields.forEach(({ id }, index) => {
    const { cost, reason } = quote.rows[index];
    const available = quote.active && cost !== null;
    const label = available ? format(cost, { min: 2 }) : quote.active ? reason : '—';
    const inline = controls['inline-cost-' + id];
    controls['inline-currency-' + id].hidden = !available;
    if (inline.textContent !== label) inline.textContent = label;
    inline.classList.toggle('inactive', !quote.active);
    inline.classList.toggle('pending', quote.active && cost === null);
  });
  if (!quote.active) return;

  const [integer, fraction] = amount.split('.');
  controls['cost-currency'].hidden = quote.total === null;
  controls['cost-integer'].textContent = integer;
  controls['cost-fraction'].textContent = fraction ? '.' + fraction : '';
  total.classList.toggle('pending', quote.total === null);
  total.title = quote.unit === 'credit' && quote.native !== null
    ? '本次站内额度：' + format(quote.native, { prefix: '$', min: 2 }) : '';
  badge.textContent = isLowest ? (tied ? '并列最低' : '最低') : '';
}

function render() {
  const errors = [];
  const counts = Object.fromEntries(fields.map(({ id, label }) => [id, readField(usageFields[id], parseMillions, label, errors)]));
  message(byId('usage-error'), errors.join(' '), true);
  const all = quoteEntries.map(entry => ({ entry, ...readQuote(entry, counts) }));
  const chosen = all.filter(quote => quote.active);
  const invalid = all.filter(quote => quote.errors.length);
  message(byId('quote-errors'), invalid.map(quote => '报价 ' + quote.letter + ' · ' + quote.errors.join(' ')).join('；'), true);
  byId('quote-count').textContent = '参与对比 ' + chosen.length + ' / ' + all.length;
  const ranked = chosen.filter(quote => quote.total !== null).sort(rank);
  const best = ranked[0];
  const ties = best ? ranked.filter(quote => rank(quote, best) === 0) : [];
  const lowest = new Set(ranked.length > 1 ? ties : []);
  let decimals = 4;
  for (const quote of all) {
    const amount = quote.total === null ? '待计算' : format(quote.total, { min: 4, max: 8 });
    if (quote.active) decimals = Math.max(decimals, amount.split('.')[1]?.length ?? 0);
    quote.entry.controls.model.title = quote.parts.model;
    renderQuoteCost(quote, lowest.has(quote), ties.length > 1, amount);
  }
  byId('quote-rows').style.setProperty('--quote-total-decimals', decimals);
  quoteOrder = [...ranked, ...all.filter(quote => !quote.active || quote.total === null)].map(quote => quote.entry);
  syncQuoteOrder();
  renderTotals(chosen, ranked, ties);
  lowestQuoteEntry = best?.entry ?? null;
  byId('locate-lowest').disabled = !lowestQuoteEntry;
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
function connectQuoteHoverActions() {
  const rows = byId('quote-rows');
  const popup = byId('quote-row-actions');
  const reset = byId('reset-quotes');
  let shown = null;
  let trigger = null;
  let timer;

  function hide(restoreFocus = false) {
    clearTimeout(timer);
    const anchor = trigger;
    anchor?.setAttribute('aria-expanded', 'false');
    trigger = null;
    shown = null;
    popup.hidden = true;
    if (restoreFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
  }

  const roles = ['options', 'remove'];
  const buttons = roles.map(role => {
    const button = element('button', '', 'icon-button' + (role === 'remove' ? ' remove-button' : ''));
    button.type = 'button';
    button.addEventListener('click', () => {
      const target = shown?.querySelector('[data-role=' + role + ']');
      const explicit = Boolean(trigger);
      hide(explicit && role === 'options');
      if (target?.isConnected) target.click();

    });
    popup.insertBefore(button, reset);
    return button;
  });
  reset.addEventListener('click', () => {
    const explicit = Boolean(trigger);
    hide();
    if (explicit) byId('add-blank').focus({ preventScroll: true });
  });

  function show(row, x, y, anchor = null) {
    if (!row.isConnected) { hide(); return; }
    trigger?.setAttribute('aria-expanded', 'false');
    trigger = anchor;
    trigger?.setAttribute('aria-expanded', 'true');
    shown = row;
    for (const [index, role] of roles.entries()) {
      const original = row.querySelector('[data-role=' + role + ']');
      const button = buttons[index];
      button.replaceChildren(original.querySelector('svg:not([hidden])').cloneNode(true));
      button.title = original.title;
      button.setAttribute('aria-label', original.getAttribute('aria-label'));
      if (role === 'options') {
        for (const attr of ['aria-expanded', 'aria-controls']) button.setAttribute(attr, original.getAttribute(attr));
      }
    }
    for (const button of [...buttons, reset]) button.tabIndex = anchor ? 0 : -1;
    popup.hidden = false;
    const { offsetWidth: width, offsetHeight: height } = popup;
    const left = Math.max(6, Math.min(x - width / 2, innerWidth - width - 6));
    const top = y >= height + 9 ? y - height - 4 : Math.min(y + 6, innerHeight - height - 6);
    popup.style.left = left + 'px';
    popup.style.top = Math.max(6, top) + 'px';
    if (anchor) buttons[0].focus({ preventScroll: true });
  }

  rows.addEventListener('click', event => {
    const anchor = event.target.closest('[data-role=action-trigger]');
    if (!anchor) return;
    if (trigger === anchor) { hide(true); return; }
    clearTimeout(timer);
    const rect = anchor.getBoundingClientRect();
    show(anchor.closest('.quote-row'), rect.left + rect.width / 2, rect.top, anchor);
  });
  document.addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse' || trigger) return;
    clearTimeout(timer);
    if (popup.contains(event.target)) return;
    const row = event.target.closest?.('.quote-row');
    if (row && rows.contains(row)) {
      // Allow the pointer to cross a different row to reach the popup above it.
      if (row !== shown) timer = setTimeout(() => show(row, event.clientX, event.clientY), shown ? 240 : 140);
    } else if (shown) timer = setTimeout(hide, 220);
  }, { passive: true });
  document.addEventListener('pointerleave', () => { if (!trigger) hide(); });
  document.addEventListener('pointerdown', event => {
    if (!popup.contains(event.target) && !trigger?.contains(event.target)) hide();
  }, true);
  document.addEventListener('focusin', event => {
    if (trigger && !popup.contains(event.target) && !trigger.contains(event.target)) hide();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(true); });
  window.addEventListener('scroll', () => hide(true), { capture: true, passive: true });
  window.addEventListener('resize', () => hide(true));
  new MutationObserver(() => { if (shown && !shown.isConnected) hide(); }).observe(rows, { childList: true });
}

connectQuoteSearch();
connectQuoteHoverActions();
byId('locate-lowest').addEventListener('click', () => {
  const total = lowestQuoteEntry?.controls['cost-amount'];
  if (!total) return;
  selectQuote(lowestQuoteEntry);
  total.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  total.focus({ preventScroll: true });
});
const sidebarToggle = byId('quote-sidebar-toggle');
function setQuoteSidebarExpanded(expanded) {
  sidebarToggle.closest('.quote-workspace').classList.toggle('sidebar-collapsed', !expanded);
  byId('quote-settings-host').hidden = !expanded;
  sidebarToggle.setAttribute('aria-expanded', String(expanded));
  sidebarToggle.title = expanded ? '折叠报价设置' : '展开报价设置';
  sidebarToggle.setAttribute('aria-label', sidebarToggle.title);
}
sidebarToggle.addEventListener('click', () => setQuoteSidebarExpanded(sidebarToggle.getAttribute('aria-expanded') !== 'true'));
byId('add-blank').addEventListener('click', () => {
  setQuoteSidebarExpanded(true);
  addQuote({}, { focus: true });
  render();
});

refreshCatalog();
render();
connectWorkbookControls();
connectHtmlImport();
