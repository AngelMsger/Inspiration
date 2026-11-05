/**
 * Parsing: the parsing worker, which reads Word (.docx), PowerPoint (.pptx), Excel (.xlsx)
 * and PDF files into the contract's blocks for normalization. The parsers are Python
 * (worker/), a stateless HTTP server that keeps nothing between requests; workerParser is
 * the "parsers" plugin normalization's router picks for those types, and sends the file to
 * the worker at the parsingUrl setting (pnpm parsing starts one on its default port).
 *
 * What each parser reads:
 * - Word: the body's paragraphs and tables in order. A paragraph with an outline level (as
 *   Word's heading styles in every language have) or a style named Title or Heading N is a
 *   heading; a numbered or bulleted paragraph is a list item. Headers, footers, comments
 *   and text boxes are not read.
 * - PowerPoint: each slide's title as a heading on the slide's page, then its text and tables
 *   from top to bottom, and its speaker notes.
 * - Excel: each visible sheet as a heading and one table of the values its cells show (Excel's
 *   last calculated values, not formulas); hidden sheets are named in a warning.
 * - PDF: the text layer as paragraphs with page and box; a short paragraph set clearly larger
 *   than the body text is a heading; running headers, footers and page numbers are left out.
 *
 * A file the worker cannot read (broken, needing a password, or a scan without a text layer)
 * fails with the worker's reason, which normalization keeps as the document's warning.
 * Planned are scans and images, through OCR on the model gateway.
 */

export { WORKER_TYPES, WorkerError, workerParser, workerParserAt } from "./worker.ts";
