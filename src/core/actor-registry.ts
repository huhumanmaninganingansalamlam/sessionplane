export class ActorRegistry<Actor> {
  readonly #actors = new Map<string, Actor>();

  get size(): number {
    return this.#actors.size;
  }

  get(sessionId: string): Actor | null {
    return this.#actors.get(sessionId) ?? null;
  }

  getOrCreate(sessionId: string, factory: () => Actor): Actor {
    const existing = this.#actors.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const actor = factory();
    this.#actors.set(sessionId, actor);
    return actor;
  }

  delete(sessionId: string): boolean {
    return this.#actors.delete(sessionId);
  }

  entries(): readonly (readonly [string, Actor])[] {
    return [...this.#actors.entries()];
  }
}

