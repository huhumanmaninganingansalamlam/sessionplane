export class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();

  isBusy(key: string): boolean {
    return this.#tails.has(key);
  }

  async runExclusive<Result>(key: string, operation: (retainUntil: (pending: Promise<unknown>) => void) => Promise<Result>): Promise<Result> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#tails.set(key, tail);

    await previous;
    let drain: Promise<unknown> | undefined;
    const finish = () => {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    };
    try {
      return await operation(pending => {
        // A caller timeout does not cancel a browser command already in flight.
        drain = Promise.allSettled([drain, pending]);
      });
    } finally {
      if (drain === undefined) finish();
      else void drain.then(finish);
    }
  }
}

