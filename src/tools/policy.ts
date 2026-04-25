import crypto from "node:crypto";
import type { ToolDefinition, ToolSideEffect } from "./registry.js";

export type ToolCallerRole = "owner" | "admin" | "trusted" | "user";

export type ToolPolicyConfig = {
  allowedRoles?: ToolCallerRole[];
  allowedChatIds?: string[];
  requiresApproval?: boolean;
  dryRun?: boolean;
  maxOutputBytes?: number;
};

export type ToolPolicy = {
  toolName: string;
  allowedRoles: ToolCallerRole[];
  allowedChatIds: string[];
  requiresApproval: boolean;
  dryRun: boolean;
  maxOutputBytes: number;
};

export type ToolPolicyContext = {
  role: ToolCallerRole;
  chatId?: string;
};

export type ToolPolicyDecision =
  | {
      allowed: true;
      code: "policy_allowed";
      policy: ToolPolicy;
      message: string;
    }
  | {
      allowed: false;
      code: "policy_missing" | "role_denied" | "chat_denied";
      message: string;
      policy?: ToolPolicy;
    };

export type ToolPolicyEvaluationOptions = {
  override?: ToolPolicyConfig;
};

const SENSITIVE_KEY_PATTERN = /(api[_-]?key|authorization|bearer|credential|hash|password|secret|token)/i;
const MAX_PREVIEW_ARGUMENT_CHARS = 1_200;

function uniqueRoles(values: ToolCallerRole[]): ToolCallerRole[] {
  return [...new Set(values)];
}

export function isToolAdminRole(role: ToolCallerRole): boolean {
  return role === "owner" || role === "admin";
}

function sanitizeArgument(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.slice(0, 25).map(sanitizeArgument);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : sanitizeArgument(child);
  }
  return output;
}

