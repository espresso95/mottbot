import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramAttachmentIngestor } from "../../src/telegram/attachments.js";
import { createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

describe("TelegramAttachmentIngestor", () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  it("downloads supported images, builds native inputs, and cleans cache files", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const api = {
      getFile: vi.fn(async () => ({
        file_path: "photos/image.png",
        file_size: 5,
      })),
    };
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("image"), {
      status: 200,
      headers: { "content-length": "5" },
    }));
    const ingestor = new TelegramAttachmentIngestor(api as any, stores.config, fetchImpl as any);

    const prepared = await ingestor.prepare({
      allowNativeImages: true,
      allowNativeFiles: false,
      attachments: [{ kind: "photo", fileId: "photo-1" }],
    });

    expect(prepared.nativeInputs).toEqual([{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
    expect(prepared.extractedTexts).toEqual([]);
    expect(prepared.transcriptAttachments[0]).toMatchObject({
      kind: "photo",
      fileId: "photo-1",
      ingestionStatus: "native_input",
      downloadedBytes: 5,
    });
    expect(prepared.cachePaths).toHaveLength(1);
    expect(fs.existsSync(prepared.cachePaths[0]!)).toBe(true);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("/photos/image.png");

    await ingestor.cleanup(prepared);
    expect(fs.existsSync(prepared.cachePaths[0]!)).toBe(false);
  });

  it("keeps unsupported or text-only attachments as metadata", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const api = {
      getFile: vi.fn(async () => ({
        file_path: "docs/report.pdf",
        file_size: 100,
      })),
    };
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("%PDF bad"), { status: 200 }));
    const ingestor = new TelegramAttachmentIngestor(api as any, stores.config, fetchImpl as any);

    const textOnly = await ingestor.prepare({
      allowNativeImages: false,
      allowNativeFiles: false,
      attachments: [{ kind: "photo", fileId: "photo-1" }],
    });
    expect(textOnly.nativeInputs).toEqual([]);
    expect(textOnly.extractedTexts).toEqual([]);
    expect(textOnly.transcriptAttachments[0]).toMatchObject({
      ingestionStatus: "skipped",
      ingestionReason: "model_does_not_support_images",
    });
    expect(api.getFile).not.toHaveBeenCalled();

    const unsupported = await ingestor.prepare({
      allowNativeImages: true,
      allowNativeFiles: false,
      attachments: [{ kind: "document", fileId: "doc-1", mimeType: "application/pdf" }],
    });
    expect(unsupported.nativeInputs).toEqual([]);
    expect(unsupported.transcriptAttachments[0]).toMatchObject({
      ingestionStatus: "skipped",
      extraction: {
        kind: "pdf",
        status: "failed",
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("extracts text, Markdown, code, and CSV documents for prompt context", async () => {
    const stores = createStores({
      attachments: {
        maxExtractedTextCharsPerFile: 200,
        maxExtractedTextCharsTotal: 500,
      } as any,
    });
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const api = {
      getFile: vi
        .fn()
        .mockResolvedValueOnce({ file_path: "docs/readme.md", file_size: 16 })
        .mockResolvedValueOnce({ file_path: "docs/main.ts", file_size: 17 })
        .mockResolvedValueOnce({ file_path: "docs/data.csv", file_size: 17 }),
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(Buffer.from("# Hello\nmarkdown"), { status: 200 }))
      .mockResolvedValueOnce(new Response(Buffer.from("const value = 1;\n"), { status: 200 }))
      .mockResolvedValueOnce(new Response(Buffer.from("name,value\nAda,1\n"), { status: 200 }));
    const ingestor = new TelegramAttachmentIngestor(api as any, stores.config, fetchImpl as any);

    const prepared = await ingestor.prepare({
      allowNativeImages: true,
      allowNativeFiles: false,
      attachments: [
        { kind: "document", fileId: "md", fileName: "readme.md" },
        { kind: "document", fileId: "ts", fileName: "main.ts" },
        { kind: "document", fileId: "csv", fileName: "data.csv" },
      ],
    });

    expect(prepared.nativeInputs).toEqual([]);
    expect(prepared.extractedTexts.map((text) => text.kind)).toEqual(["markdown", "code", "csv"]);
    expect(prepared.extractedTexts[1]).toMatchObject({ language: "typescript" });
    expect(prepared.transcriptAttachments).toEqual([
      expect.objectContaining({ ingestionStatus: "extracted_text", extraction: expect.objectContaining({ kind: "markdown" }) }),
      expect.objectContaining({ ingestionStatus: "extracted_text", extraction: expect.objectContaining({ kind: "code" }) }),
      expect.objectContaining({ ingestionStatus: "extracted_text", extraction: expect.objectContaining({ kind: "csv" }) }),
    ]);

    await ingestor.cleanup(prepared);
    expect(fs.readdirSync(stores.config.attachments.cacheDir)).toEqual([]);
  });

  it("builds native file inputs only when the provider capability allows them", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const api = {
      getFile: vi.fn(async () => ({
        file_path: "docs/report.pdf",
        file_size: 8,
      })),
    };
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("%PDF doc"), { status: 200 }));
    const ingestor = new TelegramAttachmentIngestor(api as any, stores.config, fetchImpl as any);

    const prepared = await ingestor.prepare({
      allowNativeImages: true,
      allowNativeFiles: true,
      attachments: [
        { kind: "document", fileId: "doc-1", fileName: "quarterly report.pdf" },
      ],
    });

    expect(prepared.nativeInputs).toEqual([
      {
        type: "file",
        data: "JVBERiBkb2M=",
        mimeType: "application/pdf",
        fileName: "quarterly_report.pdf",
      },
    ]);
    expect(prepared.extractedTexts).toEqual([]);
    expect(prepared.transcriptAttachments[0]).toMatchObject({
      ingestionStatus: "native_input",
      downloadedBytes: 8,
    });

    await ingestor.cleanup(prepared);
    expect(fs.readdirSync(stores.config.attachments.cacheDir)).toEqual([]);
  });

  it("does not build native file inputs for unclassified binary documents", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const api = {
      getFile: vi.fn(async () => ({
        file_path: "docs/archive.bin",
        file_size: 8,
      })),
    };
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("binary"), { status: 200 }));
    const ingestor = new TelegramAttachmentIngestor(api as any, stores.config, fetchImpl as any);

    const prepared = await ingestor.prepare({
      allowNativeImages: true,
      allowNativeFiles: true,
      attachments: [
        {
          kind: "document",
          fileId: "bin-1",
          fileName: "archive.bin",
          mimeType: "application/octet-stream",
        },
      ],
    });

    expect(prepared.nativeInputs).toEqual([]);
    expect(prepared.extractedTexts).toEqual([]);
    expect(prepared.transcriptAttachments[0]).toMatchObject({
      ingestionStatus: "skipped",
      ingestionReason: "unsupported_attachment_type",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects attachments that exceed configured limits", async () => {
    const stores = createStores({
      attachments: {
        maxFileBytes: 4,
        maxPerMessage: 1,
      } as any,
    });
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const api = {
      getFile: vi.fn(async () => ({
        file_path: "photos/image.png",
        file_size: 5,
      })),
    };
    const ingestor = new TelegramAttachmentIngestor(api as any, stores.config, vi.fn() as any);

    await expect(
      ingestor.prepare({
        allowNativeImages: true,
        allowNativeFiles: false,
        attachments: [
          { kind: "photo", fileId: "a" },
          { kind: "photo", fileId: "b" },
        ],
      }),
    ).rejects.toMatchObject({ code: "attachment.too_many" });

    await expect(
      ingestor.prepare({
        allowNativeImages: true,
        allowNativeFiles: false,
        attachments: [{ kind: "photo", fileId: "a" }],
      }),
    ).rejects.toMatchObject({ code: "attachment.too_large", name: "AttachmentIngestionError" });
  });

  it("cleans already cached files when a later attachment fails", async () => {
    const stores = createStores({
      attachments: {
        maxFileBytes: 10,
        maxPerMessage: 2,
      } as any,
    });
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const api = {
      getFile: vi
        .fn()
        .mockResolvedValueOnce({ file_path: "photos/first.png", file_size: 5 })
        .mockResolvedValueOnce({ file_path: "photos/second.png", file_size: 11 }),
    };
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("first"), { status: 200 }));
    const ingestor = new TelegramAttachmentIngestor(api as any, stores.config, fetchImpl as any);

    await expect(
      ingestor.prepare({
        allowNativeImages: true,
        allowNativeFiles: false,
        attachments: [
          { kind: "photo", fileId: "first" },
          { kind: "photo", fileId: "second" },
        ],
      }),
    ).rejects.toMatchObject({ code: "attachment.too_large" });

    expect(fs.existsSync(stores.config.attachments.cacheDir)).toBe(true);
    expect(fs.readdirSync(stores.config.attachments.cacheDir)).toEqual([]);
  });
});
