"""Word (.docx): the body's paragraphs and tables in order. A heading is a paragraph with an
outline level, set on it or on its style (as Word's heading styles in every language set it),
or a style named Title or Heading N; a list item is a numbered or bulleted paragraph.
Headers, footers, comments and text boxes are not read."""

import io
import re

from docx import Document
from docx.oxml.ns import qn
from docx.table import Table
from docx.text.paragraph import Paragraph

from .blocks import Unreadable, block, clean, table

HEADING_STYLE = re.compile(r"heading (\d)$", re.IGNORECASE)


def parse(data: bytes) -> tuple[list[dict], list[str]]:
    try:
        doc = Document(io.BytesIO(data))
    except Exception as e:
        raise Unreadable(f"not a readable Word file: {e}") from e
    blocks = []
    for i, element in enumerate(doc.element.body.iterchildren()):
        anchor = f"b{i + 1}"
        if element.tag == qn("w:p"):
            b = paragraph(Paragraph(element, doc), anchor)
        elif element.tag == qn("w:tbl"):
            b = table(anchor, rows(Table(element, doc)))
        else:
            continue
        if b:
            blocks.append(b)
    return blocks, [] if blocks else ["the document has no text"]


def paragraph(p: Paragraph, anchor: str) -> dict | None:
    text = clean(p.text)
    if not text:
        return None
    level = heading_level(p)
    if level is not None:
        return block(anchor, "heading", text.replace("\n", " "), level=level)
    depth = list_depth(p)
    if depth is not None:
        return block(anchor, "list_item", text, level=depth)
    return block(anchor, "paragraph", text)


def styles(p: Paragraph):
    """The paragraph's style and the styles it is based on, nearest first."""
    style = p.style
    while style is not None:
        yield style
        style = style.base_style


def heading_level(p: Paragraph) -> int | None:
    for ppr in [p._p.pPr, *(s.element.pPr for s in styles(p))]:
        outline = ppr.find(qn("w:outlineLvl")) if ppr is not None else None
        if outline is not None:
            # 0 to 8 are heading levels 1 to 9; 9 is body text.
            value = int(outline.get(qn("w:val"), "9"))
            return value + 1 if value < 9 else None
    name = (p.style.name or "") if p.style is not None else ""
    if name.lower() == "title":
        return 1
    match = HEADING_STYLE.match(name)
    return int(match.group(1)) if match else None


def list_depth(p: Paragraph) -> int | None:
    for ppr in [p._p.pPr, *(s.element.pPr for s in styles(p))]:
        numbering = ppr.numPr if ppr is not None else None
        if numbering is None:
            continue
        # numId 0 takes the numbering away.
        if numbering.numId is not None and numbering.numId.val == 0:
            return None
        return numbering.ilvl.val if numbering.ilvl is not None else 0
    return None


def rows(t: Table) -> list[list[str]]:
    out = []
    for row in t.rows:
        seen: list = []
        cells = []
        # A merged cell is listed once for every column it spans.
        for cell in row.cells:
            if any(cell._tc is tc for tc in seen):
                continue
            seen.append(cell._tc)
            cells.append(clean(cell.text))
        out.append(cells)
    return out
