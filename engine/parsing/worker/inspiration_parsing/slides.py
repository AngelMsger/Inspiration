"""PowerPoint (.pptx): each slide as its title, a heading on the slide's page, then its text
and tables from top to bottom and left to right, groups opened, and its speaker notes last.
An indented paragraph is a list item."""

import io

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE

from .blocks import Unreadable, block, clean, table


def parse(data: bytes) -> tuple[list[dict], list[str]]:
    try:
        deck = Presentation(io.BytesIO(data))
    except Exception as e:
        raise Unreadable(f"not a readable PowerPoint file: {e}") from e
    blocks = []
    for n, slide in enumerate(deck.slides, start=1):
        title = slide.shapes.title
        heading = clean(title.text_frame.text).replace("\n", " ") if title is not None and title.has_text_frame else ""
        if heading:
            blocks.append(block(f"s{n}", "heading", heading, level=1, page=n))
        for i, shape in enumerate(ordered(slide.shapes), start=1):
            if title is not None and shape.shape_id == title.shape_id:
                continue
            blocks.extend(shape_blocks(shape, f"s{n}.{i}", n))
        frame = slide.notes_slide.notes_text_frame if slide.has_notes_slide else None
        notes = clean(frame.text) if frame is not None else ""
        if notes:
            blocks.append(block(f"s{n}.notes", "paragraph", notes, page=n, attrs={"notes": True}))
    return blocks, [] if blocks else ["the presentation has no text"]


def ordered(shapes) -> list:
    """Shapes as a reader takes them in: top to bottom, then left to right."""
    return sorted(shapes, key=lambda s: (s.top or 0, s.left or 0))


def shape_blocks(shape, anchor: str, page: int) -> list[dict]:
    if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
        return [b for i, s in enumerate(ordered(shape.shapes), start=1) for b in shape_blocks(s, f"{anchor}.{i}", page)]
    if getattr(shape, "has_table", False):
        rows = [[clean(cell.text) for cell in row.cells] for row in shape.table.rows]
        t = table(anchor, rows, page=page)
        return [t] if t else []
    if not shape.has_text_frame:
        return []
    out = []
    for j, para in enumerate(shape.text_frame.paragraphs, start=1):
        # A line break inside a paragraph comes as a vertical tab.
        text = clean(para.text.replace("\v", "\n"))
        if not text:
            continue
        if para.level > 0:
            out.append(block(f"{anchor}.p{j}", "list_item", text, level=para.level - 1, page=page))
        else:
            out.append(block(f"{anchor}.p{j}", "paragraph", text, page=page))
    return out
