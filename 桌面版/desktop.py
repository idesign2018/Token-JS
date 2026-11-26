"""Windows desktop entry for the offline Token calculator."""

import argparse
import ctypes
from ctypes import wintypes
import importlib.util
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from threading import Event, Thread
import traceback

import webview


TITLE = 'Token 实际计费工具'
FROZEN = getattr(sys, 'frozen', False)
ASSETS = Path(sys._MEIPASS) / 'app' if FROZEN else Path(__file__).resolve().parent.parent
HOME = Path(sys.executable).resolve().parent if FROZEN else ASSETS


def load_bridge(directory):
    path = ASSETS / '本地服务' / 'bridge.py'
    spec = importlib.util.spec_from_file_location('_billing_desktop_bridge', path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    module.default_quote_directory = lambda: default_folder(module, directory)
    module.SYSTEM_WORKBOOK = directory / '报价单' / '系统报价单.xlsx'
    return module


def default_folder(bridge, directory):
    parent = bridge.local_directory(str(directory))
    target = parent / '报价单文件'
    target.mkdir(exist_ok=True)
    return bridge.local_directory(str(target))


def desktop_error(message):
    ctypes.windll.user32.MessageBoxW(None, str(message), TITLE, 0x10)


class MonitorInfo(ctypes.Structure):
    _fields_ = [('cbSize', wintypes.DWORD), ('rcMonitor', wintypes.RECT),
                ('rcWork', wintypes.RECT), ('dwFlags', wintypes.DWORD)]


class DesktopApi:
    def __init__(self):
        self._window = None

    def fit_height(self, css_height, viewport_height):
        if not all(type(value) in (int, float) and 0 < value < 100_000_000
                   for value in (css_height, viewport_height)):
            return
        native = self._window.native if self._window else None
        if native is None:
            return
        hwnd = wintypes.HWND(native.Handle.ToInt64())
        user = ctypes.windll.user32
        user.MonitorFromWindow.restype = wintypes.HMONITOR
        user.GetMonitorInfoW.argtypes = (wintypes.HMONITOR, ctypes.POINTER(MonitorInfo))
        monitor = user.MonitorFromWindow(hwnd, 2)
        info = MonitorInfo(ctypes.sizeof(MonitorInfo))
        rect, client = wintypes.RECT(), wintypes.RECT()
        if (not monitor or not user.GetMonitorInfoW(monitor, ctypes.byref(info)) or user.IsZoomed(hwnd)
                or user.IsIconic(hwnd) or not user.GetWindowRect(hwnd, ctypes.byref(rect))
                or not user.GetClientRect(hwnd, ctypes.byref(client))):
            return
        current_height = rect.bottom - rect.top
        frame = current_height - client.bottom
        scale = client.bottom / viewport_height
        target = min(info.rcWork.bottom - info.rcWork.top, max(round(285 * scale), round(css_height * scale) + frame))
        top = max(info.rcWork.top, min(rect.top, info.rcWork.bottom - target))
        if abs(target - current_height) > 2 or top != rect.top:
            flags = 0x0004 | 0x0010 | 0x4000  # No stacking/focus change; dispatch to window thread.
            user.SetWindowPos(hwnd, None, rect.left, top, rect.right - rect.left, target, flags)


def fit_window(window):
    window.evaluate_js(r'''(() => {
      document.documentElement.classList.add('desktop-mode');
      const main = document.querySelector('main');
      if (!main || window.billingFitAttached) return;
      window.billingFitAttached = true;
      let timer;
      const fit = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          window.pywebview.api.fit_height(Math.ceil(main.getBoundingClientRect().height), window.innerHeight);
        }, 45);
      };
      new ResizeObserver(fit).observe(main);
      window.addEventListener('resize', fit);
      fit();
    })()''')


def verify_window(window, callback):
    # Exercise real WebView2, JavaScript and the authenticated Excel API.
    return window.evaluate_js(r'''new Promise(async resolve => {
      try {
        if (typeof requestWorkbook !== 'function' || !document.querySelector('#quote-search-trigger')) throw Error('主界面未初始化');
        const initial = await requestWorkbook('scan', {path:''});
        if (initial.files !== 0 || initial.systemRows.length || catalog.size || !initial.path.endsWith('报价单文件')) throw Error('报价目录异常');
        const row = {platform:'测试平台', model:'desktop-test', group:'', unit:'cny', ratio:'', prices:{input:'1',output:'2',read:'0',write:'0'}};
        const saved = await requestWorkbook('save', {path:'',filename:'便携测试',rows:[row]});
        const appended = await requestWorkbook('append', {path:'',filename:saved.filename,rows:[row,{...row,model:'desktop-append'}]});
        const loaded = await requestWorkbook('scan', {path:''});
        if (appended.added !== 1 || loaded.rows.length !== 2) throw Error('Excel 回读异常');
        refreshCatalog(loaded.rows, []);
        document.querySelector('#quote-search-trigger').click();
        const input = document.querySelector('#quote-search-input');
        input.value = 'desktop-append';
        input.dispatchEvent(new Event('input'));
        const hit = document.querySelector('.quote-search-option');
        if (!hit || !hit.textContent.includes('desktop-append')) throw Error('桌面搜索异常');
        hit.click();
        if (quoteEntries.length !== 1 || !document.querySelector('#total').textContent.includes('¥3.00')) throw Error('桌面计费异常');
        resolve(JSON.stringify({ok:true, directory:loaded.path, filename:saved.filename}));
      } catch (e) { resolve(JSON.stringify({ok:false, error:String(e)})); }
    })''', callback)


def run_window(directory, report=None):
    from webview.platforms import winforms
    if winforms.renderer != 'edgechromium':
        raise RuntimeError('未检测到 Microsoft Edge WebView2 Runtime。请安装 Microsoft WebView2 运行时后重试。')
    bridge = load_bridge(directory)
    started = Event()
    with bridge.Bridge() as server:
        url = server.origin + '/'
        worker = Thread(target=server.serve_forever, daemon=True, kwargs={'poll_interval': .15})
        worker.start()
        try:
            api = DesktopApi()
            window = webview.create_window(TITLE, url=url, width=1360, height=650, min_size=(640, 285),
                                           js_api=api, background_color='#eff2ef', hidden=report is not None)
            api._window = window
            window.events.loaded += lambda: fit_window(window)
            if report is not None:
                def self_test():
                    if started.is_set():
                        return
                    started.set()
                    def finish(value):
                        report.write_text(value, encoding='utf-8')
                        window.destroy()
                    try:
                        verify_window(window, finish)
                    except Exception as error:
                        finish(json.dumps({'ok': False, 'error': str(error)}))
                window.events.loaded += self_test
            webview.start(gui='edgechromium', debug=False, private_mode=True, http_server=False)
        finally:
            server.shutdown()
            worker.join(timeout=3)


def main():
    parser = argparse.ArgumentParser(description=TITLE)
    parser.add_argument('--self-test', type=Path, metavar='REPORT', help=argparse.SUPPRESS)
    args = parser.parse_args()
    report = args.self_test
    try:
        if report is None:
            run_window(HOME)
            return 0
        with TemporaryDirectory(prefix='token-billing-desktop-test-') as tmp:
            run_window(Path(tmp), report)
        return 0 if report.exists() and json.loads(report.read_text(encoding='utf-8')).get('ok') else 1
    except Exception as error:
        if report:
            report.write_text(json.dumps({'ok': False, 'error': str(error), 'trace': traceback.format_exc()}), encoding='utf-8')
        else:
            desktop_error('无法启动 Token 计费工具。\n\n' + str(error))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
