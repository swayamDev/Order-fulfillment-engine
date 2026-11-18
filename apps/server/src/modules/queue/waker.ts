/**
 * Lets an idle worker sleep until a deadline or until somebody enqueues work,
 * whichever comes first. Sleeping instead of polling is what lets Neon scale
 * the database to zero when nobody is using the demo.
 */
export class Waker {
  private wake: (() => void) | undefined;
  private pending = false;

  notify(): void {
    if (this.wake === undefined) {
      this.pending = true;
      return;
    }
    this.wake();
  }

  async sleep(ms: number): Promise<void> {
    if (this.pending) {
      this.pending = false;
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
    this.wake = undefined;
  }
}
