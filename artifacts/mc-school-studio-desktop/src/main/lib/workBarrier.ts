export class WorkBarrier {
  private disabled = false
  private readonly active = new Set<Promise<unknown>>()

  isDisabled(): boolean {
    return this.disabled
  }

  run<T>(work: () => Promise<T>): Promise<T> | null {
    if (this.disabled) return null
    const task = work()
    this.active.add(task)
    void task.finally(() => this.active.delete(task)).catch(() => {})
    return task
  }

  async disableAndDrain(): Promise<void> {
    this.disabled = true
    await Promise.allSettled([...this.active])
  }

  enable(): void {
    this.disabled = false
  }
}