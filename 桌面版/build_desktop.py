"""Build the single-file Windows delivery; requires the dependencies in requirements.txt."""

from pathlib import Path
import sys

import PyInstaller.__main__

ENTRY = Path(__file__).with_name('desktop.py')
ROOT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ENTRY.parent.parent
FILES = (
    'Token计算.html', '界面/calculator.css', '界面/app.js', '界面/controls.js', '计费/billing.js',
    '本地服务/bridge.py', '报价单/quotes.js', '报价单/search.js', '报价单/html-import.js',
    '报价单/excel.js', '报价单/workbooks.py',
)

def main():
    args = ['--onefile', '--windowed', '--clean', '--noconfirm', '--noupx', '--name', 'Token计费工具',
            '--hidden-import', 'openpyxl', '--collect-data', 'pythonnet', '--collect-binaries', 'clr_loader',
            '--exclude-module', 'numpy', '--exclude-module', 'pandas', '--exclude-module', 'PIL', '--exclude-module', 'lxml',
            '--distpath', 'dist', '--workpath', 'build', str(ENTRY)]
    for relative in FILES:
        file = ROOT / relative
        if not file.is_file():
            raise FileNotFoundError(file)
        args.extend(['--add-data', f'{file}:{Path("app") / Path(relative).parent}'])
    PyInstaller.__main__.run(args)

if __name__ == '__main__':
    main()
