import { describe, expect, it, vi } from "vitest";
import { GoogleDriveService, type GoogleDriveToolConfig } from "../../src/tools/google-drive.js";

function createConfig(overrides: Partial<GoogleDriveToolConfig> = {}): GoogleDriveToolConfig {
  return {
    enabled: true,
    driveBaseUrl: "https://www.googleapis.com/drive/v3",
    docsBaseUrl: "https://docs.googleapis.com/v1",
    accessTokenEnv: "GOOGLE_TOKEN",
    timeoutMs: 10_000,
    maxItems: 5,
    maxBytes: 2048,
    ...overrides,
  };
}

describe("GoogleDriveService", () => {
  it("searches files using Drive API", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          files: [
            { id: "A", name: "Spec", mimeType: "text/plain" },
            { id: "B", name: "Roadmap", mimeType: "application/vnd.google-apps.document" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const service = new GoogleDriveService(createConfig(), { fetchImpl, getEnv: () => "token" });

    const result = await service.searchFiles({ query: "roadmap", limit: 1 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.files).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("returns metadata-only file payload", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: "f-1", name: "notes.txt", mimeType: "text/plain", size: "12" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const service = new GoogleDriveService(createConfig(), { fetchImpl, getEnv: () => "token" });

    const result = await service.getFile({ fileId: "f-1" });

    expect(result.file.id).toBe("f-1");
    expect(result.content).toBeUndefined();
  });

  it("reads Google Docs content when requested", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/drive/v3/files/")) {
        return new Response(
          JSON.stringify({
            id: "doc-1",
            name: "Plan",
            mimeType: "application/vnd.google-apps.document",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          body: {
            content: [
              {
                paragraph: {
                  elements: [{ textRun: { content: "Hello team\n" } }],
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const service = new GoogleDriveService(createConfig(), { fetchImpl, getEnv: () => "token" });

    const result = await service.getFile({ fileId: "doc-1", includeContent: true });

    expect(result.file.name).toBe("Plan");
    expect(result.content?.text).toContain("Hello team");
  });

  it("reads plain text file content through alt=media", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("alt=media")) {
        return new Response("line one\nline two", { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      return new Response(
        JSON.stringify({ id: "txt-1", name: "notes.txt", mimeType: "text/plain" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const service = new GoogleDriveService(createConfig(), { fetchImpl, getEnv: () => "token" });

    const result = await service.getFile({ fileId: "txt-1", includeContent: true });

    expect(result.content?.text).toContain("line one");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails clearly when token is missing", async () => {
    const service = new GoogleDriveService(createConfig(), {
      fetchImpl: vi.fn(),
      getEnv: () => undefined,
    });

    await expect(service.searchFiles()).rejects.toThrow("Google Drive access token is missing");
  });
});
