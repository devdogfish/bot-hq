/** Which model a turn asks Hermes for. */
export interface ModelColumns {
  model?: string | null;
  provider?: string | null;
  chat_model?: string | null;
  chat_provider?: string | null;
}

/** The gateway's own default: Hermes treats this virtual id as "use the configured model". */
export const DEFAULT_MODEL = 'hermes-agent';

/**
 * Direct chat with the Owner uses the chat model when one is picked; every other turn (routines, handoffs from other bots,
 * rooms, system notices) uses the bot's production model. A chat model only counts with its own provider, so a bare
 * chat model never pairs with the production provider.
 */
export function turnModel(bot: ModelColumns, directChat: boolean): { model: string; provider?: string } {
  if (directChat && bot.chat_model) return { model: bot.chat_model, ...(bot.chat_provider ? { provider: bot.chat_provider } : {}) };
  return { model: bot.model || DEFAULT_MODEL, ...(bot.provider ? { provider: bot.provider } : {}) };
}
