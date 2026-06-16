const MAX = 2000;
const buf: string[] = [];
const subs = new Set<(line: string) => void>();

export const logStream = {
  write(line: string): void {
    buf.push(line);
    if (buf.length > MAX) buf.shift();
    for (const s of subs) {
      try {
        s(line);
      } catch {
      }
    }
    try {
      process.stdout.write(line);
    } catch {
    }
  },
};

export function recentLogs(n = 500): string[] {
  return buf.slice(-n);
}

export function subscribe(fn: (line: string) => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}
