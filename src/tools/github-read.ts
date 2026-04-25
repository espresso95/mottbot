import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SENSITIVE_TEXT_PATTERN =
  /(gho_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|Bearer\s+[A-Za-z0-9._-]+|Authorization:\s*[^\s]+)/gi;

/** Runtime configuration for GitHub CLI-backed tool operations. */
type GithubToolConfig = {
  defaultRepository?: string;
  command: string;
  commandTimeoutMs: number;
  maxItems: number;
  maxOutputBytes: number;
};

/** Repository metadata returned by GitHub read tools. */
type GithubRepositoryMetadata = {
  repository: string;
  url: string;
  description: string;
  defaultBranch?: string;
  isPrivate: boolean;
  isArchived: boolean;
  isFork: boolean;
  viewerPermission?: string;
  pushedAt?: string;
};

/** Summary of an open pull request returned by GitHub read tools. */
type GithubPullRequestSummary = {
  number: number;
  title: string;
  author?: string;
  url: string;
  headRefName?: string;
  baseRefName?: string;
  isDraft: boolean;
  mergeStateStatus?: string;
  reviewDecision?: string;
  updatedAt?: string;
};

/** Summary of an issue returned by GitHub read tools. */
type GithubIssueSummary = {
  number: number;
  title: string;
  author?: string;
  url: string;
  labels: string[];
  updatedAt?: string;
};

/** Summary of a GitHub Actions workflow run. */
type GithubWorkflowRunSummary = {
  databaseId: number;
  workflowName: string;
  displayTitle: string;
  status: string;
  conclusion?: string;
  headBranch?: string;
  headSha?: string;
  event?: string;
  url: string;
  createdAt?: string;
  updatedAt?: string;
};

/** Result returned after creating an issue through GitHub write tools. */
type GithubCreatedIssue = {
  ok: true;
  action: "created_issue";
  repository: string;
  number?: number;
  title: string;
  url?: string;
  labels: string[];
};

/** Result returned after commenting on an issue or pull request. */
type GithubCommentResult = {
  ok: true;
  action: "commented_issue" | "commented_pull_request";
  repository: string;
  number: number;
  url?: string;
};

/** Read-only GitHub operations exposed to tool handlers. */
export type GithubReadOperations = {
  repository(params?: { repository?: string }): Promise<GithubRepositoryMetadata>;
  openPullRequests(params?: { repository?: string; limit?: number }): Promise<{
    repository: string;
    pullRequests: GithubPullRequestSummary[];
    truncated: boolean;
  }>;
  recentIssues(params?: { repository?: string; limit?: number }): Promise<{
    repository: string;
    issues: GithubIssueSummary[];
    truncated: boolean;
  }>;
  ciStatus(params?: { repository?: string; limit?: number }): Promise<{
    repository: string;
    runs: GithubWorkflowRunSummary[];
    truncated: boolean;
  }>;
  recentWorkflowFailures(params?: { repository?: string; limit?: number }): Promise<{
    repository: string;
    runs: GithubWorkflowRunSummary[];
    truncated: boolean;
  }>;
};

/** Side-effecting GitHub operations exposed behind tool approval. */
export type GithubWriteOperations = {
  createIssue(params: {
    repository?: string;
    title: string;
    body?: string;
    labels?: string[];
  }): Promise<GithubCreatedIssue>;
  commentOnIssue(params: { repository?: string; number: number; body: string }): Promise<GithubCommentResult>;
  commentOnPullRequest(params: { repository?: string; number: number; body: string }): Promise<GithubCommentResult>;
};

type CommandResult = {
  stdout: string;
  stderr: string;
};

/** Injectable GitHub CLI command runner used by the GitHub service. */
export type GithubCommandRunner = (params: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxBuffer: number;
}) => Promise<CommandResult>;

type ExecFileError = Error & {
  stderr?: string;
  stdout?: string;
  code?: number | string;
};

function sanitizeCliText(value: string): string {
  return value.replace(SENSITIVE_TEXT_PATTERN, "[redacted]").trim();
}