function stringifyBounded(value: unknown, maxChars = MAX_PREVIEW_ARGUMENT_CHARS): string {
  const raw = JSON.stringify(value, null, 2) ?? "null";
  if (raw.length <= maxChars) {
    return raw;
  }
  return `${raw.slice(0, Math.max(0, maxChars - 34)).trimEnd()}\n...[arguments truncated for preview]`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function sideEffectDescription(sideEffect: ToolSideEffect): string {
  switch (sideEffect) {
    case "read_only":
      return "read local runtime data";
    case "local_write":
      return "write local files";
    case "local_exec":
      return "run configured local commands";
    case "network":
      return "call an external or Telegram network API";
    case "network_write":
      return "write through an external network API";
    case "telegram_send":
      return "send messages or reactions through the Telegram Bot API";
    case "github_write":
      return "write through the GitHub API";
    case "process_control":
      return "control the local Mottbot process";
    case "secret_adjacent":
      return "read or touch sensitive local state";
  }
}

function defaultPolicy(definition: ToolDefinition): ToolPolicy {
  return {
    toolName: definition.name,
    allowedRoles: definition.requiresAdmin ? ["owner", "admin"] : ["owner", "admin", "trusted", "user"],
    allowedChatIds: [],
    requiresApproval: definition.sideEffect !== "read_only",
    dryRun: false,
    maxOutputBytes: definition.maxOutputBytes,
  };
}

function mergePolicy(definition: ToolDefinition, override: ToolPolicyConfig | undefined): ToolPolicy {
  const base = defaultPolicy(definition);
  const requestedRoles = uniqueRoles(override?.allowedRoles ?? base.allowedRoles);
  return {
    toolName: definition.name,
    allowedRoles: definition.requiresAdmin
      ? uniqueRoles(["owner", ...requestedRoles.filter(isToolAdminRole)])
      : requestedRoles,
    allowedChatIds: override?.allowedChatIds?.map((chatId) => chatId.trim()).filter(Boolean) ?? base.allowedChatIds,
    requiresApproval: definition.sideEffect === "read_only" ? false : true,
    dryRun: override?.dryRun ?? base.dryRun,
    maxOutputBytes: Math.min(override?.maxOutputBytes ?? base.maxOutputBytes, definition.maxOutputBytes),
  };
}

function intersectRoles(left: ToolCallerRole[], right: ToolCallerRole[]): ToolCallerRole[] {
  const rightSet = new Set(right);
  return left.filter((role) => rightSet.has(role));
}

function intersectChatIds(left: string[], right: string[]): string[] {
  if (left.length === 0) {
    return right;
  }
  if (right.length === 0) {
    return left;
  }
  const rightSet = new Set(right);
  return left.filter((chatId) => rightSet.has(chatId));
}

function applyAdditionalPolicy(
  definition: ToolDefinition,
  base: ToolPolicy,
  override: ToolPolicyConfig | undefined,
): ToolPolicy {
  if (!override) {
    return base;
  }
  const overridePolicy = mergePolicy(definition, override);
  return {
    toolName: base.toolName,
    allowedRoles: uniqueRoles(intersectRoles(base.allowedRoles, overridePolicy.allowedRoles)),
    allowedChatIds: intersectChatIds(base.allowedChatIds, overridePolicy.allowedChatIds),
    requiresApproval: base.requiresApproval || overridePolicy.requiresApproval,
    dryRun: base.dryRun || overridePolicy.dryRun,
    maxOutputBytes: Math.min(base.maxOutputBytes, overridePolicy.maxOutputBytes),
  };
}

export class ToolPolicyEngine {
  private readonly policies = new Map<string, ToolPolicy>();

  constructor(policies: readonly ToolPolicy[]) {
    for (const policy of policies) {
      this.policies.set(policy.toolName, policy);
    }
  }

  get(toolName: string): ToolPolicy | undefined {
    return this.policies.get(toolName);
  }

  evaluate(
    definition: ToolDefinition,
    context: ToolPolicyContext,
    options: ToolPolicyEvaluationOptions = {},
  ): ToolPolicyDecision {
    const basePolicy = this.get(definition.name);
    const policy = basePolicy ? applyAdditionalPolicy(definition, basePolicy, options.override) : undefined;
    if (!policy) {
      return {
        allowed: false,
        code: "policy_missing",
        message: `Tool ${definition.name} has no runtime policy.`,
      };
    }
    if (!policy.allowedRoles.includes(context.role)) {
      return {
        allowed: false,
        code: "role_denied",
        policy,
        message: `Tool ${definition.name} is not allowed for ${context.role} callers.`,
      };
    }
    if (policy.allowedChatIds.length > 0 && (!context.chatId || !policy.allowedChatIds.includes(context.chatId))) {
      return {
        allowed: false,
        code: "chat_denied",
        policy,
        message: `Tool ${definition.name} is not allowed in this chat.`,
      };
    }
    return {
      allowed: true,
      code: "policy_allowed",
      policy,
      message: `Tool ${definition.name} is allowed by policy.`,
    };
  }
}

export function validateToolPolicyReferences(params: {
  definitions: readonly ToolDefinition[];
  toolNames?: readonly string[];
  overrides?: Record<string, ToolPolicyConfig>;
  label: string;
}): void {
  const definitionsByName = new Set(params.definitions.map((definition) => definition.name));
  for (const toolName of params.toolNames ?? []) {
    if (!definitionsByName.has(toolName)) {
      throw new Error(`${params.label} references unknown or disabled tool ${toolName}.`);
    }
  }
  for (const toolName of Object.keys(params.overrides ?? {})) {
    if (!definitionsByName.has(toolName)) {
      throw new Error(`${params.label} policy references unknown or disabled tool ${toolName}.`);
    }
  }
}

export function createToolPolicyEngine(params: {
  definitions: readonly ToolDefinition[];
  overrides?: Record<string, ToolPolicyConfig>;
}): ToolPolicyEngine {
  validateToolPolicyReferences({
    definitions: params.definitions,
    overrides: params.overrides,
    label: "Tool",
  });
  return new ToolPolicyEngine(
    params.definitions.map((definition) => mergePolicy(definition, params.overrides?.[definition.name])),
  );
}

export function createToolRequestFingerprint(params: { toolName: string; arguments: Record<string, unknown> }): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ toolName: params.toolName, arguments: canonicalize(params.arguments) }))
    .digest("hex");
}

export function buildToolApprovalPreview(params: {
  definition: ToolDefinition;
  policy: ToolPolicy;
  arguments: Record<string, unknown>;
}): string {
  const sanitized = sanitizeArgument(params.arguments);
  return [
    `Tool: ${params.definition.name}`,
    `Action: ${params.definition.description}`,
    `Side effect: ${sideEffectDescription(params.definition.sideEffect)}`,
    `Approval required: ${params.policy.requiresApproval ? "yes" : "no"}`,
    `Dry run available: ${params.policy.dryRun ? "yes" : "no"}`,
    `Maximum output: ${params.policy.maxOutputBytes} bytes`,
    "Arguments:",
    stringifyBounded(sanitized),
  ].join("\n");
}
