import type { ToolHandler } from "./executor.js";
import type { GoogleDriveService } from "./google-drive.js";

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export function createGoogleDriveToolHandlers(service: GoogleDriveService): Partial<Record<string, ToolHandler>> {
  return {
    mottbot_google_drive_search: ({ arguments: input, signal }) =>
      service.searchFiles({
        query: optionalString(input.query),
        limit: optionalInteger(input.limit),
        includeTrashed: input.includeTrashed === true,
        signal,
      }),
    mottbot_google_drive_get_file: ({ arguments: input, signal }) =>
      service.getFile({
        fileId: typeof input.fileId === "string" ? input.fileId : "",
        includeContent: input.includeContent === true,
        maxBytes: optionalInteger(input.maxBytes),
        signal,
      }),
  };
}
