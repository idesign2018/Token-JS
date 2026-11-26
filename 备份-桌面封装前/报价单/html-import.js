'use strict';
const HtmlQuotes = (() => {
  const labels = new Map([
    ['输入', 'input'], ['输入价格', 'input'], ['输入价', 'input'],
    ['输出', 'output'], ['输出价格', 'output'], ['输出价', 'output'],
    ['缓存创建', 'write'], ['缓存写入', 'write'], ['缓存写', 'write'], ['缓存读取', 'read'], ['缓存读', 'read']
  ]);
  const normalize = text => text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const ownText = node => normalize(node?.textContent || '');
  const million = /(?:\s*\/\s*)?1\s*(?:M|百万)\s*Tokens?$/i;
  const modelColumns = /^(模型|模型名|模型名称|模型\s*ID|model(?:\s+(?:name|id))?)$/i;
  const splitGroup = (...parts) => parts.filter(Boolean).join(' · ').slice(0, 100);
  const modelText = value => value.length <= 100 ? value : '';

  function priceColumn(text) {
    if (!million.test(text)) return undefined;
    return labels.get(text.replace(million, '').trim());
  }

  function parsePrice(text) {
    const match = /^(起(?:价)?\s*)?([$¥])\s*(\d[\d,]*(?:\.\d+)?|\.\d+)\s*(起(?:价)?)?$/.exec(text);
    if (!match) return null;
    const [, prefix, currency, number, suffix] = match;
    if (number.includes(',') && !/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(number)) return null;
    const value = number.replace(/,/g, '');
    try { parseDecimal(value); } catch { return null; }
    return { value, unit: currency === '$' ? 'credit' : 'cny', starting: Boolean(prefix || suffix) };
  }

  function quote(defaults, model, group, amounts, note = '') {
    const prices = Object.fromEntries(fields.map(({ id }) => [id, '']));
    const currencies = new Set([...amounts.values()].filter(Boolean).map(price => price.unit));
    const unit = currencies.size === 1 ? currencies.values().next().value : '';
    const starting = [];
    if (unit) {
      for (const [id, price] of amounts) {
        if (!price) continue;
        prices[id] = price.value;
        if (price.starting) starting.push(id);
      }
    }
    return { platform: defaults.platform || '', model: modelText(model) || defaults.model || '', group, unit, prices, ratio: '', starting, mixed: currencies.size > 1, note };
  }

  function listQuotes(content, defaults, append) {
    for (const list of content.querySelectorAll('ul[aria-label="模型列表"]')) {
      const section = list.closest('[class~="@container/models"]');
      const heading = ownText(section?.querySelector('.rich-text-content h3'));
      const group = splitGroup(defaults.group || (/^([^，,。]+?号池)(?:[，,。]|$)/.exec(heading)?.[1] || ''));
      for (const li of list.children) {
        if (!li.matches('li')) continue;
        const model = ownText(li.querySelector('[class~="group/name"] > [data-slot="tooltip-trigger"]'));
        const amounts = new Map();
        for (const term of li.querySelectorAll('dl dt')) {
          const id = priceColumn(ownText(term));
          const detail = term.nextElementSibling;
          const price = id && detail?.matches('dd') && parsePrice(ownText(detail));
          if (!price) continue;
          const previous = amounts.get(id);
          // A second number for the same field is ambiguous; do not silently select a tier.
          if (!amounts.has(id)) amounts.set(id, price);
          else if (!previous || previous.value !== price.value || previous.unit !== price.unit || previous.starting !== price.starting) amounts.set(id, null);
        }
        append(model || amounts.size ? quote(defaults, model, group, amounts) : null);
      }
    }
  }

  function modelFromCell(cell) {
    const button = cell?.querySelector('button[aria-label^="复制模型 ID "]');
    return normalize(button?.getAttribute('aria-label').slice('复制模型 ID '.length) || ownText(cell));
  }

  function flatTable(table, defaults, append) {
    const header = table.tHead?.rows[0] || table.rows[0];
    if (!header || [...header.cells].some(cell => cell.colSpan !== 1)) return;
    const names = [...header.cells].map(ownText);
    const modelColumn = names.findIndex(name => modelColumns.test(name));
    const groupColumn = names.findIndex(name => name === '分组');
    const priceColumns = names.map(priceColumn);
    if (priceColumns.filter(Boolean).length < 2 || new Set(priceColumns.filter(Boolean)).size !== priceColumns.filter(Boolean).length) return;
    for (const row of table.rows) {
      if (row === header || row.closest('thead') || row.cells.length !== names.length || [...row.cells].some(cell => cell.colSpan !== 1 || cell.rowSpan !== 1)) continue;
      const cellGroup = ownText(row.cells[groupColumn]);
      const group = splitGroup(defaults.group === cellGroup ? '' : defaults.group, cellGroup);
      const amounts = new Map();
      priceColumns.forEach((key, col) => {
        const price = key && parsePrice(ownText(row.cells[col]));
        if (price) amounts.set(key, price);
      });
      append(amounts.size ? quote(defaults, modelFromCell(row.cells[modelColumn]), group, amounts) : null);
    }
  }

  function cacheValues(text) {
    const write = /^(?:写入|写|缓存写)\s*([^()]*?)(?=\s*(?:\(|读|$))/.exec(text)?.[1].trim();
    const read = /(?:读取|读|缓存读)\s*(.+)$/.exec(text)?.[1].trim();
    return [parsePrice(write || ''), parsePrice(read || '')];
  }

  function cellBlocks(cell) {
    const blocks = [...cell.children].filter(node => node.matches('div'));
    return blocks.length ? blocks.map(ownText) : [ownText(cell)];
  }

  function groupedTable(table, defaults, append) {
    const [top, bottom] = table.tHead?.rows || [];
    if (!top || !bottom || !modelColumns.test(ownText(top.cells[0])) || top.cells[0].colSpan !== 1 ||
      top.cells[1]?.colSpan !== 3 || !/^分组标准价/.test(ownText(top.cells[1])) || !million.test(ownText(top.cells[1])) ||
      ![...bottom.cells].slice(0, 3).every((cell, i) => ownText(cell) === ['输入', '输出', '缓存'][i]) || bottom.cells.length < 3) return false;
    const section = table.closest('section');
    const sectionGroup = ownText(section?.querySelector('header span.truncate'));
    const group = defaults.group || sectionGroup;
    for (const row of table.rows) {
      if (row.closest('thead') || row.cells.length < 4) continue;
      const [modelCell, inputCell, outputCell, cacheCell] = row.cells;
      const inputBlocks = cellBlocks(inputCell);
      if (inputBlocks.some(value => /按(?:图片|次|张|秒)计费|\/\s*(?:张|次|秒)/.test(value))) { append(null); continue; }
      const model = modelFromCell(modelCell);
      const schedule = ownText(modelCell.querySelector('span[title*="该时段"]'));
      const outputs = cellBlocks(outputCell);
      const caches = cellBlocks(cacheCell);
      for (const [index, input] of inputBlocks.entries()) {
        const band = /^(?:[≤≥<>]=?\s*\d+(?:\.\d+)?\s*[KMB])\s*/i.exec(input)?.[0] || '';
        if (inputBlocks.length > 1 && !band) { append(null); continue; }
        const [write, read] = cacheValues(caches.length === inputBlocks.length ? caches[index] : (inputBlocks.length === 1 ? caches[0] : ''));
        const amounts = new Map([
          ['input', parsePrice(input.slice(band.length))],
          ['output', outputs.length === inputBlocks.length ? parsePrice(outputs[index]) : null], ['read', read], ['write', write]
        ].filter(([, price]) => price));
        const note = /\(\s*\d+\s*[hms]/i.test(caches[index] || '') && write ? '缓存写为页面显示的基础价；括号中的其他时长单价请按需手动替换。' : '';
        append(amounts.size ? quote(defaults, model, splitGroup(group, schedule, band.trim()), amounts, note) : null);
      }
    }
    return true;
  }

  function parse(text, defaults = {}) {
    if (!text.trim()) throw new Error('请先粘贴报价 HTML。');
    if (text.length > 2_000_000) throw new Error('HTML 超过 200 万字符，请按分组分批导入。');
    // Never attach pasted nodes to the live page, and do not execute pasted content.
    const template = document.createElement('template');
    template.innerHTML = text;
    const content = template.content;
    const rows = [];
    const seen = new Set();
    let skipped = 0;
    function append(row) {
      if (!row) { skipped++; return; }
      const identity = JSON.stringify(row);
      if (seen.has(identity)) { skipped++; return; }
      seen.add(identity);
      rows.push(row);
      if (rows.length > 300) throw new Error('一次最多导入 300 条报价，请分批粘贴。');
    }
    listQuotes(content, defaults, append);
    for (const table of content.querySelectorAll('table')) {
      if (!groupedTable(table, defaults, append)) flatTable(table, defaults, append);
    }
    if (!rows.length) throw new Error('未识别到报价。请复制完整的模型列表或含表头的每百万 Token 定价表外部 HTML。');
    return { rows, skipped };
  }
  return { parse };
})();

function connectHtmlImport() {
  const form = byId('html-import-form');
  const code = byId('html-import-text');
  const status = byId('html-import-status');
  const button = byId('toggle-html-import');
  const panel = byId('html-import-panel');
  button.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    button.setAttribute('aria-expanded', String(!panel.hidden));
    const feedback = byId(panel.hidden ? 'quote-feedback' : 'quote-import-feedback');
    feedback.append(byId('quote-status'), byId('quote-count'));
    if (!panel.hidden) code.focus({ preventScroll: true });
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    try {
      const platform = byId('html-import-platform').value.trim();
      const group = byId('html-import-group').value.trim();
      const model = byId('html-import-model').value.trim();
      const ratioInput = byId('html-import-ratio');
      const ratio = ratioInput.value.normalize('NFKC').trim();
      ratioInput.removeAttribute('aria-invalid');
      if (ratio) {
        try { parseRatio(ratio); }
        catch (error) {
          ratioInput.setAttribute('aria-invalid', 'true');
          ratioInput.focus();
          throw error;
        }
      }
      const { rows, skipped } = HtmlQuotes.parse(code.value, { platform, group, model });
      for (const row of rows) {
        const notes = row.note ? [row.note] : [];
        if (row.starting.length) notes.push('带「起」的单价：' + fields.filter(field => row.starting.includes(field.id)).map(field => field.label).join('、') + '。请核对阶梯档。');
        if (row.mixed) notes.push('原行混用币种，价格已留空。');
        addQuote({ ...row, ratio: row.unit === 'credit' ? ratio : '', importNote: notes.join(' ') }, { active: false, imported: true });
      }
      render();
      code.value = '';
      const missingModel = rows.some(row => !row.model);
      const note = '已追加 ' + rows.length + ' 条报价' + (skipped ? '（跳过 ' + skipped + ' 条重复、非 Token 或无法识别的记录）' : '') + '。' +
        (missingModel ? '部分记录没有模型名，请在表中补齐。' : '请补齐空项、核对价格，再勾选对比。');
      message(status, note);
    } catch (error) { message(status, '未导入：' + error.message, true); }
  });
}
