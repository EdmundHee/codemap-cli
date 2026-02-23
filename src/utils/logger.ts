/**
 * Simple logger with colored output and spinner-like status messages.
 * Avoids heavy dependencies — chalk/ora can be added later for richer UX.
 */
export class Logger {
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  start(message: string): void {
    process.stdout.write(`\x1b[36m⟳\x1b[0m ${message}\n`);
  }

  success(message: string): void {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(2);
    process.stdout.write(`\x1b[32m✓\x1b[0m ${message} \x1b[90m(${elapsed}s)\x1b[0m\n`);
  }

  info(message: string): void {
    process.stdout.write(`\x1b[34mℹ\x1b[0m ${message}\n`);
  }

  warn(message: string): void {
    process.stdout.write(`\x1b[33m⚠\x1b[0m ${message}\n`);
  }

  error(message: string): void {
    process.stderr.write(`\x1b[31m✗\x1b[0m ${message}\n`);
  }
}
