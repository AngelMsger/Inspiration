"""Blocks as the contract's DocBlock has them (libs/contracts/schema/source.yaml), and the
text rules every parser here shares."""

import re

# Han, kana and the punctuation and full-width forms that come with them: text in these
# scripts is written without spaces, so a line wrapped inside it joins without one.
CJK = re.compile(r"[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]")
SPACES = re.compile(r"[ \t\u00a0\u2000-\u200b\u3000]+")


class Unreadable(Exception):
    """A file the worker cannot read: broken, encrypted, or without text to read."""


def clean(text: str) -> str:
    """Each line with its runs of spaces made one, and the blank lines around it dropped."""
    lines = (SPACES.sub(" ", line).strip() for line in text.replace("\r", "\n").split("\n"))
    return "\n".join(line for line in lines if line)


def join_lines(lines: list[str]) -> str:
    """The lines of one wrapped paragraph as one line: a space between words, none in CJK text."""
    out = ""
    for line in (SPACES.sub(" ", raw).strip() for raw in lines):
        if not line:
            continue
        if out and not (CJK.match(out[-1]) or CJK.match(line[0])):
            out += " "
        out += line
    return out


def block(anchor: str, kind: str, text: str | None = None, **extra) -> dict:
    """A DocBlock; extra fields that are None are left out."""
    b = {"anchor": anchor, "kind": kind}
    if text is not None:
        b["text"] = text
    b.update({k: v for k, v in extra.items() if v is not None})
    return b


def table(anchor: str, rows: list[list[str]], sheet: str | None = None, **extra) -> dict | None:
    """A table of rows of cell texts, its first row taken as the header, or None when it holds no text."""
    kept = [(r, row) for r, row in enumerate(rows) if any(row)]
    if not kept:
        return None

    def located(r: int, c: int | None = None) -> dict:
        cell = {"row": r} if c is None else {"row": r, "col": c}
        return {"sheet": sheet, **cell} if sheet is not None else cell

    return block(
        anchor,
        "table",
        attrs={"header_rows": 1},
        children=[
            block(
                f"{anchor}.r{r + 1}",
                "table_row",
                cell=located(r),
                children=[
                    block(f"{anchor}.r{r + 1}c{c + 1}", "table_cell", text, cell=located(r, c))
                    for c, text in enumerate(row)
                ],
            )
            for r, row in kept
        ],
        **extra,
    )
