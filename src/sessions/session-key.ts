import type { SessionRouteMode } from "./types.js";

export function buildSessionKey(params: {
  chatType: "private" | "group" | "supergroup" | "channel";
  chatId: string;
  threadId?: number;
  userId?: string;
  boundName?: string;
}): { sessionKey: string; routeMode: SessionRouteMode } {
  if (params.boundName) {
    return {
      sessionKey: `tg:bound:${params.boundName}`,
      routeMode: "bound",
    };
  }
  if (params.chatType === "private") {
    if (params.userId) {
      return {
        sessionKey: `tg:dm:${params.chatId}:user:${params.userId}`,
        routeMode: "dm",
      };
    }
    return {
      sessionKey: `tg:dm:${params.chatId}`,
      routeMode: "dm",
    };
  }
  if (typeof params.threadId === "number") {
    return {
      sessionKey: `tg:group:${params.chatId}:topic:${params.threadId}`,
      routeMode: "topic",
    };
  }
  return {
    sessionKey: `tg:group:${params.chatId}`,
    routeMode: "group",
  };
}
