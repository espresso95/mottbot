import { describe, expect, it, vi } from "vitest";
import { createGoogleDriveToolHandlers } from "../../src/tools/google-drive-handlers.js";
import type { ToolDefinition } from "../../src/tools/registry.js";
import type { GoogleDriveService } from "../../src/tools/google-drive.js";

const definition: ToolDefinition = {
  name: "test_tool",
  description: "Test tool.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  timeoutMs: 1_000,
  maxOutputBytes: 4_000,
  sideEffect: "read_only",
  enabled: true,
};

describe("Google Drive tool handlers", () => {
  it("routes search and get calls to the Google Drive service", async () => {
    const service = {
      searchFiles: vi.fn(async () => ({ files: [], truncated: false })),
      getFile: vi.fn(async () => ({ file: { id: "1", name: "Doc" } })),
    } as unknown as GoogleDriveService;
    const handlers = createGoogleDriveToolHandlers(service);

    await handlers.mottbot_google_drive_search!({
      definition,
      arguments: { query: "roadmap", limit: 7, includeTrashed: true },
    });
    await handlers.mottbot_google_drive_get_file!({
      definition,
      arguments: { fileId: "file-1", includeContent: true, maxBytes: 4096 },
    });

    expect(service.searchFiles).toHaveBeenCalledWith({
      query: "roadmap",
      limit: 7,
      includeTrashed: true,
      signal: undefined,
    });
    expect(service.getFile).toHaveBeenCalledWith({
      fileId: "file-1",
      includeContent: true,
      maxBytes: 4096,
      signal: undefined,
    });
  });
});
