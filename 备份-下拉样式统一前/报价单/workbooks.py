"""Read and write local, versionless Excel quote sheets without evaluating formulas."""

from __future__ import annotations

import os
import re
import stat
import tempfile
import unicodedata
from decimal import Decimal
from fractions import Fraction
from itertools import islice
from pathlib import Path
from threading import Lock
from warnings import catch_warnings, filterwarnings
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile, ZipFile

from openpyxl import Workbook, load_workbook
from openpyxl.cell.rich_text import CellRichText, TextBlock
from openpyxl.cell.text import InlineFont
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.utils.exceptions import InvalidFileException
from openpyxl.worksheet.cell_range import CellRange
from openpyxl.worksheet.worksheet import Worksheet

HEADERS = {
    "model": "模型名称",
    "group": "分组",
    "unit": "计费",
    "input": "输入价\n1M Tokens",
    "output": "输出价\n1M Tokens",
    "read": "缓存读\n1M Tokens",
    "write": "缓存写\n1M Tokens",
    "ratio": "充值比例",
}
PRICE_KEYS = ("input", "output", "read", "write")
CNY_ALIASES = {"cny", "rmb", "人民币", "人民币(¥)", "人民币(元)", "人民币(cny)", "人民币(rmb)", "元", "人民币元", "¥"}
CREDIT_ALIASES = {
    "credit", "credits", "额度", "站内额度", "站内额度($)", "站内额度(usd)",
    "站内额度(美元)", "美金额度", "美元额度", "美元", "usd", "$", "usd($)", "美元($)",
}
DECIMAL_PATTERN = re.compile(r"(?:[0-9]{1,16}(?:\.[0-9]{0,12})?|\.[0-9]{1,12})")
BAD_FILE_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f\x7f]')
BAD_SHEET_CHARS = re.compile(r"[\\/*?:\[\]\x00-\x1f\x7f]")
RESERVED_FILE = re.compile(r"(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)", re.I)
WORKBOOK_TYPE = b"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
MAX_FILE = 25 * 1024 * 1024
MAX_EXPANDED = 128 * 1024 * 1024
MAX_SHEETS = 128
MAX_ROWS = 20_000
MAX_COLUMNS = 128
MAX_WARNINGS = 200


def _header(value: object) -> str:
    return "".join(unicodedata.normalize("NFKC", str(value or "")).split()).casefold()


def _text(value: object, label: str, *, optional: bool = False) -> str:
    if value is None and optional:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{label}须为文本。")
    result = value.strip()
    if len(result) > 100 or any(unicodedata.category(char) in {"Cc", "Cs"} for char in result):
        raise ValueError(f"{label}最多 100 个字符，且不能包含控制字符。")
    if not result and not optional:
        raise ValueError(f"{label}不能为空。")
    return result


def _unit(value: object) -> str:
    text = _header(value)
    if text in CNY_ALIASES:
        return "cny"
    if text in CREDIT_ALIASES:
        return "credit"
    raise ValueError("计费须为人民币（CNY / ¥）或站内额度（credit / $）。")


def _decimal(value: object, label: str, *, excel: bool = False) -> str:
    if excel and value is None:
        return ""
    if excel and type(value) in {int, float}:
        number = Decimal(str(value))
        if not number.is_finite() or number < 0 or (number and not -12 <= number.adjusted() <= 15):
            raise ValueError(f"{label}须为非负数字，最多 16 位整数及 12 位小数。")
        value = "0" if not number else format(number, "f")
        if "." in value:
            value = value.rstrip("0").rstrip(".")
    if not isinstance(value, str):
        raise ValueError(f"{label}须为十进制文本，未知请留空。")
    text = unicodedata.normalize("NFKC", value).strip()
    if text and not DECIMAL_PATTERN.fullmatch(text):
        raise ValueError(f"{label}须为非负数字，最多 16 位整数及 12 位小数。")
    return text


def _ratio(value: object, unit: str) -> str:
    text = _text(value, "充值比例", optional=True)
    if not text and unit == "cny":
        return ""
    parts = unicodedata.normalize("NFKC", text).split(":")
    if len(parts) != 2:
        raise ValueError("充值比例须为大于零的实付 : 到账比例，例如 1:2。")
    paid, credit = (_decimal(part, "充值比例") for part in parts)
    if not paid or not credit or not Decimal(paid) or not Decimal(credit):
        raise ValueError("充值比例两边都必须大于 0。")
    return f"{paid}:{credit}" if unit == "credit" else ""


