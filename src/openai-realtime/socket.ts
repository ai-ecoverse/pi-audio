export interface VoiceWireTarget {
  url: string;
  protocols: string[];
  headers: Record<string, string>;
}

export interface VoiceWire {
  send(data: string): void;
  close(): void;
  incoming: AsyncIterable<string>;
}

export interface VoiceSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: () => void): void;
}

export type VoiceSocketInit = {
  protocols: string[];
  headers: Record<string, string>;
};

export type VoiceSocketConstructor = new (url: string, init: VoiceSocketInit) => VoiceSocket;

export function openVoiceSocket(
  target: VoiceWireTarget,
  Socket: VoiceSocketConstructor = WebSocket as unknown as VoiceSocketConstructor
): VoiceWire {
  const socket = new Socket(target.url, {
    protocols: target.protocols,
    headers: target.headers,
  });
  const queue: string[] = [];
  const waiters: Array<(result: IteratorResult<string>) => void> = [];
  let closed = false;

  const push = (value: string): void => {
    if (closed) return;
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter({ value, done: false });
    else queue.push(value);
  };

  const end = (): void => {
    if (closed) return;
    closed = true;
    for (const waiter of waiters) waiter({ value: undefined, done: true });
    waiters.length = 0;
  };

  socket.addEventListener('message', (event) => {
    push(typeof event.data === 'string' ? event.data : String(event.data));
  });
  socket.addEventListener('close', end);
  socket.addEventListener('error', end);

  return {
    send(data) {
      socket.send(data);
    },
    close() {
      socket.close();
      end();
    },
    incoming: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          const queued = queue.shift();
          if (queued !== undefined) {
            yield queued;
            continue;
          }
          if (closed) return;
          const next = await new Promise<IteratorResult<string>>((resolve) => {
            waiters.push(resolve);
          });
          if (next.done === true || next.value === undefined) return;
          yield next.value;
        }
      },
    },
  };
}
