"""Writes the parsing worker's test files beside this script. The files are checked in; run
this again only to change them, with the worker's libraries installed:

    .venv/bin/python engine/parsing/test/data/make_fixtures.py
"""

import datetime
from pathlib import Path

from docx import Document
from openpyxl import Workbook
from pptx import Presentation
from pptx.util import Inches

HERE = Path(__file__).parent


def word():
    doc = Document()
    doc.add_heading("Travel policy", level=0)
    doc.add_heading("Hotels", level=1)
    doc.add_paragraph("Hotels cost at most 600 a night in tier-1 cities.")
    doc.add_paragraph("Book through the travel desk.", style="List Bullet")
    doc.add_paragraph("Keep the invoice.", style="List Bullet 2")
    table = doc.add_table(rows=3, cols=3)
    for r, row in enumerate([["City tier", "Cap", "Note"], ["Tier 1", "600", ""], ["Tier 2", "450", "Since 2026"]]):
        for c, text in enumerate(row):
            table.cell(r, c).text = text
    # A merged cell is one cell, not one per column it spans.
    merged = doc.add_table(rows=2, cols=2)
    merged.cell(0, 0).merge(merged.cell(0, 1)).text = "Approvals"
    merged.cell(1, 0).text = "Manager"
    merged.cell(1, 1).text = "Finance"
    doc.add_paragraph("")
    doc.add_heading("住宿", level=2)
    doc.add_paragraph("一线城市住宿标准每晚不超过 600 元。")
    doc.save(HERE / "policy.docx")


def slides():
    deck = Presentation()
    first = deck.slides.add_slide(deck.slide_layouts[1])
    first.shapes.title.text = "Quarterly review"
    body = first.placeholders[1].text_frame
    body.text = "Travel spend fell 8%"
    detail = body.add_paragraph()
    detail.text = "Hotels drove most of it"
    detail.level = 1
    first.notes_slide.notes_text_frame.text = "Mention the new cap."
    second = deck.slides.add_slide(deck.slide_layouts[5])
    second.shapes.title.text = "Caps by tier"
    shape = second.shapes.add_table(2, 2, Inches(1), Inches(2), Inches(6), Inches(1))
    for r, row in enumerate([["Tier", "Cap"], ["Tier 1", "600"]]):
        for c, text in enumerate(row):
            shape.table.cell(r, c).text = text
    deck.save(HERE / "deck.pptx")


def sheets():
    book = Workbook()
    budget = book.active
    budget.title = "Budget"
    budget.append(["Item", "Amount", "Due", "Approved"])
    budget.append(["Hotels", 600.0, datetime.date(2026, 11, 15), True])
    budget.append([None, None, None, None])
    budget.append(["Flights", 1250.5, datetime.datetime(2026, 11, 20, 9, 30), False])
    budget["B5"] = "=B2+B4"
    hidden = book.create_sheet("Scratch")
    hidden.append(["not for readers"])
    hidden.sheet_state = "hidden"
    book.save(HERE / "budget.xlsx")


def pdf(pages: list[list[tuple[int, int, int, str]]], path: Path):
    """A PDF in Helvetica, each page a list of (size, x, y, text) lines."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        None,  # the page tree, once the pages are numbered
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    kids = []
    for lines in pages:
        content = "".join(f"BT /F1 {size} Tf {x} {y} Td ({text}) Tj ET\n" for size, x, y, text in lines)
        if not lines:
            content = "0.5 g 72 400 450 300 re f\n"  # a scan: a picture, no text
        stream = content.encode("latin-1")
        objects.append(b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream))
        objects.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents %d 0 R"
            b" /Resources << /Font << /F1 3 0 R >> >> >>" % len(objects)
        )
        kids.append(len(objects))
    objects[1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (b" ".join(b"%d 0 R" % k for k in kids), len(kids))
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for n, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (n, body)
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    path.write_bytes(bytes(out))


def pdfs():
    def page(n: int, body: list[tuple[int, int, int, str]]):
        return [(9, 72, 810, "Hengyuan internal"), *body, (9, 280, 30, f"Page {n} of 3")]

    pdf(
        [
            page(1, [(20, 72, 740, "Travel policy"), (11, 72, 700, "Hotels cost at most 600 a night."),
                     (11, 72, 686, "The cap holds in every tier-1 city.")]),
            page(2, [(14, 72, 740, "Approvals"), (11, 72, 700, "A manager approves every trip.")]),
            page(3, [(11, 72, 700, "Finance checks the invoices each month.")]),
        ],
        HERE / "policy.pdf",
    )
    pdf([[]], HERE / "scan.pdf")


if __name__ == "__main__":
    word()
    slides()
    sheets()
    pdfs()
    (HERE / "broken.docx").write_bytes(b"PK\x03\x04 not a zip after all")
