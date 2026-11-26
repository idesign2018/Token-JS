'use strict';
const { fields, one, parseMillions, millions, parseDecimal, parseRatio, convertRecharge, validateQuote, calculate, compare, format, importUsage } = Billing;
const byId = id => document.getElementById(id);
const money = value => format(value, { prefix: '¥', min: 2 });

function element(tag, text = '', className = '') {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function makeUsageFields(parent) {
  return Object.fromEntries(fields.map(({ id, label, hint }) => {
    const wrapper = element('div', '', 'field inline-field');
    const caption = element('label', label);
    const control = element('input');
    const unit = element('span', '/ 1M Tokens', 'unit');
    control.id = 'usage-' + id;
    caption.htmlFor = control.id;
    control.type = 'text';
    control.maxLength = 48;
    control.autocomplete = 'off';
    control.spellcheck = false;
    control.value = '1';
    control.placeholder = '例：1.3 或 356K';
    control.title = hint + '。无单位按百万计；支持 K、M、B、T、P 或千、百万、亿、万亿、百万亿、千万亿。';
    unit.id = control.id + '-unit';
    control.setAttribute('aria-describedby', unit.id);
    const decorated = element('div', '', 'money-input');
    const mark = element('span', '$', 'money-mark');
    mark.setAttribute('aria-hidden', 'true');
    decorated.append(control, mark);
    wrapper.append(caption, decorated, unit);
    parent.append(wrapper);
    return [id, control];
  }));
}

function message(node, text, error = false) {
  if (node.textContent !== text) node.textContent = text;
  node.classList.toggle('error', error);
  node.hidden = !text;
}

function readField(control, parse, label, errors) {
  try {
    const value = parse(control.value);
    control.removeAttribute('aria-invalid');
    return value;
  } catch (error) {
    control.setAttribute('aria-invalid', 'true');
    errors.push(label + '：' + error.message);
    return null;
  }
}
