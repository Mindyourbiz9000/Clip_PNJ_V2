export class Semaphore {
  private current = 0;
  private queue: (() => void)[] = [];
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.current++;
        resolve();
      });
    });
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) next();
  }
}

const maxConcurrent = parseInt(process.env.MAX_CONCURRENT || "1", 10);
export const clipSemaphore = new Semaphore(maxConcurrent);
