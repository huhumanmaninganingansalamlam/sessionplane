export class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();

  isBusy(key: string): boolean {
    return this.#tails.has(key);
  }

  async runExclusive<Result>(key: string, operation: () => Promise<Result>): Promise<Result> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#tails.set(key, tail);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(key) === tail) {
        this.#tails.delete(key);
      }
    }
  }
}

