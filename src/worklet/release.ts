export const WORKLET_RELEASE = 'pi-audio-release';

export interface WorkletPort {
  postMessage(message: unknown): void;
  onmessage: ((event: { data?: unknown }) => void) | null;
}

export interface WorkletNodeLike {
  disconnect(): void;
  port: WorkletPort;
}

export function isWorkletRelease(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  if (!('type' in data)) return false;
  return data.type === WORKLET_RELEASE;
}

export function bindWorkletNode(node: WorkletNodeLike): () => void {
  let disconnected = false;
  const disconnect = () => {
    if (disconnected) return;
    disconnected = true;
    node.disconnect();
    closePort(node.port);
  };
  const previous = node.port.onmessage;
  node.port.onmessage = (event) => {
    if (previous) previous(event);
    if (isWorkletRelease(event.data)) disconnect();
  };
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    node.port.postMessage({ type: WORKLET_RELEASE });
    disconnect();
  };
}

function closePort(port: WorkletPort): void {
  const closer = (port as WorkletPort & { close?: () => void }).close;
  if (typeof closer !== 'function') return;
  try {
    closer.call(port);
  } catch {
    return;
  }
}
