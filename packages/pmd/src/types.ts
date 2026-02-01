/**
 * Node registration entry in the PMD registry
 */
export interface NodeInfo {
  nodeId: string;
  alias?: string;
  host: string;
  port: number;
  lastHeartbeat: number;
}

/**
 * PMD protocol message types
 */
export enum MessageType {
  REGISTER = 'register',
  UNREGISTER = 'unregister',
  RESOLVE = 'resolve',
  LIST = 'list',
  HEARTBEAT = 'heartbeat',
  WATCH = 'watch',
  SHUTDOWN = 'shutdown',
  RESPONSE = 'response',
  EVENT = 'event'
}

/**
 * Base message structure
 */
export interface Message {
  type: MessageType;
  payload: any;
  requestId?: string;
}

/**
 * Register request payload
 */
export interface RegisterPayload {
  nodeId: string;
  alias?: string;
  host: string;
  port: number;
}

/**
 * Peer join/leave event
 */
export interface PeerEvent {
  event: 'peer:join' | 'peer:leave';
  peer: NodeInfo;
}
