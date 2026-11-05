"""PDF: the text layer, page by page, as paragraphs in reading order, each with its page and
box. A short paragraph set clearly larger than the body text is a heading, its level by its
size. Running headers and footers (the same short line at the top or bottom of most pages,
page numbers included) are left out. A PDF without a text layer, a scan, is unreadable until
OCR is built, and so is one that needs a password."""

import io
import re
import statistics
from collections import Counter
from dataclasses import dataclass

from pdfminer.high_level import extract_pages
from pdfminer.layout import LAParams, LTChar, LTTextContainer, LTTextLine
from pdfminer.pdfdocument import PDFEncryptionError, PDFPasswordIncorrect

from .blocks import Unreadable, block, join_lines

# Running headers and footers sit in the top and bottom tenth of a page.
MARGIN = 0.1
# A heading is set at least this much larger than the body text, and is short.
HEADING_RATIO = 1.15
HEADING_CHARS = 120
MAX_HEADING_LEVEL = 6


@dataclass
class Paragraph:
    page: int
    height: float
    bbox: tuple[float, float, float, float]
    text: str
    size: float
    lines: int


def parse(data: bytes) -> tuple[list[dict], list[str]]:
    try:
        pages = [
            (n, page.height, [box for box in page if isinstance(box, LTTextContainer)])
            for n, page in enumerate(extract_pages(io.BytesIO(data), laparams=LAParams()), start=1)
        ]
    except (PDFEncryptionError, PDFPasswordIncorrect) as e:
        raise Unreadable("the PDF needs a password") from e
    except Exception as e:
        raise Unreadable(f"not a readable PDF: {e}") from e
    paragraphs = [p for n, height, boxes in pages for box in boxes if (p := paragraph(n, height, box))]
    if not paragraphs:
        raise Unreadable("the PDF has no text layer: a scanned PDF is read once OCR is built")
    running = running_lines(paragraphs, len(pages))
    kept = [p for p in paragraphs if key(p) not in running]
    levels = heading_levels(kept)
    blocks, counts = [], Counter()
    for p in kept:
        counts[p.page] += 1
        anchor = f"p{p.page}.{counts[p.page]}"
        box = [round(v, 1) for v in p.bbox]
        level = levels.get(p.size) if is_heading_shape(p) else None
        if level:
            blocks.append(block(anchor, "heading", p.text, level=level, page=p.page, bbox=box))
        else:
            blocks.append(block(anchor, "paragraph", p.text, page=p.page, bbox=box))
    empty = [str(n) for n, _, boxes in pages if not any(p.page == n for p in paragraphs)]
    warnings = [f"no text layer on page {', '.join(empty)}; scanned pages are read once OCR is built"] if empty else []
    return blocks, warnings


def paragraph(page: int, height: float, box: LTTextContainer) -> Paragraph | None:
    lines = [line for line in box if isinstance(line, LTTextLine)]
    text = join_lines([line.get_text() for line in lines])
    if not text:
        return None
    sizes = [round(c.size, 1) for line in lines for c in line if isinstance(c, LTChar)]
    return Paragraph(page, height, box.bbox, text, statistics.median(sizes) if sizes else 0.0, len(lines))


def key(p: Paragraph) -> str:
    """The same running header or footer on every page, whatever page number it shows."""
    return re.sub(r"\d+", "#", p.text)


def running_lines(paragraphs: list[Paragraph], pages: int) -> set[str]:
    if pages < 3:
        return set()
    margins = Counter()
    for k, page in {(key(p), p.page) for p in paragraphs if in_margin(p) and len(p.text) <= HEADING_CHARS}:
        margins[k] += 1
    return {k for k, n in margins.items() if n > pages / 2}


def in_margin(p: Paragraph) -> bool:
    return p.bbox[1] >= p.height * (1 - MARGIN) or p.bbox[3] <= p.height * MARGIN


def is_heading_shape(p: Paragraph) -> bool:
    return p.lines <= 2 and len(p.text) <= HEADING_CHARS


def heading_levels(paragraphs: list[Paragraph]) -> dict[float, int]:
    """Level by size for the sizes clearly above the body text's, the size most text is set in."""
    weights = Counter()
    for p in paragraphs:
        weights[p.size] += len(p.text)
    body = weights.most_common(1)[0][0]
    sizes = sorted({p.size for p in paragraphs if p.size >= body * HEADING_RATIO and is_heading_shape(p)}, reverse=True)
    return {size: min(i + 1, MAX_HEADING_LEVEL) for i, size in enumerate(sizes)}
