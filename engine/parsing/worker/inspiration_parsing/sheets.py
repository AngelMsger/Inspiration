"""Excel (.xlsx): each visible sheet as a heading with its name and one table of the values
its cells show (the values Excel last calculated, not the formulas), its first row taken
as the header. Empty rows are left out. A workbook is read up to MAX_CELLS cells."""

import datetime
import io

from openpyxl import load_workbook

from .blocks import Unreadable, block, clean, table

MAX_CELLS = 200_000


def parse(data: bytes) -> tuple[list[dict], list[str]]:
    try:
        book = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception as e:
        raise Unreadable(f"not a readable Excel file: {e}") from e
    blocks, warnings = [], []
    budget = MAX_CELLS
    try:
        for n, sheet in enumerate(book.worksheets, start=1):
            if sheet.sheet_state != "visible":
                warnings.append(f"sheet {sheet.title} is hidden and was not read")
                continue
            rows = []
            for row in sheet.iter_rows(values_only=True):
                if budget <= 0:
                    warnings.append(f"only the first {MAX_CELLS} cells of the workbook were read")
                    break
                budget -= len(row)
                rows.append([text_of(v) for v in row])
            # Columns empty in every row are left out, as the trailing ones of a sheet often are.
            width = max((i + 1 for row in rows for i, v in enumerate(row) if v), default=0)
            t = table(f"sheet{n}.table", [row[:width] for row in rows], sheet=sheet.title)
            if t:
                blocks.append(block(f"sheet{n}", "heading", sheet.title, level=1))
                blocks.append(t)
            if budget <= 0:
                break
    finally:
        book.close()
    return blocks, warnings if blocks else [*warnings, "the workbook has no values"]


def text_of(value) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, datetime.datetime):
        midnight = value.time() == datetime.time(0)
        return value.date().isoformat() if midnight else value.isoformat(sep=" ", timespec="minutes")
    if isinstance(value, (datetime.date, datetime.time)):
        return value.isoformat()
    return clean(str(value))
