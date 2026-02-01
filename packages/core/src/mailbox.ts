/**
 * Message metadata
 */
export interface MessageMetadata {
  from: string;
  to: string;
  timestamp: number;
}

/**
 * Internal message structure
 */
export interface InternalMessage {
  payload: any;
  meta: MessageMetadata;
}

/**
 * Mailbox configuration
 */
export interface MailboxConfig {
  maxSize?: number;
  overflow?: 'drop-newest';
}

/**
 * Mailbox - FIFO queue for incoming messages
 */
export class Mailbox {
  private queue: InternalMessage[] = [];
  private handlers: Array<(message: any, meta: MessageMetadata) => void> = [];
  private readonly maxSize: number;
  private readonly overflow: 'drop-newest';

  constructor(config: MailboxConfig = {}) {
    this.maxSize = config.maxSize ?? 1000;
    this.overflow = config.overflow ?? 'drop-newest';
  }

  /**
   * Add message to mailbox
   */
  push(message: InternalMessage): boolean {
    if (this.queue.length >= this.maxSize) {
      if (this.overflow === 'drop-newest') {
        // Drop the new message
        return false;
      }
    }

    this.queue.push(message);
    this.processQueue();
    return true;
  }

  /**
   * Register message handler
   */
  onMessage(handler: (message: any, meta: MessageMetadata) => void): void {
    this.handlers.push(handler);
  }

  /**
   * Process queued messages
   */
  private processQueue(): void {
    while (this.queue.length > 0 && this.handlers.length > 0) {
      const msg = this.queue.shift()!;
      
      for (const handler of this.handlers) {
        try {
          handler(msg.payload, msg.meta);
        } catch (err) {
          console.error('Error in message handler:', err);
        }
      }
    }
  }

  /**
   * Get current queue size
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * Get max size
   */
  getMaxSize(): number {
    return this.maxSize;
  }
}