def _platform(value: object) -> str:
    name = _text(value, "平台")
    if len(name.encode("utf-16-le")) // 2 > 31 or BAD_SHEET_CHARS.search(name) or name.startswith("'") or name.endswith("'"):
        raise ValueError("平台用于工作表名称：最多 31 个字符，不可包含 \\ / * ? : [ ] 或以单引号开头或结尾。")
    if name.casefold() == "history":
        raise ValueError("History 是 Excel 保留的工作表名称。")
    return name


def _row(platform: object, data: dict, *, excel: bool = False) -> dict:
    source = data.get("prices")
    if not isinstance(source, dict) or not all(key in source for key in PRICE_KEYS):
        raise ValueError("须提供输入、输出、缓存读取及缓存创建四列单价，未知请留空。")
    unit = _unit(data.get("unit"))
    return {
        "platform": _platform(platform),
        "model": _text(data.get("model"), "模型名称"),
        "group": _text(data.get("group"), "分组", optional=True),
        "unit": unit,
        "prices": {key: _decimal(source[key], HEADERS[key].split("\n")[0], excel=excel) for key in PRICE_KEYS},
        "ratio": _ratio(data.get("ratio"), unit),
    }


def _warn(warnings: list[str], location: str, error: object) -> None:
    if len(warnings) < MAX_WARNINGS:
        detail = " ".join(str(error).split())[:240]
        warnings.append(f"{location}：{detail or '无法读取。'}")
    elif len(warnings) == MAX_WARNINGS:
        warnings.append("其余读取警告已省略。")


def _check_archive(source, size: int) -> None:
    if size > MAX_FILE:
        raise ValueError("文件超过 25 MiB。")
    with ZipFile(source) as archive:
        entries = archive.infolist()
        if len(entries) > 4096 or sum(entry.file_size for entry in entries) > MAX_EXPANDED:
            raise ValueError("工作簿解压内容超过限制。")
        types = archive.getinfo("[Content_Types].xml")
        if types.file_size > 1024 * 1024 or WORKBOOK_TYPE not in archive.read(types):
            raise ValueError("仅支持标准 .xlsx 工作簿，不支持宏工作簿。")


def _column_indices(cells) -> dict[str, int]:
    fields = {_header(label): key for key, label in HEADERS.items()}
    # Old workbooks retain their original column titles and remain readable.
    for key, old_label in {"input": "输入价格", "output": "输出价格", "read": "缓存读取", "write": "缓存创建"}.items():
        for label in (HEADERS[key].split("\n")[0], old_label):
            for unit in ("1M Tokens", "/ 1M Tokens"):
                fields[_header(f"{label} {unit}")] = key
    indices = {}
    for index, cell in enumerate(cells):
        key = fields.get(_header(cell.value))
        if key is None:
            continue
        if key in indices:
            raise ValueError(f"标题重复：{HEADERS[key].replace(chr(10), ' ')}。")
        indices[key] = index
    missing = [label.replace("\n", " ") for key, label in HEADERS.items() if key not in indices]
    if missing:
        raise ValueError("缺少列：" + "、".join(missing) + "。")
    return indices


def _scan_sheet(sheet, filename: str, rows: list[dict], warnings: list[str]) -> None:
    location = f"{filename} / {sheet.title}"
    try:
        platform = _platform(sheet.title)
        # Worksheet dimension metadata can be stale; read actual populated cells.
        sheet.reset_dimensions()
        records = sheet.iter_rows(max_col=MAX_COLUMNS)
        indices = _column_indices(next(records, ()))
        valid = []
        for line, cells in enumerate(islice(records, MAX_ROWS + 1), start=2):
            if line > MAX_ROWS + 1:
                _warn(warnings, location, f"工作表仅检查前 {MAX_ROWS} 行数据。")
                break
            data = {key: cells[index] for key, index in indices.items()}
            if all(cell.value is None or (isinstance(cell.value, str) and not cell.value.strip()) for cell in data.values()):
                continue
            if any(cell.data_type in {"f", "e"} for cell in data.values()):
                _warn(warnings, f"{location} 第 {line} 行", "不读取 Excel 公式或错误值，请粘贴为值后重试。")
                continue
            values = {key: cell.value for key, cell in data.items()}
            values["prices"] = {key: values[key] for key in PRICE_KEYS}
            try:
                valid.append({**_row(platform, values, excel=True), "file": filename, "sheet": sheet.title})
            except ValueError as error:
                _warn(warnings, f"{location} 第 {line} 行", error)
        rows.extend(valid)
    except Exception as error:  # Corrupt worksheets must not break other sheets.
        _warn(warnings, location, error)


