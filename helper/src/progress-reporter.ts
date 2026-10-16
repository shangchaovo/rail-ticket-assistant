// Keep slow cloud uploads off the serial 12306 query path. At most one upload
// is active and only the newest waiting snapshot is kept. flush is mandatory
// before waiting-user or terminal updates, so an old snapshot cannot win.
export class ProgressReporter<T> {
  private pending?: T;
  private active?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private lastStarted = 0;
  private error: unknown;
  constructor(private send: (value: T) => Promise<void>, private interval = 1000) {}
  offer(value: T, immediate = false) {
    this.pending = value;
    if (this.active || this.timer) return;
    const delay = immediate ? 0 : Math.max(0, this.interval - (Date.now() - this.lastStarted));
    if (delay) this.timer = setTimeout(() => { this.timer = undefined; this.start(); }, delay);
    else this.start();
  }
  private start() {
    if (this.active || this.pending === undefined) return;
    const value = this.pending; this.pending = undefined; this.lastStarted = Date.now();
    this.active = this.send(value).then(() => { this.error = undefined; }).catch(error => { this.error = error; }).finally(() => {
      this.active = undefined;
      if (this.pending !== undefined) this.offer(this.pending);
    });
  }
  async flush() {
    while (this.pending !== undefined || this.active) {
      if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
      this.start();
      await this.active;
    }
    if (this.error) { const error = this.error; this.error = undefined; throw error; }
  }
  async discard() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined; this.pending = undefined;
    await this.active;
  }
}
