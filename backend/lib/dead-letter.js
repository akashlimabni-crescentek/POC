'use strict';

const DEFAULT_MAX_SIZE = 10_000;

/**
 * In-memory queue for failed upsert batches — retried on next worker cycle.
 */
class DeadLetterQueue {
  constructor(name, maxSize = DEFAULT_MAX_SIZE) {
    this.name = name;
    this.maxSize = maxSize;
    this.queue = [];
    this.warned = false;
  }

  enqueue(rows) {
    if (!rows || rows.length === 0) return;
    this.queue.push(...rows);
    if (this.queue.length > this.maxSize && !this.warned) {
      console.warn(`[dead-letter:${this.name}] queue exceeds ${this.maxSize} rows`);
      this.warned = true;
    }
  }

  /** Remove and return all queued rows for retry. */
  drain() {
    const rows = this.queue;
    this.queue = [];
    this.warned = false;
    return rows;
  }

  peek() {
    return this.queue;
  }

  get size() {
    return this.queue.length;
  }
}

module.exports = { DeadLetterQueue, DEFAULT_MAX_SIZE };
