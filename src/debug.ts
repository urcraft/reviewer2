export type DebugLevel = 'info' | 'warn' | 'error';

export type DebugEvent = {
  ts: number;
  level: DebugLevel;
  message: string;
};

type Listener = () => void;

const MAX_EVENTS = 500;

class DebugBus {
  events: DebugEvent[] = [];
  raw = '';
  private listeners = new Set<Listener>();

  log(level: DebugLevel, message: string) {
    this.events.push({ ts: Date.now(), level, message });
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.emit();
  }

  info(message: string) { this.log('info', message); }
  warn(message: string) { this.log('warn', message); }
  error(message: string) { this.log('error', message); }

  appendRaw(chunk: string) {
    this.raw += chunk;
    this.emit();
  }

  resetRaw() {
    this.raw = '';
    this.emit();
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}

export const debugBus = new DebugBus();

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function formatEvents(events: DebugEvent[]): string {
  return events
    .map((e) => `[${formatTime(e.ts)}] ${e.level.padEnd(5)} | ${e.message}`)
    .join('\n');
}
