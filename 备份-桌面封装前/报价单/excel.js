'use strict';
const bridgeToken = document.querySelector('meta[name="billing-bridge"]').content;
const excelPath = byId('excel-path');
const excelName = byId('excel-name');
const scanButton = byId('scan-excel');
const saveButton = byId('save-excel');
const appendButton = byId('append-excel');
const folderButton = byId('open-folder');
let scanTimer;
let scanRequest;
let scanVersion = 0;
let matchVersion = 0;
let matchTimer;
let matchedFile = null;
let writingWorkbook = false;

function syncWriteButtons() {
  const connected = Boolean(bridgeToken);
  saveButton.disabled = !connected || writingWorkbook;
  appendButton.disabled = !connected || writingWorkbook || !matchedFile;
  appendButton.title = matchedFile ? '追加到「' + matchedFile + '」，不重复写入完全相同的报价' : '发现同名 Excel 文件后可追加报价';
}

function scheduleMatch(delay = 0) {
  clearTimeout(matchTimer);
  const version = ++matchVersion;
  const path = excelPath.value.trim();
  const filename = excelName.value.trim();
  matchedFile = null;
  syncWriteButtons();
  if (!bridgeToken || !filename) return;
  matchTimer = setTimeout(async () => {
    try {
      const result = await requestWorkbook('match', { path, filename });
      if (version !== matchVersion) return;
      matchedFile = result.filename;
      syncWriteButtons();
    } catch { /* Keep append disabled while the target is unavailable. */ }
  }, delay);
}

function quoteStatus(text, error = false) {
  message(byId('quote-status'), text, error);
}

async function requestWorkbook(endpoint, body, signal) {
  const response = await fetch('/api/' + endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Billing-Token': bridgeToken },
    body: JSON.stringify(body), signal, cache: 'no-store'
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '本地 Excel 服务请求失败。');
  return result;
}

function invalidateScan() {
  clearTimeout(scanTimer);
  scanRequest?.abort();
  scanVersion++;
}

async function scanWorkbooks({ quiet = false, afterSave = false } = {}) {
  invalidateScan();
  scheduleMatch();
  const version = scanVersion;
  const request = new AbortController();
  scanRequest = request;
  if (!quiet) quoteStatus('正在读取 Excel 报价…');
  try {
    const result = await requestWorkbook('scan', { path: excelPath.value.trim() }, request.signal);
    if (version !== scanVersion) return;
    refreshCatalog(result.rows, result.systemRows);
    const warnings = byId('scan-warnings');
    warnings.replaceChildren(...result.warnings.map(warning => element('li', warning)));
    byId('scan-details').hidden = !warnings.childElementCount;
    byId('scan-summary').textContent = '未导入的文件或数据（' + warnings.childElementCount + ' 条提示）';
    excelPath.title = result.path;
    if (!excelPath.value.trim()) excelPath.placeholder = result.path;
    if (afterSave) return;
    const note = '已读取 ' + result.files + ' 个 Excel 文件，载入 ' + result.rows.length + ' 条报价。';
    quoteStatus(note);
  } catch (error) {
    if (version !== scanVersion || error.name === 'AbortError') return;
    if (!afterSave) {
      refreshCatalog();
      byId('scan-details').hidden = true;
      quoteStatus('未读取 Excel：' + error.message, true);
    }
  }
}

function connectWorkbookControls() {
  byId('bridge-notice').hidden = Boolean(bridgeToken);
  for (const control of [excelPath, excelName, scanButton, saveButton, folderButton]) control.disabled = !bridgeToken;
  if (bridgeToken) {
    excelPath.addEventListener('input', () => {
      invalidateScan();
      scheduleMatch(350);
      // Pending results from an old path must not replace the new catalog.
      quoteStatus('文件夹路径变更后将自动读取。');
      scanTimer = setTimeout(() => scanWorkbooks(), 650);
    });
    excelPath.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); scanWorkbooks(); }
    });
    excelName.addEventListener('input', () => scheduleMatch(250));
    excelName.addEventListener('change', () => scheduleMatch());
    scanButton.addEventListener('click', () => scanWorkbooks());
    folderButton.addEventListener('click', async () => {
      folderButton.disabled = true;
      try {
        const result = await requestWorkbook('open-folder', {});
        folderButton.title = '在 Windows 资源管理器中打开：' + result.path;
      } catch (error) { quoteStatus('未打开文件夹：' + error.message, true); }
      finally { folderButton.disabled = false; }
    });
    async function writeWorkbook(append) {
      if (writingWorkbook || (append && !matchedFile)) return;
      const label = append ? '追加' : '导出';
      const path = excelPath.value.trim();
      const filename = excelName.value.trim();
      writingWorkbook = true;
      syncWriteButtons();
      try {
        const rows = exportRows();
        const submittedEntries = append ? [...quoteEntries] : [];
        quoteStatus('正在' + label + ' Excel…');
        const result = await requestWorkbook(append ? 'append' : 'save', { path, filename, rows });
        let cleared = false;
        if (append && submittedEntries.length === quoteEntries.length && submittedEntries.every((entry, index) => entry === quoteEntries[index])) {
          // Do not discard edits or new rows made while the request was running.
          let unchanged = false;
          try { unchanged = JSON.stringify(exportRows()) === JSON.stringify(rows); } catch { /* A draft changed. */ }
          if (unchanged) {
            resetQuoteTable();
            message(byId('html-import-status'), '');
            cleared = true;
          }
        }
        if (path === excelPath.value.trim()) await scanWorkbooks({ quiet: true, afterSave: true });
        quoteStatus(append ? '已向「' + result.filename + '」追加 ' + result.added + ' 条报价，跳过 ' + result.skipped + ' 条重复报价。' + (cleared ? ' 报价表已清空。' : ' 保留当前表格的改动。')
          : '已导出「' + result.filename + '」至 ' + result.path + '。');
      } catch (error) { quoteStatus('未' + label + ' Excel：' + error.message, true); }
      finally { writingWorkbook = false; scheduleMatch(); }
    }
    saveButton.addEventListener('click', () => writeWorkbook(false));
    appendButton.addEventListener('click', () => writeWorkbook(true));
    scanWorkbooks({ quiet: true });
  }
}
