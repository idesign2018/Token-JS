"""Serve the offline calculator and its explicitly selected workbook folder."""

import argparse
import ctypes
import hmac
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import socket
import stat
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock
from urllib.parse import unquote
import webbrowser


ROOT = Path(__file__).absolute().parent.parent
LOOPBACK = str(ipaddress.IPv4Address(0x7F000001))
ENTRY = 'Token计算.html'
QUOTE_DIRECTORY = ROOT / '报价单文件'
SYSTEM_QUOTE_DIRECTORY = ROOT / '报价单'
META = b'<meta name="billing-bridge" content="">'
TOKEN_HEADER = 'X-Billing-Token'
MAX_BODY = 2_000_000
STATIC_TYPES = {
    ENTRY: 'text/html; charset=utf-8',
    '界面/calculator.css': 'text/css; charset=utf-8',
    '界面/controls.js': 'text/javascript; charset=utf-8',
    '界面/app.js': 'text/javascript; charset=utf-8',
    '计费/billing.js': 'text/javascript; charset=utf-8',
    '报价单/quotes.js': 'text/javascript; charset=utf-8',
    '报价单/search.js': 'text/javascript; charset=utf-8',
    '报价单/excel.js': 'text/javascript; charset=utf-8',
    '报价单/html-import.js': 'text/javascript; charset=utf-8',
    '报价HTML通用识别/识别.js': 'text/javascript; charset=utf-8',
}
REQUEST_FIELDS = {
    '/api/scan': {'path'},
    '/api/save': {'path', 'filename', 'rows'},
    '/api/match': {'path', 'filename'},
    '/api/append': {'path', 'filename', 'rows'},
    '/api/delete-quote': {'path', 'filename', 'sheet', 'line', 'revision'},
    '/api/open-folder': set(),
}


class RequestError(ValueError):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def lstat_local(path):
    """Do not follow symlinks, junctions, placeholders or mount-point reparses."""
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or (
        getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
    ):
        raise ValueError('不支持符号链接、目录联接或其他重解析点。')
    return info


def default_quote_directory():
    parent = local_directory(str(ROOT))
    folder = parent / QUOTE_DIRECTORY.name
    try:
        folder.mkdir(exist_ok=True)
    except FileExistsError as error:
        raise ValueError('默认报价单文件路径不是文件夹。') from error
    return local_directory(str(folder))


def open_default_quote_directory():
    folder = default_quote_directory()
    if os.name != 'nt':
        raise ValueError('打开文件夹功能只支持 Windows 资源管理器。')
    os.startfile(str(folder), 'explore')
    return folder


def local_directory(value):
    if not isinstance(value, str) or len(value) > 1024 or any(ord(c) < 32 for c in value):
        raise ValueError('请填写有效的本机文件夹路径。')
    if not value.strip():
        return default_quote_directory()
    folder = Path(value.strip())
    if not folder.is_absolute() or folder.anchor.startswith(('\\\\', '//')) or '..' in folder.parts:
        raise ValueError('请填写本机绝对路径，不支持相对路径或网络共享。')
    if os.name == 'nt':
        if not re.fullmatch(r'[A-Za-z]:', folder.drive) or any(
            part.endswith((' ', '.')) or re.search(r'[<>:"|?*]', part)
            or re.fullmatch(r'(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?', part, re.I)
            for part in folder.parts[1:]
        ):
            raise ValueError('不支持网络路径、设备路径或特殊路径。')
        # Reject network shares mapped to drive letters before touching the path.
        if ctypes.windll.kernel32.GetDriveTypeW(str(folder.anchor)) not in {2, 3, 5, 6}:
            raise ValueError('只能选择本机磁盘上的文件夹，不支持映射的网络驱动器。')
    current = Path(folder.anchor)
    try:
        for part in folder.parts[1:]:
            current = current / part
            if not stat.S_ISDIR(lstat_local(current).st_mode):
                raise ValueError('指定路径不是文件夹。')
    except FileNotFoundError as error:
        raise RequestError(HTTPStatus.NOT_FOUND, '找不到指定的文件夹。') from error
    except PermissionError as error:
        raise RequestError(HTTPStatus.FORBIDDEN, '无权访问指定的文件夹。') from error
    return current


def static_file(name):
    folder = local_directory(str((ROOT / name).parent))
    path = folder / Path(name).name
    if not stat.S_ISREG(lstat_local(path).st_mode):
        raise FileNotFoundError(name)
    return path.read_bytes()


