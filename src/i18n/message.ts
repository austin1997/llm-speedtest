import { FALLBACK_LOCALE } from './locales';
import { renderMessage } from './translate';
import type { MessageKey, Msg, ParamArgs } from './types';

/** Build a message descriptor. It stays language-neutral until it is displayed. */
export function msg<K extends MessageKey>(key: K, ...args: ParamArgs<K>): Msg {
  const params = args[0] as Msg['params'];
  return params ? { key, params } : { key };
}

/**
 * An error whose text is chosen by the UI. Library code reports *what* happened;
 * the interface decides how to say it in the active language.
 * `message` carries the English rendering for logs and debugging.
 */
export class LocalizedError<K extends MessageKey = MessageKey> extends Error {
  readonly msg: Msg;
  constructor(key: K, ...args: ParamArgs<K>) {
    const descriptor = msg(key, ...args);
    super(renderMessage(FALLBACK_LOCALE, descriptor));
    this.name = 'LocalizedError';
    this.msg = descriptor;
  }
}

/** Turn anything thrown into a displayable message descriptor. */
export function describeError(error: unknown): Msg {
  if (error instanceof LocalizedError) return error.msg;
  if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) return msg('error.connection');
  return msg('error.raw', { text: error instanceof Error ? error.message : String(error) });
}
