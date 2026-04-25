export type TelegramCallbackAction =
  | { type: "project_approve"; approvalId: string }
  | { type: "tool_approve"; auditId: string };

const PREFIX = "mb";
const PROJECT_APPROVE = "pa";
const TOOL_APPROVE = "ta";
const CALLBACK_DATA_MAX_BYTES = 64;

function assertCallbackDataFits(data: string): string {
  if (Buffer.byteLength(data, "utf8") > CALLBACK_DATA_MAX_BYTES) {
    throw new Error("Telegram callback data is too long.");
  }
  return data;
}

export function buildProjectApprovalCallbackData(approvalId: string): string {
  return assertCallbackDataFits(`${PREFIX}:${PROJECT_APPROVE}:${approvalId}`);
}

export function buildToolApprovalCallbackData(auditId: string): string {
  return assertCallbackDataFits(`${PREFIX}:${TOOL_APPROVE}:${auditId}`);
}

export function parseTelegramCallbackData(data: string): TelegramCallbackAction | undefined {
  const [prefix, action, ...rest] = data.split(":");
  const id = rest.join(":").trim();
  if (prefix !== PREFIX || !id) {
    return undefined;
  }
  if (action === PROJECT_APPROVE) {
    return { type: "project_approve", approvalId: id };
  }
  if (action === TOOL_APPROVE) {
    return { type: "tool_approve", auditId: id };
  }
  return undefined;
}