def scan(directory: Path, *, filenames: set[str] | None = None) -> dict:
    """Scan immediate .xlsx files; return valid rows, warning strings, and file count."""
    rows: list[dict] = []
    warnings: list[str] = []
    files = 0
    try:
        paths = sorted(directory.iterdir(), key=lambda path: (path.name.casefold(), path.name))
    except FileNotFoundError:
        paths = []
    except OSError as error:
        _warn(warnings, str(directory), error)
        paths = []
    for path in paths:
        if (filenames is not None and path.name not in filenames) or path.suffix.lower() != ".xlsx" or path.name.startswith("~$"):
            continue
        try:
            info = path.lstat()
            reparse = getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
            if stat.S_ISLNK(info.st_mode) or reparse:
                files += 1
                raise ValueError("不读取符号链接或重解析点。")
            if not stat.S_ISREG(info.st_mode):
                continue
            files += 1
            with path.open("rb") as source:
                opened = os.fstat(source.fileno())
                if getattr(opened, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                    raise ValueError("不读取重解析点。")
                if info.st_ino and opened.st_ino and not os.path.samestat(info, opened):
                    raise ValueError("文件在读取前发生变化，请重试。")
                _check_archive(source, opened.st_size)
                source.seek(0)
                book = load_workbook(source, read_only=True, data_only=False, keep_links=False)
                try:
                    if not book.worksheets:
                        _warn(warnings, path.name, "没有可读的工作表。")
                    if len(book.worksheets) > MAX_SHEETS:
                        _warn(warnings, path.name, f"仅检查前 {MAX_SHEETS} 个工作表。")
                    for sheet in book.worksheets[:MAX_SHEETS]:
                        _scan_sheet(sheet, path.name, rows, warnings)
                finally:
                    book.close()
        except Exception as error:  # openpyxl and XML/ZIP parsers raise different exceptions.
            _warn(warnings, path.name, error)
    return {"rows": rows, "warnings": warnings, "files": files}


def _filename(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("请输入 Excel 文件名。")
    text = value.strip()
    name = text[:-5] if text.lower().endswith(".xlsx") else text
    if (not name or len(name.encode("utf-16-le", errors="surrogatepass")) // 2 > 100
            or name[-1] in " ." or name.startswith("~$") or BAD_FILE_CHARS.search(name)
            or any(unicodedata.category(char) == "Cs" for char in name) or RESERVED_FILE.match(name)
            or Path(name).suffix.lower() in {".xls", ".xlsm", ".xlsb"}):
        raise ValueError("请输入有效的文件名，不要包含目录、特殊字符或其他 Excel 扩展名。")
    return name


def _style_sheet(sheet) -> None:
    for cell in sheet[1]:
        cell.font = Font(name="微软雅黑", size=11, bold=True, color="173E34")
        cell.fill = PatternFill(fill_type="solid", fgColor="E5F2E9")
        cell.alignment = Alignment(vertical="center", horizontal="center", wrap_text=True)
        if "\n" in cell.value:
            label, unit = cell.value.split("\n", 1)
            cell.value = CellRichText([
                TextBlock(InlineFont(rFont="微软雅黑", sz=11, b=True, color="173E34"), label),
                TextBlock(InlineFont(rFont="微软雅黑", sz=9, color="536662"), "\n" + unit),
            ])
    for index, width in enumerate((33, 22, 16, 19, 19, 19, 19, 18), start=1):
        sheet.column_dimensions[get_column_letter(index)].width = width
    sheet.column_dimensions["H"].number_format = "@"
    sheet.row_dimensions[1].height = 34
    sheet.sheet_format.defaultRowHeight = 19
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions


def _write_row(sheet, index: int, row: dict, columns: dict[str, int]) -> None:
    values = {**row, **row["prices"], "unit": "人民币" if row["unit"] == "cny" else "站内额度 ($)"}
    for field, column in columns.items():
        cell = sheet.cell(index, column + 1, values[field])
        # Text preserves exact decimal digits and never serializes user strings as formulas.
        cell.data_type = "s"
        if field in PRICE_KEYS or field == "ratio":
            cell.number_format = "@"


def _write_sheet(sheet, rows: list[dict]) -> None:
    sheet.append(list(HEADERS.values()))
    columns = {field: i for i, field in enumerate(HEADERS)}
    for index, row in enumerate(rows, start=2):
        _write_row(sheet, index, row, columns)
    _style_sheet(sheet)


def _publish(source: Path, destination: Path) -> None:
    if os.name == "nt":
        source.rename(destination)  # Windows rename is atomic and cannot replace existing files.
    else:
        os.link(source, destination)  # POSIX rename would replace an existing file.


def _row_groups(rows: list) -> dict[str, list[dict]]:
    if not isinstance(rows, list) or not rows or len(rows) > MAX_ROWS:
        raise ValueError(f"至少需要 1 条、最多 {MAX_ROWS} 条报价。")
    groups: dict[str, list[dict]] = {}
    seen: dict[str, str] = {}
    for index, entry in enumerate(rows, start=1):
        try:
            if not isinstance(entry, dict):
                raise ValueError("报价必须为对象。")
            row = _row(entry.get("platform"), entry)
            name = row["platform"]
            if seen.setdefault(name.casefold(), name) != name:
                raise ValueError("不同平台之间的工作表名称不能只在大小写上有差别。")
            groups.setdefault(name, []).append(row)
            if len(groups) > MAX_SHEETS:
                raise ValueError(f"一本工作簿最多包含 {MAX_SHEETS} 个平台。")
        except ValueError as error:
            raise ValueError(f"第 {index} 条报价：{error}") from error
    return groups


def save(directory: Path, filename: str, rows: list) -> str:
    """Write an .xlsx workbook and return its actual unique filename."""
    basename = _filename(filename)
    groups = _row_groups(rows)
    directory.mkdir(parents=True, exist_ok=True)
    descriptor, path = tempfile.mkstemp(prefix=".quote-", suffix=".tmp", dir=directory)
    os.close(descriptor)
    temporary = Path(path)
    try:
        book = Workbook()
        book.remove(book.active)
        try:
            for name, values in groups.items():
                _write_sheet(book.create_sheet(name), values)
            book.save(temporary)
        finally:
            book.close()
        for index in range(1, 10_001):
            suffix = "" if index == 1 else f" ({index})"
            candidate = f"{basename}{suffix}.xlsx"
            try:
                _publish(temporary, directory / candidate)
            except FileExistsError:
                continue
            return candidate
        raise OSError("无法分配未使用的报价文件名。")
    finally:
        temporary.unlink(missing_ok=True)


class WorkbookConflictError(ValueError):
    """The target could not safely be changed in its current state."""


_append_lock = Lock()


def _regular_info(path: Path) -> os.stat_result:
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        raise ValueError("不支持链接或重解析点指向的报价文件。")
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("同名路径不是普通 Excel 文件。")
    return info


def match(directory: Path, filename: str) -> str | None:
    """Return the current workbook name, using Windows-style case-insensitive lookup."""
    name = (_filename(filename) + ".xlsx").casefold()
    candidates = [path for path in directory.iterdir() if path.name.casefold() == name]
    if len(candidates) > 1:
        raise ValueError("有多个仅大小写不同的同名文件，请先重命名。")
    if not candidates:
        return None
    _regular_info(candidates[0])
    return candidates[0].name


def _file_snapshot(info: os.stat_result) -> tuple:
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _assert_unlocked(path: Path) -> None:
    # Excel leaves a companion ownership file while the workbook is open.
    lock_names = {("~$" + path.name).casefold(), ("~$" + path.name[2:]).casefold()}
    if any(item.name.casefold() in lock_names for item in path.parent.iterdir()):
        raise WorkbookConflictError("报价单正在被 Excel 使用，请关闭后重试。")


def _quote_key(row: dict) -> tuple:
    prices = tuple(Decimal(row["prices"][field]) if row["prices"][field] else None for field in PRICE_KEYS)
    ratio = row["ratio"].split(":") if row["ratio"] else None
    conversion = Fraction(Decimal(ratio[0])) / Fraction(Decimal(ratio[1])) if ratio else None
    return (row["model"], row["group"], row["unit"], prices, conversion)


def _append_existing_sheet(sheet: Worksheet, rows: list[dict]) -> int:
    last_row = sheet.max_row
    if last_row > MAX_ROWS + 1 or sheet.max_column > MAX_COLUMNS:
        raise ValueError("工作表超出行数或列数限制。")
    if sheet.protection.sheet:
        raise ValueError("工作表受保护。")
    columns = _column_indices(sheet[1])
    seen = set()
    for line, cells in enumerate(sheet.iter_rows(min_row=2, max_row=last_row, max_col=max(columns.values()) + 1), start=2):
        data = {field: cells[i] for field, i in columns.items()}
        if all(cell.value is None or (isinstance(cell.value, str) and not cell.value.strip()) for cell in data.values()):
            continue
        if any(cell.data_type in {"f", "e"} for cell in data.values()):
            raise ValueError(f"第 {line} 行包含公式或错误值。")
        values = {field: cell.value for field, cell in data.items()}
        values["prices"] = {field: values[field] for field in PRICE_KEYS}
        try:
            seen.add(_quote_key(_row(sheet.title, values, excel=True)))
        except ValueError as error:
            raise ValueError(f"第 {line} 行：{error}") from error
    index = last_row
    for row in rows:
        key = _quote_key(row)
        if key in seen:
            continue
        seen.add(key)
        index += 1
        if index > MAX_ROWS + 1:
            raise ValueError(f"工作表最多包含 {MAX_ROWS} 行报价。")
        _write_row(sheet, index, row, columns)
    if index > last_row and sheet.auto_filter.ref:
        area = CellRange(sheet.auto_filter.ref)
        if area.min_row == 1 and area.max_row == last_row:
            area.max_row = index
            sheet.auto_filter.ref = str(area)
    return index - last_row


def _unique_rows(rows: list[dict]) -> list[dict]:
    seen = set()
    output = []
    for row in rows:
        key = _quote_key(row)
        if key not in seen:
            seen.add(key)
            output.append(row)
    return output


def _append_to_book(book, groups: dict[str, list[dict]]) -> int:
    sheets = {name.casefold(): book[name] for name in book.sheetnames}
    if len(sheets) != len(book.sheetnames):
        raise ValueError("已有仅大小写不同的工作表，请先重命名。")
    added = 0
    for platform, rows in groups.items():
        sheet = sheets.get(platform.casefold())
        if sheet is None:
            if len(book.sheetnames) >= MAX_SHEETS or getattr(book.security, "lockStructure", False):
                raise ValueError("工作簿的工作表数量达到上限或结构受保护，不能新建工作表。")
            unique = _unique_rows(rows)
            _write_sheet(book.create_sheet(platform), unique)
            added += len(unique)
        else:
            try:
                if not isinstance(sheet, Worksheet):
                    raise ValueError("不是普通报价工作表。")
                added += _append_existing_sheet(sheet, rows)
            except ValueError as error:
                raise ValueError(f"工作表「{sheet.title}」无法追加：{error}") from error
    return added


def append(directory: Path, filename: str, rows: list) -> dict:
    """Append only new quotes to an existing workbook, with an atomic final replace."""
    groups = _row_groups(rows)
    with _append_lock:
        name = match(directory, filename)
        if name is None:
            raise FileNotFoundError("同名报价单不存在，请刷新后重试。")
        path = directory / name
        _assert_unlocked(path)
        before_info = _regular_info(path)
        before = _file_snapshot(before_info)
        temporary = None
        try:
            with path.open("rb") as source:
                opened = os.fstat(source.fileno())
                # Windows fstat may omit inode/device or round timestamps on the open handle.
                different_file = before_info.st_ino and opened.st_ino and not os.path.samestat(before_info, opened)
                if (different_file or opened.st_size != before_info.st_size or opened.st_mtime_ns != before_info.st_mtime_ns
                        or _file_snapshot(_regular_info(path)) != before):
                    raise WorkbookConflictError("报价单已被修改，请刷新后重试。")
                _check_archive(source, before[2])
                source.seek(0)
                # Refuse workbooks whose unsupported extensions would be discarded on save.
                with catch_warnings():
                    filterwarnings("error", message=r".*(?:will be removed|will be lost).*", category=UserWarning)
                    book = load_workbook(source, keep_links=True, rich_text=True)
                try:
                    added = _append_to_book(book, groups)
                    if added:
                        with tempfile.NamedTemporaryFile(prefix=".quote-append-", suffix=".tmp", dir=directory, delete=False) as target:
                            temporary = Path(target.name)
                        book.save(temporary)
                        with temporary.open("rb") as validation:
                            _check_archive(validation, os.fstat(validation.fileno()).st_size)
                finally:
                    book.close()
            _assert_unlocked(path)
            if _file_snapshot(_regular_info(path)) != before:
                raise WorkbookConflictError("报价单已被修改，请刷新后重试。")
            if temporary is not None:
                os.replace(temporary, path)
            return {"filename": name, "added": added, "skipped": len(rows) - added}
        except PermissionError as error:
            raise WorkbookConflictError("报价单正在使用或没有写入权限，请关闭表格后重试。") from error
        except (BadZipFile, InvalidFileException, KeyError, ParseError, UserWarning) as error:
            raise ValueError("报价单内容损坏或包含不支持保留的 Excel 功能，未追加。") from error
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
