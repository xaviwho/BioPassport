/**
 * Resource-Based Lock Manager for PureChain Client
 *
 * Enables concurrent transactions that don't conflict:
 * - registerMaterial()  → No lock (fully parallel)
 * - issueCredential(mat1) → Lock on mat1
 * - issueCredential(mat2) → Lock on mat2 (can run in parallel with mat1)
 * - Global nonce lock for all transactions
 */

export interface LockHandle {
  release: () => void;
}

export class LockManager {
  // Global lock for nonce management (all transactions serialize here briefly)
  private globalNonceLock: Promise<void> = Promise.resolve();

  // Per-resource locks (e.g., lock on materialId)
  private resourceLocks: Map<string, Promise<void>> = new Map();

  /**
   * Acquire global nonce lock (brief - just for nonce allocation)
   * All transactions must acquire this first to get a nonce
   */
  async acquireNonceLock(): Promise<LockHandle> {
    let releaseGlobal: () => void;
    const lockPromise = new Promise<void>(resolve => { releaseGlobal = resolve; });
    const previousLock = this.globalNonceLock;
    this.globalNonceLock = lockPromise;

    // Wait for previous nonce allocation
    await previousLock;

    return {
      release: () => {
        releaseGlobal!();
      }
    };
  }

  /**
   * Acquire resource-specific lock
   * - resourceId: Material ID, Transfer ID, etc. (null = no resource lock)
   *
   * Flow:
   * 1. Acquire nonce lock → get nonce → release nonce lock
   * 2. Acquire resource lock (if resourceId provided)
   * 3. Send transaction
   * 4. Release resource lock after transaction completes
   */
  async acquireResourceLock(resourceId: string | null): Promise<LockHandle> {
    if (!resourceId) {
      // No resource lock needed (e.g., registerMaterial)
      return {
        release: () => { /* no-op */ }
      };
    }

    // Create or get existing lock for this resource
    let releaseLock: () => void;
    const lockPromise = new Promise<void>(resolve => { releaseLock = resolve; });
    const previousLock = this.resourceLocks.get(resourceId) || Promise.resolve();
    this.resourceLocks.set(resourceId, lockPromise);

    // Wait for previous operation on this resource
    await previousLock;

    return {
      release: () => {
        // Clean up lock if no more operations pending
        if (this.resourceLocks.get(resourceId) === lockPromise) {
          this.resourceLocks.delete(resourceId);
        }
        releaseLock!();
      }
    };
  }

  /**
   * Execute a function with proper locking
   *
   * @param resourceId - Resource to lock (null = no lock, fully parallel)
   * @param fn - Function that returns nonce and executes transaction
   */
  async executeWithLocks<T>(
    resourceId: string | null,
    fn: (nonce: number) => Promise<T>
  ): Promise<T> {
    // Step 1: Acquire nonce lock (brief)
    const nonceLock = await this.acquireNonceLock();
    let nonce: number;

    try {
      // Get nonce from the function (it will call noncePool.acquire())
      // This is a placeholder - actual nonce comes from NoncePool
      nonce = -1; // Will be set by NoncePool
    } finally {
      // Release nonce lock immediately after getting nonce
      nonceLock.release();
    }

    // Step 2: Acquire resource lock (if needed)
    const resourceLock = await this.acquireResourceLock(resourceId);

    try {
      // Step 3: Execute transaction
      return await fn(nonce);
    } finally {
      // Step 4: Release resource lock
      resourceLock.release();
    }
  }

  /**
   * Get number of currently held locks (for monitoring)
   */
  getActiveLockCount(): number {
    return this.resourceLocks.size;
  }
}