async function defaultRunner(params: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxBuffer: number;
}): Promise<CommandResult> {
  try {
    const result = await execFileAsync(params.command, params.args, {
      cwd: params.cwd,
      timeout: params.timeoutMs,
      maxBuffer: params.maxBuffer,
      encoding: "utf8",
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (caught) {
    const error = caught as ExecFileError;
    throw new Error(sanitizeCliText(error.stderr || error.stdout || error.message), { cause: caught });
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const sanitized = sanitizeCliText(value);
  return sanitized ? sanitized : undefined;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

function normalizeRepository(value: string): string {
  const trimmed = value.trim().replace(/\.git$/i, "");
  if (!REPOSITORY_PATTERN.test(trimmed)) {
    throw new Error("GitHub repository must be in owner/name form.");
  }
  return trimmed;
}

function normalizeLabels(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map(sanitizeCliText).filter(Boolean))].slice(0, 10);
}

function parseIssueNumberFromUrl(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const match = /\/issues\/(\d+)(?:[#/?].*)?$/i.exec(value.trim());
  return match?.[1] ? Number(match[1]) : undefined;
}

function parseGithubUrl(value: string): string | undefined {
  const firstLine = sanitizeCliText(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return undefined;
  }
  try {
    const parsed = new URL(firstLine);
    return parsed.hostname.toLowerCase() === "github.com" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Parses common GitHub remote URL formats into owner/repository form. */
export function parseGithubRemoteUrl(value: string): string | undefined {
  const trimmed = value.trim();
  const scpLike = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i.exec(trimmed);
  if (scpLike?.[1]) {
    return normalizeRepository(scpLike[1]);
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.toLowerCase() !== "github.com") {
      return undefined;
    }
    const pathParts = parsed.pathname
      .replace(/^\/+/, "")
      .replace(/\.git$/i, "")
      .split("/");
    if (pathParts.length < 2) {
      return undefined;
    }
    return normalizeRepository(`${pathParts[0]}/${pathParts[1]}`);
  } catch {
    return undefined;
  }
}

/** Formats repository metadata for operator-facing tool output. */
export function formatGithubRepositoryMetadata(metadata: GithubRepositoryMetadata): string {
  return [
    `GitHub repository: ${metadata.repository}`,
    `URL: ${metadata.url}`,
    `Description: ${metadata.description || "(none)"}`,
    `Default branch: ${metadata.defaultBranch ?? "(unknown)"}`,
    `Visibility: ${metadata.isPrivate ? "private" : "public"}`,
    `Archived: ${metadata.isArchived ? "yes" : "no"}`,
    `Fork: ${metadata.isFork ? "yes" : "no"}`,
    ...(metadata.viewerPermission ? [`Permission: ${metadata.viewerPermission}`] : []),
    ...(metadata.pushedAt ? [`Pushed: ${metadata.pushedAt}`] : []),
  ].join("\n");
}

/** Formats open pull request summaries for operator-facing tool output. */
export function formatGithubPullRequests(repository: string, pullRequests: GithubPullRequestSummary[]): string {
  if (pullRequests.length === 0) {
    return `Open pull requests for ${repository}: none.`;
  }
  return [
    `Open pull requests for ${repository}:`,
    ...pullRequests.map((pr) =>
      [
        `#${pr.number}`,
        pr.isDraft ? "[draft]" : undefined,
        pr.title,
        pr.author ? `by ${pr.author}` : undefined,
        pr.updatedAt ? `updated ${pr.updatedAt}` : undefined,
        pr.url,
      ]
        .filter(Boolean)
        .join(" "),
    ),
  ].join("\n");
}

/** Formats issue summaries for operator-facing tool output. */
export function formatGithubIssues(repository: string, issues: GithubIssueSummary[]): string {
  if (issues.length === 0) {
    return `Open issues for ${repository}: none.`;
  }
  return [
    `Open issues for ${repository}:`,
    ...issues.map((issue) =>
      [
        `#${issue.number}`,
        issue.title,
        issue.labels.length > 0 ? `[${issue.labels.join(", ")}]` : undefined,
        issue.author ? `by ${issue.author}` : undefined,
        issue.updatedAt ? `updated ${issue.updatedAt}` : undefined,
        issue.url,
      ]
        .filter(Boolean)
        .join(" "),
    ),
  ].join("\n");
}

/** Formats GitHub Actions workflow run summaries for operator-facing tool output. */
export function formatGithubWorkflowRuns(params: {
  repository: string;
  title: string;
  runs: GithubWorkflowRunSummary[];
}): string {
  if (params.runs.length === 0) {
    return `${params.title} for ${params.repository}: none.`;
  }
  return [
    `${params.title} for ${params.repository}:`,
    ...params.runs.map((run) => {
      const sha = run.headSha ? run.headSha.slice(0, 8) : undefined;
      return [
        `${run.workflowName}:`,
        `${run.status}${run.conclusion ? `/${run.conclusion}` : ""}`,
        run.displayTitle,
        run.headBranch ? `branch=${run.headBranch}` : undefined,
        sha ? `sha=${sha}` : undefined,
        run.createdAt ? `created=${run.createdAt}` : undefined,
        run.url,
      ]
        .filter(Boolean)
        .join(" ");
    }),
  ].join("\n");
}

/** Formats a combined GitHub repository, PR, issue, and CI status summary. */
export function formatGithubStatusSummary(params: {
  metadata: GithubRepositoryMetadata;
  pullRequests: GithubPullRequestSummary[];
  pullRequestsTruncated?: boolean;
  issues: GithubIssueSummary[];
  issuesTruncated?: boolean;
  runs: GithubWorkflowRunSummary[];
}): string {
  const latestRun = params.runs[0];
  const prCount = `${params.pullRequests.length}${params.pullRequestsTruncated ? "+" : ""}`;
  const issueCount = `${params.issues.length}${params.issuesTruncated ? "+" : ""}`;
  return [
    `GitHub: ${params.metadata.repository}`,
    `URL: ${params.metadata.url}`,
    `Default branch: ${params.metadata.defaultBranch ?? "(unknown)"}`,
    `Visibility: ${params.metadata.isPrivate ? "private" : "public"}${params.metadata.isArchived ? ", archived" : ""}`,
    `Open PRs listed: ${prCount}`,
    `Open issues listed: ${issueCount}`,
    latestRun
      ? `Latest CI: ${latestRun.workflowName} ${latestRun.status}${latestRun.conclusion ? `/${latestRun.conclusion}` : ""} ${latestRun.url}`
      : "Latest CI: none found",
  ].join("\n");
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("GitHub CLI returned malformed JSON.");
  }
}

function parseRepositoryMetadata(repository: string, raw: unknown): GithubRepositoryMetadata {
  const record = asRecord(raw);
  if (!record) {
    throw new Error("GitHub repository metadata response was malformed.");
  }
  const defaultBranch = stringValue(asRecord(record.defaultBranchRef)?.name);
  const url = stringValue(record.url);
  if (!url) {
    throw new Error("GitHub repository metadata did not include a URL.");
  }
  return {
    repository: stringValue(record.nameWithOwner) ?? repository,
    url,
    description: stringValue(record.description) ?? "",
    ...(defaultBranch ? { defaultBranch } : {}),
    isPrivate: booleanValue(record.isPrivate),
    isArchived: booleanValue(record.isArchived),
    isFork: booleanValue(record.isFork),
    ...(stringValue(record.viewerPermission) ? { viewerPermission: stringValue(record.viewerPermission)! } : {}),
    ...(stringValue(record.pushedAt) ? { pushedAt: stringValue(record.pushedAt)! } : {}),
  };
}

function authorLogin(value: unknown): string | undefined {
  return stringValue(asRecord(value)?.login);
}

function parsePullRequest(raw: unknown): GithubPullRequestSummary | undefined {
  const record = asRecord(raw);
  const number = numberValue(record?.number);
  const title = stringValue(record?.title);
  const url = stringValue(record?.url);
  if (!record || number === undefined || !title || !url) {
    return undefined;
  }
  return {
    number,
    title,
    ...(authorLogin(record.author) ? { author: authorLogin(record.author)! } : {}),
    url,
    ...(stringValue(record.headRefName) ? { headRefName: stringValue(record.headRefName)! } : {}),
    ...(stringValue(record.baseRefName) ? { baseRefName: stringValue(record.baseRefName)! } : {}),
    isDraft: booleanValue(record.isDraft),
    ...(stringValue(record.mergeStateStatus) ? { mergeStateStatus: stringValue(record.mergeStateStatus)! } : {}),
    ...(stringValue(record.reviewDecision) ? { reviewDecision: stringValue(record.reviewDecision)! } : {}),
    ...(stringValue(record.updatedAt) ? { updatedAt: stringValue(record.updatedAt)! } : {}),
  };
}

function parseIssue(raw: unknown): GithubIssueSummary | undefined {
  const record = asRecord(raw);
  const number = numberValue(record?.number);
  const title = stringValue(record?.title);
  const url = stringValue(record?.url);
  if (!record || number === undefined || !title || !url) {
    return undefined;
  }
  return {
    number,
    title,
    ...(authorLogin(record.author) ? { author: authorLogin(record.author)! } : {}),
    url,
    labels: asArray(record.labels)
      .map((label) => stringValue(asRecord(label)?.name))
      .filter((label): label is string => Boolean(label)),
    ...(stringValue(record.updatedAt) ? { updatedAt: stringValue(record.updatedAt)! } : {}),
  };
}

function parseWorkflowRun(raw: unknown): GithubWorkflowRunSummary | undefined {
  const record = asRecord(raw);
  const databaseId = numberValue(record?.databaseId);
  const workflowName = stringValue(record?.workflowName);
  const displayTitle = stringValue(record?.displayTitle);
  const status = stringValue(record?.status);
  const url = stringValue(record?.url);
  if (!record || databaseId === undefined || !workflowName || !displayTitle || !status || !url) {
    return undefined;
  }
  return {
    databaseId,
    workflowName,
    displayTitle,
    status,
    ...(stringValue(record.conclusion) ? { conclusion: stringValue(record.conclusion)! } : {}),
    ...(stringValue(record.headBranch) ? { headBranch: stringValue(record.headBranch)! } : {}),
    ...(stringValue(record.headSha) ? { headSha: stringValue(record.headSha)! } : {}),
    ...(stringValue(record.event) ? { event: stringValue(record.event)! } : {}),
    url,
    ...(stringValue(record.createdAt) ? { createdAt: stringValue(record.createdAt)! } : {}),
    ...(stringValue(record.updatedAt) ? { updatedAt: stringValue(record.updatedAt)! } : {}),
  };
}

/** GitHub service implemented through the local gh CLI with redacted output handling. */
export class GithubCliReadService implements GithubReadOperations, GithubWriteOperations {
  constructor(
    private readonly config: GithubToolConfig,
    private readonly runner: GithubCommandRunner = defaultRunner,
    private readonly cwd = process.cwd(),
  ) {}

  async repository(params: { repository?: string } = {}): Promise<GithubRepositoryMetadata> {
    const repository = await this.resolveRepository(params.repository);
    const output = await this.runGh([
      "repo",
      "view",
      repository,
      "--json",
      "nameWithOwner,description,isPrivate,isArchived,isFork,defaultBranchRef,url,pushedAt,viewerPermission",
    ]);
    return parseRepositoryMetadata(repository, parseJson(output.stdout));
  }

  async openPullRequests(params: { repository?: string; limit?: number } = {}) {
    const repository = await this.resolveRepository(params.repository);
    const limit = clampLimit(params.limit, this.config.maxItems, this.config.maxItems);
    const output = await this.runGh([
      "pr",
      "list",
      "--repo",
      repository,
      "--state",
      "open",
      "--limit",
      String(limit),
      "--json",
      "number,title,author,headRefName,baseRefName,isDraft,mergeStateStatus,reviewDecision,url,updatedAt",
    ]);
    const pullRequests = asArray(parseJson(output.stdout))
      .map(parsePullRequest)
      .filter((item): item is GithubPullRequestSummary => Boolean(item));
    return {
      repository,
      pullRequests,
      truncated: pullRequests.length >= limit,
    };
  }

  async recentIssues(params: { repository?: string; limit?: number } = {}) {
    const repository = await this.resolveRepository(params.repository);
    const limit = clampLimit(params.limit, this.config.maxItems, this.config.maxItems);
    const output = await this.runGh([
      "issue",
      "list",
      "--repo",
      repository,
      "--state",
      "open",
      "--limit",
      String(limit),
      "--json",
      "number,title,author,labels,url,updatedAt",
    ]);
    const issues = asArray(parseJson(output.stdout))
      .map(parseIssue)
      .filter((item): item is GithubIssueSummary => Boolean(item));
    return {
      repository,
      issues,
      truncated: issues.length >= limit,
    };
  }

  async ciStatus(params: { repository?: string; limit?: number } = {}) {
    const repository = await this.resolveRepository(params.repository);
    const limit = clampLimit(params.limit, this.config.maxItems, this.config.maxItems);
    const runs = await this.listWorkflowRuns(repository, limit);
    return {
      repository,
      runs,
      truncated: runs.length >= limit,
    };
  }

  async recentWorkflowFailures(params: { repository?: string; limit?: number } = {}) {
    const repository = await this.resolveRepository(params.repository);
    const limit = clampLimit(params.limit, this.config.maxItems, this.config.maxItems);
    const runs = (await this.listWorkflowRuns(repository, Math.min(limit * 3, 100)))
      .filter((run) => run.conclusion === "failure")
      .slice(0, limit);
    return {
      repository,
      runs,
      truncated: runs.length >= limit,
    };
  }

  async createIssue(params: {
    repository?: string;
    title: string;
    body?: string;
    labels?: string[];
  }): Promise<GithubCreatedIssue> {
    const title = sanitizeCliText(params.title);
    if (!title) {
      throw new Error("GitHub issue title is required.");
    }
    const labels = normalizeLabels(params.labels);
    const body = sanitizeCliText(params.body ?? "");
    const repository = await this.resolveRepository(params.repository);
    const args = [
      "issue",
      "create",
      "--repo",
      repository,
      "--title",
      title,
      "--body",
      body,
      ...labels.flatMap((label) => ["--label", label]),
    ];
    const output = await this.runGh(args);
    const url = parseGithubUrl(output.stdout);
    const number = parseIssueNumberFromUrl(url);
    return {
      ok: true,
      action: "created_issue",
      repository,
      ...(number ? { number } : {}),
      title,
      ...(url ? { url } : {}),
      labels,
    };
  }

  async commentOnIssue(params: { repository?: string; number: number; body: string }): Promise<GithubCommentResult> {
    return await this.comment({
      repository: params.repository,
      number: params.number,
      body: params.body,
      kind: "issue",
    });
  }

  async commentOnPullRequest(params: {
    repository?: string;
    number: number;
    body: string;
  }): Promise<GithubCommentResult> {
    return await this.comment({
      repository: params.repository,
      number: params.number,
      body: params.body,
      kind: "pr",
    });
  }

  private async listWorkflowRuns(repository: string, limit: number): Promise<GithubWorkflowRunSummary[]> {
    const output = await this.runGh([
      "run",
      "list",
      "--repo",
      repository,
      "--limit",
      String(limit),
      "--json",
      "databaseId,workflowName,status,conclusion,headBranch,headSha,event,displayTitle,url,createdAt,updatedAt",
    ]);
    return asArray(parseJson(output.stdout))
      .map(parseWorkflowRun)
      .filter((item): item is GithubWorkflowRunSummary => Boolean(item));
  }

  private async comment(params: {
    repository?: string;
    number: number;
    body: string;
    kind: "issue" | "pr";
  }): Promise<GithubCommentResult> {
    if (!Number.isInteger(params.number) || params.number < 1) {
      throw new Error("GitHub issue or pull request number must be a positive integer.");
    }
    const body = sanitizeCliText(params.body);
    if (!body) {
      throw new Error("GitHub comment body is required.");
    }
    const repository = await this.resolveRepository(params.repository);
    const output = await this.runGh([
      params.kind,
      "comment",
      String(params.number),
      "--repo",
      repository,
      "--body",
      body,
    ]);
    const url = parseGithubUrl(output.stdout);
    return {
      ok: true,
      action: params.kind === "issue" ? "commented_issue" : "commented_pull_request",
      repository,
      number: params.number,
      ...(url ? { url } : {}),
    };
  }

  private async resolveRepository(input: string | undefined): Promise<string> {
    if (input?.trim()) {
      return normalizeRepository(input);
    }
    if (this.config.defaultRepository?.trim()) {
      return normalizeRepository(this.config.defaultRepository);
    }
    const remote = await this.runner({
      command: "git",
      args: ["remote", "get-url", "origin"],
      cwd: this.cwd,
      timeoutMs: this.config.commandTimeoutMs,
      maxBuffer: 16_000,
    });
    const repository = parseGithubRemoteUrl(remote.stdout);
    if (!repository) {
      throw new Error("GitHub repository is not configured; set tools.github.defaultRepository or pass repository.");
    }
    return repository;
  }

  private runGh(args: string[]): Promise<CommandResult> {
    return this.runner({
      command: this.config.command,
      args,
      cwd: this.cwd,
      timeoutMs: this.config.commandTimeoutMs,
      maxBuffer: Math.max(this.config.maxOutputBytes * 2, 64_000),
    });
  }
}
