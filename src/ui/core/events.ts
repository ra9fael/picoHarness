// Minimal synchronous event bus. Layers talk upward through named events
// instead of holding references to each other.
type Handler = (...args: any[]) => void;

export class Emitter {
  private handlers = new Map<string, Handler[]>();

  on(event: string, fn: Handler): void {
    const list = this.handlers.get(event);
    if (list) list.push(fn);
    else this.handlers.set(event, [fn]);
  }

  emit(event: string, ...args: any[]): void {
    const list = this.handlers.get(event);
    if (!list) return;
    for (const fn of list.slice()) fn(...args);
  }
}
