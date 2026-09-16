export class PageMutationMutex {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #active = new Set<string>();

  isBusy(pageKey: string): boolean {
    return this.#active.has(pageKey) || this.#tails.has(pageKey);
  }

  async runExclusive<Result>(pageKey: string, operation: () => Promise<Result>): Promise<Result> {
    const previous = this.#tails.get(pageKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#tails.set(pageKey, tail);

    await previous;
    this.#active.add(pageKey);
    try {
      return await operation();
    } finally {
      this.#active.delete(pageKey);
      release();
      if (this.#tails.get(pageKey) === tail) {
        this.#tails.delete(pageKey);
      }
    }
  }
}

