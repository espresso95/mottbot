import { describe, expect, it } from "vitest";
import {
  classifyAttachmentForExtraction,
  extractAttachmentText,
  mayInspectAttachmentBytes,
} from "../../src/telegram/file-extraction.js";

const limits = {
  maxTextCharsPerFile: 120,
  maxTextCharsTotal: 200,
  csvPreviewRows: 4,
  csvPreviewColumns: 3,
  pdfMaxPages: 5,
};

function minimalPdf(text: string): Buffer {
  return Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length ${34 + text.length} >>
stream
BT /F1 24 Tf 72 96 Td (${text}) Tj ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000241 00000 n
0000000335 00000 n
trailer
<< /Root 1 0 R /Size 6 >>
startxref
405
%%EOF`);
}

describe("file extraction", () => {
  it("classifies text, Markdown, code, CSV, TSV, and PDF documents", () => {
    expect(
      classifyAttachmentForExtraction({
        attachment: { kind: "document", fileId: "1", fileName: "README.md" },
      }),
    ).toMatchObject({ kind: "markdown", language: "markdown" });
    expect(
      classifyAttachmentForExtraction({
        attachment: { kind: "document", fileId: "1", fileName: "main.ts" },
      }),
    ).toMatchObject({ kind: "code", language: "typescript" });
    expect(
      classifyAttachmentForExtraction({
        attachment: { kind: "document", fileId: "1", fileName: "data.csv" },
      }),
    ).toEqual({ kind: "csv" });
    expect(
      classifyAttachmentForExtraction({
        attachment: { kind: "document", fileId: "1", mimeType: "text/tab-separated-values" },
      }),
    ).toEqual({ kind: "tsv" });
    expect(
      classifyAttachmentForExtraction({
        attachment: { kind: "document", fileId: "1", fileName: "report.pdf" },
      }),
    ).toEqual({ kind: "pdf" });
    expect(mayInspectAttachmentBytes({ attachment: { kind: "document", fileId: "1" } })).toBe(true);
    expect(
      mayInspectAttachmentBytes({
        attachment: { kind: "document", fileId: "1", mimeType: "application/zip" },
      }),
    ).toBe(false);
  });

  it("extracts UTF-8 text with BOM and applies the shared text budget", async () => {
    const budget = { remainingChars: 40 };
    const result = await extractAttachmentText({
      attachment: { kind: "document", fileId: "1", fileName: "notes.txt", mimeType: "text/plain" },
      buffer: Buffer.from(`\uFEFF${"hello ".repeat(20)}`),
      limits,
      budget,
    });

    expect(result?.metadata).toMatchObject({
      kind: "text",
      status: "extracted",
      truncated: true,
      promptChars: 40,
    });
    expect(result?.extractedText?.text).toContain("hello");
    expect(result?.extractedText?.text).toContain("truncated");
    expect(budget.remainingChars).toBe(0);
  });

  it("rejects invalid UTF-8 and binary files masquerading as text", async () => {
    const invalid = await extractAttachmentText({
      attachment: { kind: "document", fileId: "1", fileName: "bad.txt", mimeType: "text/plain" },
      buffer: Buffer.from([0xff, 0xfe, 0xfd]),
      limits,
      budget: { remainingChars: 100 },
    });
    expect(invalid?.metadata).toMatchObject({ status: "failed", reason: "invalid_utf8" });

    const binary = await extractAttachmentText({
      attachment: { kind: "document", fileId: "1", fileName: "unknown" },
      buffer: Buffer.from([0, 1, 2, 3, 4]),
      limits,
      budget: { remainingChars: 100 },
    });
    expect(binary).toBeUndefined();
  });

  it("extracts bounded CSV and TSV previews with quoted newlines", async () => {
    const csv = await extractAttachmentText({
      attachment: { kind: "document", fileId: "1", fileName: "data.csv" },
      buffer: Buffer.from('name,notes,extra\nAda,"line one\nline two",=SUM(A1:A2)\nGrace,ok,value\n'),
      limits: { ...limits, csvPreviewRows: 3, csvPreviewColumns: 2 },
      budget: { remainingChars: 500 },
    });
    expect(csv?.metadata).toMatchObject({
      kind: "csv",
      status: "extracted",
      rowCount: 2,
      columnCount: 2,
    });
    expect(csv?.extractedText?.text).toContain("line one line two");
    expect(csv?.extractedText?.text).not.toContain("=SUM");

    const tsv = await extractAttachmentText({
      attachment: { kind: "document", fileId: "1", fileName: "data.tsv" },
      buffer: Buffer.from("a\tb\n1\t2\n"),
      limits,
      budget: { remainingChars: 500 },
    });
    expect(tsv?.metadata).toMatchObject({ kind: "tsv", status: "extracted" });
  });

  it("extracts PDF text and reports unreadable or scanned PDFs", async () => {
    const pdf = await extractAttachmentText({
      attachment: { kind: "document", fileId: "1", fileName: "report.pdf", mimeType: "application/pdf" },
      buffer: minimalPdf("Hello PDF text"),
      limits,
      budget: { remainingChars: 500 },
    });
    expect(pdf?.metadata).toMatchObject({ kind: "pdf", status: "extracted", pageCount: 1 });
    expect(pdf?.extractedText?.text).toContain("Hello PDF text");

    const bad = await extractAttachmentText({
      attachment: { kind: "document", fileId: "1", fileName: "bad.pdf", mimeType: "application/pdf" },
      buffer: Buffer.from("%PDF-1.4\nnot really a pdf"),
      limits,
      budget: { remainingChars: 500 },
    });
    expect(bad?.metadata.status).toBe("failed");
    expect(bad?.metadata.reason).toMatch(/pdf_/);
  });
});
