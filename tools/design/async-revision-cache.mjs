/** Single-flight cache keyed by an immutable source revision.
 *
 * A request arriving while an older revision is loading waits for that load to
 * settle and then re-checks its own revision; it never receives the old value
 * merely because work was already in flight. This keeps one expensive compiler
 * child active while preserving read-after-write behavior.
 */
export class AsyncRevisionCache {
  #revision;
  #value;
  #inFlight;

  async get(revision, load) {
    for (;;) {
      if (this.#revision === revision) return this.#value;
      if (this.#inFlight !== undefined) {
        await this.#inFlight.catch(() => {});
        continue;
      }
      const pending = Promise.resolve().then(load);
      this.#inFlight = pending;
      try {
        const value = await pending;
        this.#revision = revision;
        this.#value = value;
        return value;
      } finally {
        if (this.#inFlight === pending) this.#inFlight = undefined;
      }
    }
  }

  invalidate() {
    this.#revision = undefined;
    this.#value = undefined;
  }
}
