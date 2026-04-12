import { describe, expect, it } from "vitest";
import { buildSessionKey } from "../../src/sessions/session-key.js";

describe("buildSessionKey", () => {
  it("builds a dm key", () => {
    expect(buildSessionKey({ chatType: "private", chatId: "1", userId: "u1" })).toEqual({
      sessionKey: "tg:dm:1:user:u1",
      routeMode: "dm",
    });
  });

  it("builds a topic key", () => {
    expect(buildSessionKey({ chatType: "supergroup", chatId: "2", threadId: 9 })).toEqual({
      sessionKey: "tg:group:2:topic:9",
      routeMode: "topic",
    });
  });

  it("builds a bound key", () => {
    expect(buildSessionKey({ chatType: "group", chatId: "3", boundName: "ops" })).toEqual({
      sessionKey: "tg:bound:ops",
      routeMode: "bound",
    });
  });
});
