const DEFAULT_DRIVE_BASE_URL = "https://www.googleapis.com/drive/v3";
const DEFAULT_DOCS_BASE_URL = "https://docs.googleapis.com/v1";

/** Runtime configuration for Google Drive and Docs tool access. */
export type GoogleDriveToolConfig = {
  enabled: boolean;
  driveBaseUrl: string;
  docsBaseUrl: string;
  accessTokenEnv: string;
  timeoutMs: number;
  maxItems: number;
  maxBytes: number;
};

/** Summary metadata returned for a Google Drive file. */
export type GoogleDriveFileSummary = {
  id: string;
  name: string;
  mimeType?: string;
  modifiedTime?: string;
  size?: number;
  webViewLink?: string;
};

/** File metadata plus optional bounded text content from Drive or Docs. */
export type GoogleDriveFileReadResult = {
  file: GoogleDriveFileSummary;
  content?: {
    mimeType: string;
    text: string;
    truncated: boolean;
  };
};

type FetchLike = typeof fetch;

type DriveFileListResponse = {
  files?: Array<Record<string, unknown>>;
};

type DriveFileRecord = Record<string, unknown>;

type GoogleDocsResponse = {
  body?: {
    content?: Array<Record<string, unknown>>;
  };
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizeConfigValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeBaseUrl(value: string, fallback: string): string {
  const normalized = value.trim() || fallback;
  return normalized.replace(/\/+$/, "");
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.trunc(value);
}

function isReadableTextMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) {
    return false;
  }
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType.endsWith("+json") ||
    mimeType.endsWith("+xml")
  );
}

function extractDocText(node: unknown): string {
  if (Array.isArray(node)) {
    return node.map((child) => extractDocText(child)).join("");
  }
  const record = asRecord(node);
  if (!record) {
    return "";
  }
  if (Array.isArray(record.content)) {
    return record.content.map((child) => extractDocText(child)).join("");
  }
  const paragraph = asRecord(record.paragraph);
  if (paragraph && Array.isArray(paragraph.elements)) {
    return paragraph.elements
      .map((element) => {
        const textRun = asRecord(asRecord(element)?.textRun);
        return asString(textRun?.content) ?? "";
      })
      .join("");
  }
  const table = asRecord(record.table);
  if (table && Array.isArray(table.tableRows)) {
    return table.tableRows
      .map((row) => {
        const rowRecord = asRecord(row);
        const cells = Array.isArray(rowRecord?.tableCells) ? rowRecord.tableCells : [];
        return cells.map((cell) => extractDocText(asRecord(cell)?.content)).join("\n");
      })
      .join("\n");
  }
  return "";
}

function mapDriveFile(value: DriveFileRecord): GoogleDriveFileSummary | undefined {
  const id = asString(value.id);
  const name = asString(value.name);
  if (!id || !name) {
    return undefined;
  }
  const sizeRaw = asString(value.size);
  const size = sizeRaw ? Number(sizeRaw) : asNumber(value.size);
  return {
    id,
    name,
    ...(asString(value.mimeType) ? { mimeType: asString(value.mimeType) } : {}),
    ...(asString(value.modifiedTime) ? { modifiedTime: asString(value.modifiedTime) } : {}),
    ...(typeof size === "number" && Number.isFinite(size) ? { size } : {}),
    ...(asString(value.webViewLink) ? { webViewLink: asString(value.webViewLink) } : {}),
  };
}

function combineAbortSignals(primary: AbortSignal | undefined, fallback: AbortSignal): AbortSignal {
  return primary ? AbortSignal.any([primary, fallback]) : fallback;
}

