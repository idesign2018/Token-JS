'use strict';
const GenericHtmlQuotes = (() => {
  const clean = value => (value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const text = node => clean(node?.textContent);
  const aliases = {
    input: /^(?:输入(?:提示词)?|提示词|提示|input|prompt)(?:\s*(?:token|tokens|价格|单价|费用|价|price|pricing|cost|rate))*$/i,
    output: /^(?:输出|补全|生成|output|completion)(?:\s*(?:token|tokens|价格|单价|费用|价|price|pricing|cost|rate))*$/i,
    read: /^(?:缓存\s*(?:读取|读|命中)|读取缓存|命中缓存|cached\s*(?:input|prompt|tokens?)|cache\s*[- ]?\s*(?:read|reading|hit)|read\s+cache|hit|read|读取|读|命中)(?:\s*(?:tokens?|价格|单价|费用|价|price|pricing|cost|rate))*$/i,
    write: /^(?:缓存\s*(?:写入|写|创建)|写入缓存|创建缓存|cache\s*[- ]?\s*(?:write|writing|creation|create|store)|write\s+cache|write|写入|写|创建)(?:\s*(?:tokens?|价格|单价|费用|价|price|pricing|cost|rate))*$/i
  };
  const names = { input: '输入', output: '输出', read: '缓存读', write: '缓存写', cache: '缓存' };
  const modelId = /^(?:模型\s*(?:ID|标识)|model\s*(?:id|identifier))$/i;
  const modelName = /^(?:模型(?:\s*(?:名|名称|型号|版本(?:号)?))?|model(?:\s+(?:name|version|variant|type))?)(?:(?:\s|[+、/·_-])*(?:模型|型号|版本(?:号)?|variant|version|name|type))*$/i;
  const variant = /^(?:型号|variant|model type)$/i;
  const version = /^(?:版本(?:号)?|version)$/i;
  const groupLabel = /^(?:分组|组别|渠道|group|channel)$/i;
  const cacheLabel = /^(?:缓存(?:价格|单价|价|未命中)?|cache(?:[- ]+(?:price|pricing|cost|miss))?)$/i;
  const currencyPattern = /US\$|\$|¥|\b(?:USD|CNY|RMB)\b|人民币|美元|元/gi;
  const unitPattern = /(?:\/\s*|\bper\s+|每\s*)?(?:1\s*[MK]\s*(?:tokens?\b|令牌)?|1\s*[, ]?000\s*[, ]?000\s*(?:tokens?\b|令牌)|1\s*[, ]?000\s*(?:tokens?\b|令牌)|(?:1\s*)?(?:百万|千)\s*(?:tokens?\b|令牌)?|(?:1\s*)?(?:tokens?\b|令牌))/gi;
  const nonToken = /(?:按\s*(?:图|次|张|秒|分钟|请求|字符)|\/\s*(?:张|次|秒|分钟|请求|字符)|(?:\/|\bper\s+)\s*(?:\d+\s*)?(?:images?|requests?|calls?|characters?|seconds?|minutes?)\b)/i;
  const trimPunctuation = value => clean(value.replace(/^[\s():：,;，；/|·-]+|[\s():：,;，；/|·-]+$/g, ''));
  const currencyOf = value => /^(?:¥|CNY|RMB|人民币|元)$/i.test(value) ? 'cny' : 'credit';
  const stripCurrency = value => value.replace(currencyPattern, ' ');
  const tokenWord = /tokens?\b|令牌/i;
  const explicitOne = /^(?:\/|per\s|每)|^1\s*(?:tokens?\b|令牌)/i;

  function describe(value, allowBare = false) {
    const currencies = new Set(Array.from(value.matchAll(currencyPattern), match => currencyOf(match[0])));
    const scales = new Set();
    const source = stripCurrency(value);
    for (const match of source.matchAll(unitPattern)) {
      const part = clean(match[0]);
      const before = source[match.index - 1] || '';
      const after = source[match.index + match[0].length] || '';
      if (/[\da-z_.]/i.test(before) && !part.startsWith('/') || /[\da-z_.]/i.test(after)) continue;
      if (!tokenWord.test(part) && !allowBare) continue;
      const key = part.replace(/[,\s]/g, '');
      if (/1m|百万|1000000/i.test(key)) scales.add(0);
      else if (/1k|千|1000/i.test(key)) scales.add(3);
      else if (explicitOne.test(part)) scales.add(6);
    }
    return { scales, currencies, invalid: nonToken.test(value) };
  }

  function field(value) {
    const raw = clean(value);
    if (raw.length > 100) return '';
    const label = trimPunctuation(stripCurrency(raw).replace(unitPattern, part => {
      // A bare "token(s)" may be part of an alias, e.g. "Cached tokens".
      return /\d|百万|千|\/|\bper\s|每/i.test(part) ? ' ' : part;
    }));
    const entry = Object.entries(aliases).find(([, pattern]) => pattern.test(label));
    return entry?.[0] || (cacheLabel.test(label) ? 'cache' : '');
  }

  function context(value) {
    const raw = clean(value);
    if (raw.length > 160) return null;
    const label = trimPunctuation(stripCurrency(raw).replace(unitPattern, ' '));
    if (/^(?:(?:所有|均|统一|全部|单位|计费|每|模型|价格|定价|报价|分组|标准|币种|货币|按|为|以|计|的|使用|显示|以此为准|[\s()：:，,。；;、/·-])+|(?:(?:prices?|pricing|rates?|costs?|currency|billing|unit|all|are|in|model|token|denominated|per|for)(?:\b|$)|[\s()：:，,。；;、/·-])+)?$/i.test(label)) return describe(raw, true);
    return null;
  }

  function price(raw) {
    const value = clean(raw);
    if (!value || value.length > 120 || nonToken.test(value)) return null;
    const match = /^(起(?:价)?\s*|from\s+)?((?:US\$|\$|¥|USD|CNY|RMB|人民币|美元)\s*)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)(.*)$/i.exec(value);
    if (!match) return null;
    const tail = match[4].replace(/\s*起(?:价)?$/, '').trim();
    const label = trimPunctuation(stripCurrency(tail).replace(unitPattern, ' '));
    if (label) return null;
    // Disallow a glued magnitude from the amount itself: "1M" is not a price.
    if (/^[a-z\d.,]/i.test(match[4]) && !/^(?:tokens?\b|USD\b|CNY\b|RMB\b)/i.test(match[4])) return null;
    const amount = match[3].replace(/,/g, '');
    try { parseDecimal(amount); } catch { return null; }
    return { amount, starting: Boolean(match[1] || /起(?:价)?$/.test(value)), meta: describe(`${match[2] || ''} ${tail}`, true), raw: value };
  }

  function shifted(amount, power) {
    if (!power) return amount;
    const [whole, decimal = ''] = amount.split('.');
    const integer = (whole + decimal.slice(0, power).padEnd(power, '0')).replace(/^0+(?=\d)/, '');
    const fraction = decimal.slice(power).replace(/0+$/, '');
    return integer + (fraction ? '.' + fraction : '');
  }

  const union = (items, key) => new Set(items.flatMap(item => item ? [...item[key]] : []));
  function measure(entry, metadata, shared) {
    const detailed = [entry.meta, ...metadata];
    if (detailed.some(item => item?.invalid)) return { error: '不是 Token 单价' };
    const scales = union(detailed, 'scales');
    const currencies = union(detailed, 'currencies');
    const sharedScales = union(shared, 'scales');
    const sharedCurrencies = union(shared, 'currencies');
    const units = scales.size ? scales : sharedScales;
    const money = currencies.size ? currencies : sharedCurrencies;
    if (units.size !== 1) return { error: units.size ? '计价单位冲突' : '缺少明确的 Token 计价数量' };
    if (money.size > 1) return { error: '币种冲突' };
    const value = shifted(entry.amount, units.values().next().value);
    try { parseDecimal(value); } catch { return { error: '换算后的单价超出支持范围' }; }
    return { value, unit: money.values().next().value || '', starting: entry.starting };
  }

  function cacheEntries(raw, metadata) {
    if (raw.length > 240) return [];
    const labels = Array.from(raw.matchAll(/(?:^|[\s;,，；|])((?:缓存\s*)?(?:读取|读|命中|写入|写|创建)|(?:cache\s*[- ]?\s*)?(?:read|hit|write|creation)\b)\s*[:：]?\s*/gi));
    if (labels[0]?.index !== 0) return [];
    const entries = labels.map((match, index) => [field(match[1]),
      raw.slice(match.index + match[0].length, labels[index + 1]?.index ?? raw.length).trim(), metadata]);
    return entries.every(([id, value]) => (id === 'read' || id === 'write') && price(value)) ? entries : [];
  }

  function record(defaults, model, group, entries, shared) {
    if (!entries.length) return null;
    const amounts = new Map();
    const issues = [];
    const expanded = entries.flatMap(([id, raw, metadata]) => {
      const parts = id === 'cache' ? cacheEntries(raw, metadata) : [];
      return parts.length ? parts : [[id, raw, metadata]];
    });
    for (const [id, raw, metadata] of expanded) {
      if (nonToken.test(raw) || metadata.some(item => item?.invalid)) continue;
      if (id === 'cache') { if (/\d/.test(raw)) issues.push(`缓存未区分读写（${raw.slice(0, 80)}）`); continue; }
      const candidate = price(raw);
      if (!candidate) { if (raw && /\d/.test(raw)) issues.push(`${names[id]}未识别（${raw.slice(0, 80)}）`); continue; }
      const rate = measure(candidate, metadata, shared);
      if (rate.error) { issues.push(`${names[id]}${rate.error}（${candidate.raw.slice(0, 80)}）`); continue; }
      if (!amounts.has(id)) amounts.set(id, rate);
      else {
        const other = amounts.get(id);
        if (other && (parseDecimal(other.value) !== parseDecimal(rate.value) || other.unit !== rate.unit || other.starting !== rate.starting)) {
          amounts.set(id, null);
          issues.push(`${names[id]}有多种价格，未选档`);
        }
      }
    }
    if (!amounts.size && !issues.length) return null;
    const values = [...amounts.values()].filter(Boolean);
    const currencies = new Set(values.filter(rate => rate.unit).map(rate => rate.unit));
    const mixed = currencies.size > 1;
    const uncertain = values.some(rate => !rate.unit);
    if (uncertain && !mixed) issues.push('部分或全部价格未标币种，请在计费栏确认币种');
    const prices = Object.fromEntries(Object.keys(aliases).map(id => [id, mixed ? '' : amounts.get(id)?.value || '']));
    const starting = mixed ? [] : [...amounts].filter(([, rate]) => rate?.starting).map(([id]) => id);
    return { platform: defaults.platform || '', model: (model.length <= 100 ? model : '') || defaults.model || '',
      group, unit: !mixed && !uncertain ? currencies.values().next().value || '' : '', prices, ratio: '', starting, mixed,
      note: issues.length ? '请核对：' + [...new Set(issues)].slice(0, 8).join('；') + '。' : '' };
  }

  function tableHeaders(table) {
    const rows = table.tHead ? [...table.tHead.rows] : [];
    if (!rows.length && table.rows[0]) {
      rows.push(table.rows[0]);
      for (let index = 1; index < Math.min(3, table.rows.length); index++) {
        const row = table.rows[index];
        if (![...row.cells].length || ![...row.cells].every(cell => cell.tagName === 'TH' && cell.scope !== 'row')) break;
        rows.push(row);
      }
    }
    if (!rows.length || rows.length > 6) return null;
    const grid = rows.map(() => []);
    for (const [r, row] of rows.entries()) {
      let c = 0;
      for (const cell of row.cells) {
        while (grid[r][c] != null) c++;
        const height = cell.rowSpan || rows.length - r;
        if (c + cell.colSpan > 100 || r + height > rows.length) return null;
        for (let y = r; y < r + height; y++) for (let x = c; x < c + cell.colSpan; x++) {
          if (grid[y][x] != null) return null;
          grid[y][x] = cell;
        }
        c += cell.colSpan;
      }
    }
    return { rows, columns: grid.at(-1).map((_, column) => [...new Set(grid.map(row => row[column]).filter(Boolean))].map(text)) };
  }

  function tables(table, defaults, append, covered, excluded) {
    const header = tableHeaders(table);
    if (!header) return;
    const { rows, columns } = header;
    const leaf = columns.map(path => path.at(-1) || '');
    const idIndex = leaf.findIndex(value => modelId.test(value));
    const modelIndex = idIndex >= 0 ? idIndex : leaf.findIndex(value => modelName.test(value));
    const extras = leaf.map((value, index) => index !== modelIndex && (variant.test(value) || version.test(value)) ? index : -1).filter(index => index >= 0);
    const groupIndex = leaf.findIndex(value => groupLabel.test(value));
    const prices = columns.map(path => {
      const id = field(path.at(-1)) || field(path.join(' '));
      return id ? [id, path.map(value => describe(value, true))] : null;
    });
    if (!prices.some(Boolean) || (modelIndex < 0 && !defaults.model && prices.filter(Boolean).length < 2)) return;
    const previous = table.previousElementSibling;
    const shared = [context(text(table.caption)), context(table.getAttribute('aria-label')),
      previous?.matches('h1,h2,h3,h4,h5,h6,p,small') ? context(text(previous)) : null];
    const modelFrom = cell => clean(cell?.querySelector('[data-model-id]')?.getAttribute('data-model-id') ||
      cell?.querySelector('button[aria-label^="复制模型 ID "]')?.getAttribute('aria-label').slice('复制模型 ID '.length) || text(cell));
    for (const row of table.rows) {
      const precise = covered.get(row);
      if (excluded.has(row) || rows.includes(row) || row.cells.length !== columns.length || [...row.cells].some(cell => cell.colSpan !== 1 || cell.rowSpan !== 1)) continue;
      const name = modelFrom(row.cells[modelIndex]);
      const model = idIndex >= 0 || !name ? name : [name, ...extras.map(index => text(row.cells[index])).filter(extra => extra && extra !== name)].join(' ');
      const ownGroup = text(row.cells[groupIndex]);
      const group = [...new Set([defaults.group, ownGroup].filter(Boolean))].join(' · ').slice(0, 100);
      const entries = prices.flatMap((entry, index) => entry ? [[entry[0], text(row.cells[index]), entry[1]]] : []);
      const generic = record(defaults, model, group, entries, shared);
      if (!precise) { if (generic) append(generic, row); continue; }
      // Only upgrade an existing match if it adds verified, same-currency fields without changing old ones.
      if (generic && !precise.mixed && generic.unit && generic.unit === precise.unit &&
          Object.entries(precise.prices).every(([id, value]) => !value || generic.prices[id] && parseDecimal(value) === parseDecimal(generic.prices[id])) &&
          Object.entries(generic.prices).some(([id, value]) => value && !precise.prices[id])) {
        precise.prices = { ...generic.prices, ...Object.fromEntries(Object.entries(precise.prices).filter(([, value]) => value)) };
        precise.starting = [...new Set([...precise.starting, ...generic.starting])];
      }
    }
  }

  const markerSelector = '[data-model],[data-model-id],h2,h3,h4,h5,h6,dt,[class~="model-name"],[class~="model-id"]';
  const detailSelector = 'dt,li,p,div,span,strong,b,label,small';
  const modelPair = /^(?:模型(?:\s*(?:ID|名称|名|型号|版本(?:号)?))?|model(?:\s+(?:id|name|variant|version))?)\s*[:：]\s*(.+)$/i;
  const plausibleHeading = value => value.length > 0 && value.length <= 100 && !field(value) && !context(value) &&
    !/^(?:定价|报价|价格|价格表|pricing|rates?|model pricing|models?|标准价)$/i.test(value) &&
    (/[\d/:._-]/.test(value) || /^(?:claude|gemini|gpt|deepseek|qwen|mistral|llama|grok|kimi|doubao|通义|豆包)\s/i.test(value));

  function markerModel(node) {
    const value = text(node);
    const attribute = clean(node.getAttribute('data-model-id') || node.getAttribute('data-model'));
    if (attribute) return attribute;
    if (node.matches('dt') && (modelId.test(value) || modelName.test(value))) return text(node.nextElementSibling?.matches('dd') ? node.nextElementSibling : null);
    return modelPair.exec(value)?.[1] || (node.matches('.model-name,.model-id') || plausibleHeading(value) ? value : '');
  }

  function card(card, defaults, model) {
    if (card.textContent.length > 5000) return null;
    const entries = [];
    const shared = [];
    const used = new Map();
    const add = (id, name, value) => {
      if (!value || !price(value) && !/\d/.test(value)) return;
      const key = JSON.stringify([id, name, value]);
      if (used.has(key)) return;
      used.set(key, true);
      entries.push([id, value, [describe(name, true)]]);
    };
    for (const node of card.querySelectorAll(detailSelector)) {
      if (node.closest('table,script,style,template,svg,[hidden]')) continue;
      const raw = text(node);
      if (!raw || raw.length > 160) continue;
      const id = field(raw);
      if (id && node.nextElementSibling && (!node.matches('dt') || node.nextElementSibling.matches('dd'))) {
        const next = text(node.nextElementSibling);
        if (price(next) || id === 'cache' && cacheEntries(next, []).length || nonToken.test(next) || /^\s*(?:[$¥]|USD|CNY)?\s*\d+[.\d]*\s*[-–~至]/i.test(next)) add(id, raw, next);
      }
      const pair = /^(.+?)\s*[:：]\s*(.+)$/.exec(raw);
      if (pair && field(pair[1])) { add(field(pair[1]), pair[1], pair[2]); continue; }
      let inline = false;
      for (const gap of raw.matchAll(/\s+/g)) {
        const label = raw.slice(0, gap.index);
        const value = raw.slice(gap.index + gap[0].length);
        const key = field(label);
        if (!key || !(price(value) || key === 'cache' && cacheEntries(value, []).length)) continue;
        add(key, label, value);
        inline = true;
        break;
      }
      if (!node.children.length && !id && !inline) { const metadata = context(raw); if (metadata) shared.push(metadata); }
    }
    return record(defaults, model, defaults.group || '', entries, shared);
  }

  function cards(content, defaults, append) {
    const claimed = new Set();
    const markers = new Map();
    for (const marker of content.querySelectorAll(markerSelector)) {
      if (marker.closest('table,script,style,template,svg,[hidden],ul[aria-label="模型列表"]')) continue;
      const model = markerModel(marker);
      if (model && model.length <= 100) markers.set(marker, model);
    }
    const membership = new Map();
    for (const [marker, model] of markers) {
      let node = marker;
      for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
        if (!membership.has(node)) membership.set(node, new Set());
        membership.get(node).add(model);
      }
    }
    for (const [marker, model] of markers) {
      let node = marker;
      let candidate = null;
      let block = null;
      for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
        if (claimed.has(node) || membership.get(node)?.size !== 1 || node.matches('main,body')) break;
        // Inspect the local card, not other models or independent semantic cards in an ancestor.
        if (depth && (node.children.length > 60 || node.textContent.length > 5000)) break;
        const current = card(node, defaults, model);
        if (current) { candidate = current; block = node; }
        if (node.matches('article,li,[data-model],[data-model-id]') && current) break;
      }
      if (candidate && ![...claimed].some(other => other.contains(block) || block.contains(other))) { claimed.add(block); append(candidate); }
    }
  }

  return { tables, cards, card };
})();
