import { Context, NextFunction } from "grammy";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";

export async function authMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;

  logger.debug(
    `[Auth] Checking access: userId=${userId}, allowedUserId=${config.telegram.allowedUserId}, hasCallbackQuery=${!!ctx.callbackQuery}, hasMessage=${!!ctx.message}`,
  );

  if (userId && userId === config.telegram.allowedUserId) {
    logger.debug(`[Auth] Access granted for userId=${userId}`);
    await next();
  } else if (userId && userId === ctx.me.id) {
    // Updates authored by the bot itself (e.g. the service message about its own pin)
    logger.debug(`[Auth] Ignoring update from the bot itself: userId=${userId}`);
  } else {
    // Silently ignore unauthorized users
    logger.warn(`Unauthorized access attempt from user ID: ${userId}`);

    // Buttons on a guest-mode message are visible to everyone in that chat: say who they are for
    // instead of leaving the tap spinning.
    if (ctx.callbackQuery?.inline_message_id) {
      await ctx
        .answerCallbackQuery({ text: t("guest.connect.not_allowed") })
        .catch((err: unknown) => logger.debug(`[Auth] Could not answer foreign tap: ${err}`));
      return;
    }

    // Actively hide commands for unauthorized users by setting empty command list
    // Only do this if the chat is NOT the authorized user's chat
    // (to avoid resetting commands when forwarded messages are received).
    // A guest message comes from a chat the bot never joined, where it has no commands to hide.
    if (ctx.chat?.id && ctx.chat.id !== config.telegram.allowedUserId && !ctx.guestMessage) {
      try {
        // Set empty commands for this specific chat (more reliable than deleteMyCommands)
        await ctx.api.setMyCommands([], {
          scope: { type: "chat", chat_id: ctx.chat.id },
        });
        logger.debug(`[Auth] Set empty commands for unauthorized chat_id=${ctx.chat.id}`);
      } catch (err) {
        // Ignore errors
        logger.debug(`[Auth] Could not set empty commands: ${err}`);
      }
    }
  }
}
