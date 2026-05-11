import { serializeCacheKey } from "@/translation/hash";
import type { TranslationCacheKey } from "@/translation/types";

export class SessionTranslationCache {
  private readonly entries = new Map<string, string>();

  get(key: TranslationCacheKey): string | undefined {
    return this.entries.get(serializeCacheKey(key));
  }

  set(key: TranslationCacheKey, value: string): void {
    this.entries.set(serializeCacheKey(key), value);
  }

  clear(): void {
    this.entries.clear();
  }
}