/** Minimal Google Drive and Docs API client used by tool handlers. */
export class GoogleDriveService {
  private readonly driveBaseUrl: string;
  private readonly docsBaseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly config: GoogleDriveToolConfig,
    deps: {
      fetchImpl?: FetchLike;
      getEnv?: (name: string) => string | undefined;
    } = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.getEnv = deps.getEnv ?? ((name) => process.env[name]);
    this.driveBaseUrl = normalizeBaseUrl(config.driveBaseUrl || DEFAULT_DRIVE_BASE_URL, DEFAULT_DRIVE_BASE_URL);
    this.docsBaseUrl = normalizeBaseUrl(config.docsBaseUrl || DEFAULT_DOCS_BASE_URL, DEFAULT_DOCS_BASE_URL);
  }

  private readonly getEnv: (name: string) => string | undefined;

  async searchFiles(
    params: {
      query?: string;
      limit?: number;
      includeTrashed?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<{ files: GoogleDriveFileSummary[]; truncated: boolean }> {
    this.assertEnabled();
    const limit = normalizePositiveInt(params.limit, this.config.maxItems);
    const queryParts: string[] = [];
    const query = sanitizeConfigValue(params.query);
    if (query) {
      queryParts.push(`fullText contains '${query.replaceAll("'", "\\'")}'`);
    }
    if (!params.includeTrashed) {
      queryParts.push("trashed=false");
    }
    const searchParams = new URLSearchParams({
      pageSize: String(limit + 1),
      fields: "files(id,name,mimeType,modifiedTime,size,webViewLink)",
      orderBy: "modifiedTime desc",
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true",
      ...(queryParts.length > 0 ? { q: queryParts.join(" and ") } : {}),
    });
    const payload = await this.requestDriveJson<DriveFileListResponse>(`/files?${searchParams.toString()}`, {
      method: "GET",
      signal: params.signal,
    });
    const files = (payload.files ?? [])
      .map((item) => asRecord(item))
      .filter((item): item is DriveFileRecord => Boolean(item))
      .map(mapDriveFile)
      .filter((item): item is GoogleDriveFileSummary => Boolean(item));
    return {
      files: files.slice(0, limit),
      truncated: files.length > limit,
    };
  }

  async getFile(params: {
    fileId: string;
    includeContent?: boolean;
    maxBytes?: number;
    signal?: AbortSignal;
  }): Promise<GoogleDriveFileReadResult> {
    this.assertEnabled();
    const fileId = this.resolveFileId(params.fileId);
    const metadata = await this.requestDriveJson<DriveFileRecord>(
      `/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,modifiedTime,size,webViewLink&supportsAllDrives=true`,
      {
        method: "GET",
        signal: params.signal,
      },
    );
    const file = mapDriveFile(metadata);
    if (!file) {
      throw new Error("Google Drive returned an invalid file payload.");
    }
    if (!params.includeContent) {
      return { file };
    }
    const maxBytes = Math.min(normalizePositiveInt(params.maxBytes, this.config.maxBytes), this.config.maxBytes);
    const mimeType = file.mimeType;
    if (mimeType === "application/vnd.google-apps.document") {
      const doc = await this.requestDocsJson<GoogleDocsResponse>(`/documents/${encodeURIComponent(file.id)}`, {
        signal: params.signal,
      });
      const text = extractDocText(doc.body?.content ?? []);
      const encoded = Buffer.from(text, "utf8");
      const truncated = encoded.byteLength > maxBytes;
      const normalizedText = truncated ? encoded.subarray(0, maxBytes).toString("utf8") : text;
      return {
        file,
        content: {
          mimeType: "text/plain",
          text: normalizedText,
          truncated,
        },
      };
    }
    if (!isReadableTextMimeType(mimeType)) {
      throw new Error(
        `File ${file.id} has unsupported mimeType ${mimeType ?? "unknown"} for inline text reading. ` +
          "Use includeContent=false to inspect metadata only.",
      );
    }
    const text = await this.requestDriveText(
      `/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`,
      params.signal,
    );
    const encoded = Buffer.from(text, "utf8");
    const truncated = encoded.byteLength > maxBytes;
    const normalizedText = truncated ? encoded.subarray(0, maxBytes).toString("utf8") : text;
    return {
      file,
      content: {
        mimeType: mimeType ?? "text/plain",
        text: normalizedText,
        truncated,
      },
    };
  }

  private assertEnabled(): void {
    if (!this.config.enabled) {
      throw new Error("Google Drive integration is disabled. Set tools.googleDrive.enabled=true.");
    }
  }

  private resolveFileId(value: string): string {
    const fileId = sanitizeConfigValue(value);
    if (!fileId) {
      throw new Error("fileId is required.");
    }
    return fileId;
  }

  private resolveToken(): string {
    const envName = sanitizeConfigValue(this.config.accessTokenEnv);
    if (!envName) {
      throw new Error("tools.googleDrive.accessTokenEnv must be configured.");
    }
    const token = sanitizeConfigValue(this.getEnv(envName));
    if (!token) {
      throw new Error(`Google Drive access token is missing in ${envName}.`);
    }
    return token;
  }

  private async requestDriveJson<T extends Record<string, unknown>>(
    path: string,
    options: { method: "GET"; signal?: AbortSignal },
  ): Promise<T> {
    const response = await this.request(`${this.driveBaseUrl}${path}`, {
      method: options.method,
      accept: "application/json",
      signal: options.signal,
    });
    const parsed = await response.json();
    const record = asRecord(parsed);
    if (!record) {
      throw new Error("Google Drive response was not a JSON object.");
    }
    return record as T;
  }

  private async requestDocsJson<T extends Record<string, unknown>>(
    path: string,
    options: { signal?: AbortSignal },
  ): Promise<T> {
    const response = await this.request(`${this.docsBaseUrl}${path}`, {
      method: "GET",
      accept: "application/json",
      signal: options.signal,
    });
    const parsed = await response.json();
    const record = asRecord(parsed);
    if (!record) {
      throw new Error("Google Docs response was not a JSON object.");
    }
    return record as T;
  }

  private async requestDriveText(path: string, signal?: AbortSignal): Promise<string> {
    const response = await this.request(`${this.driveBaseUrl}${path}`, {
      method: "GET",
      accept: "text/plain, application/json;q=0.9, */*;q=0.8",
      signal,
    });
    return response.text();
  }

  private async request(
    url: string,
    options: { method: "GET"; accept: string; signal?: AbortSignal },
  ): Promise<Response> {
    const token = this.resolveToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: options.method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: options.accept,
        },
        signal: combineAbortSignals(options.signal, controller.signal),
      });
      if (!response.ok) {
        let message = response.statusText;
        try {
          const parsed = asRecord(await response.json());
          message = asString(asRecord(parsed?.error)?.message) ?? message;
        } catch {
          // ignore parse errors and keep status text
        }
        throw new Error(`Google API request failed (${response.status}): ${message || "Unknown error"}`);
      }
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }
}
