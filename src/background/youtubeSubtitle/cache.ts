const defaultSubtitleTranslationCacheCapacity = 500;

export class SubtitleTranslationCache<TValue> {
  private readonly entries = new Map<string, TValue>();
  private readonly capacity: number;

  constructor(capacity = defaultSubtitleTranslationCacheCapacity) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): TValue | undefined {
    if (!this.entries.has(key)) {
      return undefined;
    }

    const value = this.entries.get(key);
    this.entries.delete(key);
    this.entries.set(key, value as TValue);
    return value;
  }

  set(key: string, value: TValue): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }

    this.entries.set(key, value);

    while (this.entries.size > this.capacity) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }

      this.entries.delete(oldestKey);
    }
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
