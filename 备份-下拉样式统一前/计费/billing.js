'use strict';
const Billing = (() => {
  const fields = [
    { id: 'input', label: '输入价', hint: '输入用量，不含缓存创建和缓存读取' },
    { id: 'output', label: '输出价', hint: '输出总用量，不另加思考 Token' },
    { id: 'write', label: '缓存写', hint: '这次新写入缓存的 Token' },
    { id: 'read', label: '缓存读', hint: '这次命中缓存的 Token' }
  ];
  const scale = 10n ** 12n;
  const perMillion = scale * 1_000_000n;
  const maxCount = BigInt(Number.MAX_SAFE_INTEGER);
  const one = { n: 1n, d: 1n };
  const zero = { n: 0n, d: 1n };
  const group = value => value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const clean = value => value.normalize('NFKC').trim();
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

  const usagePowers = new Map([
    ['', 6n], ['token', 0n], ['tokens', 0n], ['个', 0n], ['k', 3n], ['m', 6n], ['b', 9n], ['t', 12n], ['p', 15n],
    ['千', 3n], ['万', 4n], ['十万', 5n], ['百万', 6n], ['千万', 7n], ['亿', 8n],
    ['十亿', 9n], ['百亿', 10n], ['千亿', 11n], ['万亿', 12n], ['十万亿', 13n],
    ['百万亿', 14n], ['千万亿', 15n]
  ]);
  const maxManualCount = 10n ** 24n - 1n;

  function parseMillions(value) {
    const text = clean(value).toLowerCase();
    if (!text) return null;
    const match = /^(?:(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d*))?|\.(\d+))\s*([a-z一-龥]*)$/.exec(text);
    if (!match || text.length > 48 || !usagePowers.has(match[4])) {
      throw new Error('请输入非负用量，如 983 Token、356K 或 2亿。无单位按百万计。');
    }
    const integer = (match[1] || '0').replace(/,/g, '');
    const fraction = match[2] ?? match[3] ?? '';
    // Plain values are in millions. Explicit suffixes describe absolute Token counts.
    const numerator = BigInt(integer + fraction) * 10n ** usagePowers.get(match[4]);
    const denominator = 10n ** BigInt(fraction.length);
    if (numerator % denominator) throw new Error('换算后不足整数个 Token，请减少小数位。');
    const tokens = numerator / denominator;
    if (tokens > maxManualCount) throw new Error('Token 数过大，请拆成多笔。');
    return tokens;
  }

  function millions(count) {
    if (count == null) return '';
    const decimal = (count % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
    return (count / 1_000_000n).toString() + (decimal ? '.' + decimal : '');
  }

  function parseDecimal(value) {
    const text = clean(value);
    if (!text) return null;
    if (!/^(?:\d{1,16}(?:\.\d{0,12})?|\.\d{1,12})$/.test(text)) {
      throw new Error('请填非负数字，不带货币符号，最多 12 位小数。');
    }
    const [integer, fraction = ''] = text.split('.');
    return BigInt(integer || '0') * scale + BigInt(fraction.padEnd(12, '0'));
  }

  function parseRatio(value) {
    const parts = clean(value).split(':');
    if (parts.length !== 2) throw new Error('请输入实付 : 到账，例如 1:1、1:2 或 67.8:10。');
    const [paid, credit] = parts.map(parseDecimal);
    if (!paid || !credit) throw new Error('比例两边都必须大于 0。');
    return { n: paid, d: credit };
  }

  function convertRecharge(value, rate, from) {
    const { n, d } = rate;
    const converted = from === 'paid' ? { n: value * d, d: scale * n } : { n: value * n, d: scale * d };
    const text = format(converted, { max: 12 }).replace(/,/g, '');
    return text.startsWith('<') ? '0' : text;
  }

  function validateQuote(data) {
    if (!record(data) || data.type !== 'quote' || data.version !== 1) {
      throw new Error('不是受支持的 Token 报价单（版本 1）。');
    }
    const { name, unit, ratio, prices } = data;
    if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('报价名称须为 1–100 个字符。');
    if (unit !== 'cny' && unit !== 'credit') throw new Error('计价币种无效。');
    if (!record(prices)) throw new Error('缺少单价表。');
    const values = Object.fromEntries(fields.map(({ id, label }) => {
      const value = prices[id];
      if (typeof value !== 'string' || value.length > 32) throw new Error(label + '单价须为文本，未知请留空。');
      try { parseDecimal(value); } catch (error) { throw new Error(label + '：' + error.message); }
      return [id, clean(value)];
    }));
    if (unit === 'credit') {
      if (typeof ratio !== 'string' || ratio.length > 64) throw new Error('缺少有效的充值比例。');
      parseRatio(ratio);
    }
    return { type: data.type, version: 1, name: name.trim(), unit, ratio: unit === 'credit' ? clean(ratio) : '', prices: values };
  }

  // Store amounts as exact fractions; only round when displaying them.
  function amount(units, rate) {
    if (units === 0n) return zero;
    return rate === null ? null : { n: units * rate.n, d: perMillion * rate.d };
  }

  function calculate(counts, prices, rate) {
    let sum = 0n;
    let complete = true;
    const rows = fields.map(({ id }) => {
      const count = counts[id];
      const price = prices[id];
      if (count === null || (count > 0n && price === null)) {
        complete = false;
        return { cost: null, reason: count === null ? '缺用量' : '缺单价' };
      }
      const units = count === 0n ? 0n : count * price;
      sum += units;
      const cost = amount(units, rate);
      return { cost, reason: cost === null ? '缺换算' : '' };
    });
    return { rows, native: complete ? amount(sum, one) : null, total: complete ? amount(sum, rate) : null };
  }

  function compare(a, b) {
    if (a === null || b === null) return null;
    const left = a.n * b.d;
    const right = b.n * a.d;
    if (left === right) return { cheaper: null };
    const difference = left < right ? right - left : left - right;
    return {
      cheaper: left < right ? 'A' : 'B',
      difference: { n: difference, d: a.d * b.d },
      savings: { n: difference * 100n, d: left > right ? left : right }
    };
  }

  function format(value, { prefix = '', suffix = '', min = 0, max = 8 } = {}) {
    if (value === null) return '—';
    const { n, d } = value;
    const power = 10n ** BigInt(max);
    const rounded = (n * power * 2n + d) / (d * 2n);
    if (n > 0n && rounded === 0n) return '<' + prefix + '0.' + '0'.repeat(max - 1) + '1' + suffix;
    const fraction = (rounded % power).toString().padStart(max, '0').replace(/0+$/, '').padEnd(min, '0');
    return prefix + group(rounded / power) + (fraction ? '.' + fraction : '') + suffix;
  }

  function jsonCount(object, key, required = false) {
    const value = has(object, key) ? object[key] : null;
    if (value === null && !required) return null;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(key + ' 必须是非负整数，且不能超出安全整数范围。');
    }
    return BigInt(value);
  }

  function jsonObject(object, key) {
    if (!has(object, key) || object[key] === null) return {};
    if (!record(object[key])) throw new Error(key + ' 应为 JSON 对象。');
    return object[key];
  }

  function openAIUsage(usage, kind, assumeZero, notes) {
    const inKey = (kind === 'chat' ? 'prompt' : 'input') + '_tokens';
    const outKey = (kind === 'chat' ? 'completion' : 'output') + '_tokens';
    const input = jsonCount(usage, inKey, true);
    const output = jsonCount(usage, outKey, true);
    const inputDetails = jsonObject(usage, inKey + '_details');
    const outputDetails = jsonObject(usage, outKey + '_details');
    const total = jsonCount(usage, 'total_tokens');
    const reasoning = jsonCount(outputDetails, 'reasoning_tokens');
    if ((total !== null && total !== input + output) || (reasoning !== null && reasoning > output)) {
      throw new Error('总用量或思考 Token 与输入/输出不一致。');
    }
    const writeKeys = ['cache_creation_tokens', 'cache_creation_input_tokens', 'cache_write_tokens', 'cache_write_input_tokens'];
    if ([usage, inputDetails].some(data => writeKeys.some(key => (jsonCount(data, key) ?? 0n) > 0n))) {
      throw new Error('发现独立的缓存写入明细，请按平台账单手填四类用量。');
    }
    if ([inputDetails, outputDetails].some(data => ['audio_tokens', 'image_tokens'].some(key => (jsonCount(data, key) ?? 0n) > 0n))) {
      throw new Error('发现单列的图片或音频用量，请按实际计费项分别试算。');
    }
    let read = jsonCount(inputDetails, 'cached_tokens');
    if (kind === 'chat') {
      const hit = jsonCount(usage, 'prompt_cache_hit_tokens');
      const miss = jsonCount(usage, 'prompt_cache_miss_tokens');
      if (hit !== null && read !== null && hit !== read) throw new Error('日志里两个缓存命中数不一致。');
      read ??= hit;
      if (miss !== null) {
        if (miss > input || (read !== null && read !== input - miss)) {
          throw new Error('缓存命中、未命中和总输入不一致。');
        }
        read ??= input - miss;
      }
    }
    if (read !== null && read > input) throw new Error('缓存读取数不能大于总输入。');
    if (read === null && (input === 0n || assumeZero)) {
      if (input > 0n) notes.push('按你的确认，未报告的缓存读取已填 0。');
      read = 0n;
    }
    if (read === null) {
      notes.push('日志只给出总输入 ' + group(input) + ' Token。普通输入和缓存读取已留空；请按账单拆分，或确认没命中缓存后，勾选上方选项再导入。');
    }
    notes.push('标准 OpenAI 用量不单列缓存创建，此处填 0；如果站点另收缓存写入，请按账单手填并核对普通输入。');
    return { input: read === null ? null : input - read, output, write: 0n, read };
  }

  function anthropicUsage(usage, assumeZero, notes) {
    const input = jsonCount(usage, 'input_tokens', true);
    const output = jsonCount(usage, 'output_tokens', true);
    let read = jsonCount(usage, 'cache_read_input_tokens');
    let write = jsonCount(usage, 'cache_creation_input_tokens');
    const creation = jsonObject(usage, 'cache_creation');
    let short = jsonCount(creation, 'ephemeral_5m_input_tokens');
    let long = jsonCount(creation, 'ephemeral_1h_input_tokens');
    if (short !== null || long !== null) {
      if (write !== null) {
        short ??= write - long;
        long ??= write - short;
        if (short < 0n || long < 0n || short + long !== write) {
          throw new Error('缓存创建总数与 5 分钟/1 小时明细不一致。');
        }
      } else {
        if (short === null || long === null) throw new Error('缓存创建明细不完整，请从账单核对后手填。');
        write = short + long;
      }
      if (short > 0n && long > 0n) {
        throw new Error('同一笔含两种缓存写入时长，请分别按各自单价计算；普通输入、输出和缓存读取只在其中一笔计入。');
      }
      if (long > 0n) notes.push('检测到 1 小时缓存写入，请确认报价的写入价适用 1 小时档。');
    }
    if (write !== null && write > maxCount) throw new Error('缓存创建总数过大，请拆成多笔。');
    if (read === null || write === null) {
      if (assumeZero) {
        notes.push('按你的确认，未报告的缓存用量已填 0。');
        read ??= 0n;
        write ??= 0n;
      } else {
        notes.push('未报告的缓存用量已留空，请从账单补填。');
      }
    }
    return { input, output, write, read };
  }

  function importUsage(text, chosen = 'auto', assumeZero = false) {
    if (text.length > 1_000_000) throw new Error('请粘贴不超过 100 万字符的用量 JSON。');
    let root;
    try { root = JSON.parse(text); } catch {
      throw new Error('无法读取 JSON。请只粘贴完整 JSON，不带 Markdown 围栏或 data: 前缀。');
    }
    if (!record(root)) throw new Error('请粘贴一个包含用量的 JSON 对象。');
    const event = typeof root.type === 'string' ? root.type : '';
    if (root.object === 'chat.completion.chunk' || /^(?:message_|content_block_|response\.)/.test(event) || ['queued', 'in_progress'].includes(root.status)) {
      throw new Error('这是流式片段或未结束的响应，请单独粘贴最终的 usage 对象。');
    }
    const usage = has(root, 'usage') ? root.usage : root;
    if (!record(usage)) throw new Error('没有找到完整的 usage 对象。');
    const chat = root.object === 'chat.completion' || ['prompt_tokens', 'completion_tokens', 'prompt_tokens_details'].some(key => has(usage, key));
    const responses = root.object === 'response' || ['input_tokens_details', 'output_tokens_details'].some(key => has(usage, key));
    const anthropic = root.type === 'message' || ['cache_read_input_tokens', 'cache_creation_input_tokens', 'cache_creation'].some(key => has(usage, key));
    if (Number(chat) + Number(responses) + Number(anthropic) > 1 || (chat && ['input_tokens', 'output_tokens'].some(key => has(usage, key)))) {
      throw new Error('日志混用了不同接口的字段，请核对实际账单后手填或粘贴标准用量。');
    }
    const detected = chat ? 'chat' : responses ? 'responses' : anthropic ? 'anthropic' : null;
    if (detected && chosen !== 'auto' && detected !== chosen) throw new Error('所选接口格式与日志字段不一致。');
    const kind = chosen === 'auto' ? detected : chosen;
    if (!kind && has(usage, 'input_tokens') && has(usage, 'output_tokens')) {
      throw new Error('只有输入和输出字段，无法自动区分。请手选 OpenAI Responses 或 Anthropic Messages。');
    }
    if (!['chat', 'responses', 'anthropic'].includes(kind)) throw new Error('无法识别用量，请检查 JSON 或手填。');
    const notes = [];
    const counts = kind === 'anthropic' ? anthropicUsage(usage, assumeZero, notes) : openAIUsage(usage, kind, assumeZero, notes);
    return { kind, counts, notes };
  }

  return { fields, group, one, parseMillions, millions, parseDecimal, parseRatio, convertRecharge, validateQuote, calculate, compare, format, importUsage };
})();
