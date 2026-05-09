import { serializeCacheKey } from "@/translation/hash";
import type { TranslationCacheKey, TranslationResultItem } from "@/translation/types";

export class SessionTranslationCache {
  private readonly entries = new Map<string, TranslationResultItem>();

  get(key: TranslationCacheKey): TranslationResultItem | undefined {
    return this.entries.get(serializeCacheKey(key));
  }

  set(key: TranslationCacheKey, value: TranslationResultItem): void {
    this.entries.set(serializeCacheKey(key), value);
  }

  clear(): void {
    this.entries.clear();
  }
}
