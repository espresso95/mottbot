import type { TelegramReactionService } from "../telegram/reactions.js";
import type { ToolHandler } from "./executor.js";

export function createTelegramReactionToolHandlers(reactions: TelegramReactionService): Record<string, ToolHandler> {
  return {
    mottbot_telegram_react: async ({ arguments: input }) => {
      const chatId = String(input.chatId);
      const messageId = Number(input.messageId);
      const emoji = typeof input.emoji === "string" ? input.emoji : "";
      const isBig = input.isBig === true;
      await reactions.setEmojiReaction({
        chatId,
        messageId,
        emoji,
        isBig,
      });
      return {
        ok: true,
        action: emoji ? "set_reaction" : "clear_reaction",
        chatId,
        messageId,
        ...(emoji ? { emoji } : {}),
      };
    },
  };
}