def load_workbooks():
    sys.dont_write_bytecode = True
    folder = local_directory(str(ROOT / '报价单'))
    path = folder / 'workbooks.py'
    if not stat.S_ISREG(lstat_local(path).st_mode):
        raise FileNotFoundError(path)
    spec = importlib.util.spec_from_file_location('_token_billing_workbooks', path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class Bridge(ThreadingHTTPServer):
    address_family = socket.AF_INET
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, workbooks=None):
        self.token = secrets.token_urlsafe(32)
        self._workbooks = workbooks
        self._workbooks_lock = Lock()
        super().__init__((LOOPBACK, 0), Handler)
        self.host = f'{LOOPBACK}:{self.server_port}'
        self.origin = 'http://' + self.host


    @property
    def workbooks(self):
        if self._workbooks is None:
            with self._workbooks_lock:
                if self._workbooks is None:
                    try:
                        self._workbooks = load_workbooks()
                    except ImportError as error:
                        raise RequestError(HTTPStatus.SERVICE_UNAVAILABLE, 'Excel 功能需要 openpyxl 3.1 或以上版本。') from error
        return self._workbooks


class Handler(BaseHTTPRequestHandler):
    server_version = 'TokenBilling'
    sys_version = ''

    def setup(self):
        self.request.settimeout(6)
        super().setup()

    def log_message(self, _format, *_args):
        # Keep headers, client paths, and request contents out of launcher logs.
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        super().end_headers()

    def reply(self, status, body, content_type):
        self.close_connection = True
        self.send_response(status)
        self.send_header('Connection', 'close')
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD':
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass

    def json_reply(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode('utf-8')
        self.reply(status, body, 'application/json; charset=utf-8')

    def send_error(self, code, message=None, explain=None):
        self.json_reply(code, {'error': message or self.responses.get(code, ('请求失败。',))[0]})

    def verify_site(self):
        if self.headers.get_all('Host') != [self.server.host]:
            raise RequestError(HTTPStatus.FORBIDDEN, '无效的本机访问地址。')
        origins = self.headers.get_all('Origin')
        if origins is not None and origins != [self.server.origin]:
            raise RequestError(HTTPStatus.FORBIDDEN, '不允许跨站访问。')
        sites = self.headers.get_all('Sec-Fetch-Site')
        if sites is not None and sites not in (['same-origin'], ['none']):
            raise RequestError(HTTPStatus.FORBIDDEN, '不允许跨站访问。')

    def do_GET(self):
        try:
            self.verify_site()
            if self.path in REQUEST_FIELDS:
                raise RequestError(HTTPStatus.METHOD_NOT_ALLOWED, '接口只接受 POST。')
            if not self.path.startswith('/') or '?' in self.path or '#' in self.path:
                raise FileNotFoundError
            name = unquote(self.path[1:], errors='strict') or ENTRY
            if name not in STATIC_TYPES:
                raise FileNotFoundError
            body = static_file(name)
            if name == ENTRY:
                if body.count(META) != 1:
                    raise RequestError(HTTPStatus.INTERNAL_SERVER_ERROR, '页面缺少唯一的本地服务标记。')
                meta = META.replace(b'""', b'"' + self.server.token.encode('ascii') + b'"')
                body = body.replace(META, meta, 1)
            self.reply(HTTPStatus.OK, body, STATIC_TYPES[name])
        except RequestError as error:
            self.send_error(error.status, str(error))
        except (OSError, ValueError):
            self.send_error(HTTPStatus.NOT_FOUND, '页面或资源不存在。')

    do_HEAD = do_GET

    def do_OPTIONS(self):
        self.send_error(HTTPStatus.FORBIDDEN, '不允许跨站访问。')

    def read_payload(self):
        self.verify_site()
        if self.path not in REQUEST_FIELDS:
            raise RequestError(HTTPStatus.NOT_FOUND, '接口不存在。')
        tokens = self.headers.get_all(TOKEN_HEADER, [])
        if len(tokens) != 1 or not hmac.compare_digest(tokens[0].encode('latin-1'), self.server.token.encode('ascii')):
            raise RequestError(HTTPStatus.FORBIDDEN, '本地服务令牌无效，请重新打开页面。')
        content_types = self.headers.get_all('Content-Type', [])
        if len(content_types) != 1 or self.headers.get_content_type() != 'application/json':
            raise RequestError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, '请求必须为 JSON。')
        if self.headers.get('Transfer-Encoding') is not None:
            raise RequestError(HTTPStatus.BAD_REQUEST, '不支持分块请求。')
        lengths = self.headers.get_all('Content-Length', [])
        if len(lengths) != 1 or not re.fullmatch(r'[0-9]{1,12}', lengths[0]):
            raise RequestError(HTTPStatus.BAD_REQUEST, '请求长度无效。')
        size = int(lengths[0])
        if size > MAX_BODY:
            raise RequestError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, '报价数据超过 2 MB。')
        try:
            body = self.rfile.read(size)
            if len(body) != size:
                raise ValueError('Incomplete body')
            payload = json.loads(body.decode('utf-8'))
        except TimeoutError as error:
            raise RequestError(HTTPStatus.REQUEST_TIMEOUT, '读取请求超时。') from error
        except (UnicodeError, ValueError, RecursionError) as error:
            raise RequestError(HTTPStatus.BAD_REQUEST, '无法读取 JSON 请求。') from error
        if not isinstance(payload, dict) or set(payload) != REQUEST_FIELDS[self.path]:
            raise RequestError(HTTPStatus.BAD_REQUEST, '请求字段不完整或存在额外字段。')
        return payload

    def do_POST(self):
        try:
            payload = self.read_payload()
            if self.path == '/api/open-folder':
                folder = open_default_quote_directory()
                self.json_reply(HTTPStatus.OK, {'path': str(folder)})
                return
            folder = local_directory(payload['path'])
            if self.path == '/api/scan':
                result = self.server.workbooks.scan(folder)
                system = {'rows': [], 'warnings': [], 'files': 0}
                same_directory = folder == SYSTEM_QUOTE_DIRECTORY
                if not same_directory:
                    try:
                        system_folder = local_directory(str(SYSTEM_QUOTE_DIRECTORY))
                        system = self.server.workbooks.scan(system_folder)
                    except (RequestError, ValueError, OSError) as error:
                        if not isinstance(error, RequestError) or error.status != HTTPStatus.NOT_FOUND:
                            system['warnings'].append(f'系统内置目录：{error}')
                result['systemRows'] = system['rows']
                result['systemFiles'] = system['files']
                result['includesSystem'] = same_directory
                result['warnings'].extend(system['warnings'])
            elif self.path == '/api/delete-quote':
                try:
                    result = self.server.workbooks.delete_quote(folder, payload['filename'], payload['sheet'], payload['line'], payload['revision'])
                except (self.server.workbooks.WorkbookConflictError, FileNotFoundError) as error:
                    raise RequestError(HTTPStatus.CONFLICT, str(error)) from error
            elif self.path == '/api/match':
                result = {'filename': self.server.workbooks.match(folder, payload['filename'])}
            else:
                filename, rows = payload['filename'], payload['rows']
                if not isinstance(filename, str) or not isinstance(rows, list):
                    raise ValueError('文件名必须为文本，报价必须为数组。')
                if self.path == '/api/append':
                    try:
                        result = self.server.workbooks.append(folder, filename, rows)
                    except self.server.workbooks.WorkbookConflictError as error:
                        raise RequestError(HTTPStatus.CONFLICT, str(error)) from error
                    except FileNotFoundError as error:
                        raise RequestError(HTTPStatus.NOT_FOUND, '同名报价单已不存在，请刷新后重试。') from error
                else:
                    result = {'filename': self.server.workbooks.save(folder, filename, rows)}
            self.json_reply(HTTPStatus.OK, {**result, 'path': str(folder)})
        except RequestError as error:
            self.send_error(error.status, str(error))
        except ValueError as error:
            self.send_error(HTTPStatus.BAD_REQUEST, str(error))
        except PermissionError:
            self.send_error(HTTPStatus.FORBIDDEN, '无法读写该文件夹，请检查权限。')
        except FileNotFoundError:
            self.send_error(HTTPStatus.NOT_FOUND, '指定的文件夹已不存在。')
        except OSError:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, '无法读写工作簿，请检查文件夹或磁盘状态。')
        except Exception:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, '处理工作簿时出错。')


