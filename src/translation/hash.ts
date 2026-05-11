import type { TranslationCacheKey } from "@/translation/types";

export type CreateCacheKeyInput = Omit<
  TranslationCacheKey,
  "normalizedTextHash"
> & {
  sourceText: string;
};

export function normalizeSourceText(sourceText: string): string {
  return sourceText.replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

export async function hashNormalizedText(sourceText: string): Promise<string> {
  const normalizedText = normalizeSourceText(sourceText);
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalizedText),
  );

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function createCacheKey(
  input: CreateCacheKeyInput,
): Promise<TranslationCacheKey> {
  return {
    normalizedTextHash: await hashNormalizedText(input.sourceText),
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    providerId: input.providerId,
    textModel: input.textModel,
    translationStyle: input.translationStyle,
    promptVersion: input.promptVersion,
  };
}

export function serializeCacheKey(key: TranslationCacheKey): string {
  return JSON.stringify({
    normalizedTextHash: key.normalizedTextHash,
    sourceLanguage: key.sourceLanguage,
    targetLanguage: key.targetLanguage,
    providerId: key.providerId,
    textModel: key.textModel,
    translationStyle: key.translationStyle,
    promptVersion: key.promptVersion,
  });
}
