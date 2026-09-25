import {
  formatAiSentence,
  type AiSentence,
  type AiSentenceCode,
  type AiSentenceParams,
} from '@lazyit/shared';

/**
 * Server-built sentences as English text AND codes (#1384; tools-and-execution.md §9.1). A tool builds a
 * {@link Phrase} from a code of the closed list `AI_SENTENCES` (`@lazyit/shared`); its English is rendered
 * from the code's template, so the text the ledger, the model and MCP read and the codes the web localizes
 * always say the same thing.
 */
export interface Phrase {
  readonly text: string;
  /** Empty for an English-only phrase ({@link englishOnly}): the web then shows `text`. */
  readonly sentences: readonly AiSentence[];
}

type ParamsArg<C extends AiSentenceCode> =
  keyof AiSentenceParams<C> extends never ? [] : [AiSentenceParams<C>];

/** One sentence of the closed list, with exactly the params its template names. */
export function phrase<C extends AiSentenceCode>(
  code: C,
  ...args: ParamsArg<C>
): Phrase {
  const params = (args[0] ?? {}) as Record<string, string | number>;
  return {
    text: formatAiSentence(code, params),
    sentences: [{ code, params: { ...params } }],
  };
}

/**
 * A phrase with no codes, for an edge case the closed list does not model: the web shows the English. A
 * phrase joined with it is English-only too — a sentence is localized whole or not at all.
 */
export function englishOnly(text: string): Phrase {
  return { text, sentences: [] };
}

/** Several phrases as one: the texts joined by one space (the web joins the sentences the same way). */
export function joinPhrases(
  ...parts: readonly (Phrase | null | undefined | false)[]
): Phrase {
  const present = parts.filter((p): p is Phrase => !!p);
  return {
    text: present.map((p) => p.text).join(' '),
    sentences: present.some((p) => p.sentences.length === 0)
      ? []
      : present.flatMap((p) => p.sentences),
  };
}

/** The sentences of a phrase as a wire field, omitted when the phrase is English-only. */
function field<K extends string>(
  key: K,
  p: Phrase,
): Partial<Record<K, AiSentence[]>> {
  return p.sentences.length > 0
    ? ({ [key]: [...p.sentences] } as Record<K, AiSentence[]>)
    : {};
}

/** A preview row's `after` value as a phrase: the English and its sentences. */
export function afterPhrase(p: Phrase): {
  after: string;
  afterSentences?: AiSentence[];
} {
  return { after: p.text, ...field('afterSentences', p) };
}

/** A preview row's `before` value as a phrase. */
export function beforePhrase(p: Phrase): {
  before: string;
  beforeSentences?: AiSentence[];
} {
  return { before: p.text, ...field('beforeSentences', p) };
}

/** A run output's summary as a phrase. */
export function summaryPhrase(p: Phrase): {
  summary: string;
  summarySentences?: AiSentence[];
} {
  return { summary: p.text, ...field('summarySentences', p) };
}

/** An error's message as a phrase. */
export function messagePhrase(p: Phrase): {
  message: string;
  messageSentences?: AiSentence[];
} {
  return { message: p.text, ...field('messageSentences', p) };
}

/** A `YesNo` flag param. */
export const yesNo = (flag: boolean): 'yes' | 'no' => (flag ? 'yes' : 'no');