def minimize_console():
    if os.name != 'nt':
        return
    try:
        from ctypes import wintypes
        get_window = ctypes.windll.kernel32.GetConsoleWindow
        get_window.restype = wintypes.HWND
        window = get_window()
        if window:
            show_window = ctypes.windll.user32.ShowWindowAsync
            show_window.argtypes = (wintypes.HWND, ctypes.c_int)
            show_window(window, 7)  # SW_SHOWMINNOACTIVE
    except (AttributeError, OSError):
        pass


def main():
    parser = argparse.ArgumentParser(description='Run the local Token billing workbook bridge.')
    parser.add_argument('--no-browser', action='store_true', help='Print the loopback URL without opening it.')
    parser.add_argument('--minimize-console', action='store_true', help='Minimize the console after opening the browser.')
    args = parser.parse_args()
    try:
        local_directory(str(ROOT))
    except (ImportError, OSError, ValueError) as error:
        print(f'无法启动 Token 计费服务：{error}', file=sys.stderr)
        return 1
    with Bridge() as server:
        url = server.origin + '/'
        print(url, flush=True)
        if not args.no_browser:
            try:
                if webbrowser.open(url):
                    if args.minimize_console:
                        minimize_console()
                else:
                    print('无法自动打开浏览器，请手动打开上方地址。', file=sys.stderr)
            except (webbrowser.Error, OSError):
                print('无法自动打开浏览器，请手动打开上方地址。', file=sys.stderr)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
