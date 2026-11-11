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

export interface VoiceCloseEvent {
  code?: number;
  reason?: string;
}

export interface VoiceSocket {
  send(data: string): void;
  close(): void;
  binaryType?: string;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (event: VoiceCloseEvent) => void): void;
  addEventListener(type: 'error', listener: () => void): void;
}

export type VoiceSocketInit = {
  protocols: string[];
  headers: Record<string, string>;
};

export type VoiceSocketConstructor = new (url: string, init: VoiceSocketInit) => VoiceSocket;

export function messageText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new TextDecoder().decode(view);
  }
  return String(data);
}

export function closeError(code: number, reason: string): Error {
  const detail = reason.length > 0 ? `${code}: ${reason}` : String(code);
  return new Error(`socket closed ${detail}`);
}

type Waiter = {
  resolve: (result: IteratorResult<string>) => void;
  reject: (error: Error) => void;
};

export function openVoiceSocket(
  target: VoiceWireTarget,
  Socket: VoiceSocketConstructor = WebSocket as unknown as VoiceSocketConstructor
): VoiceWire {
  const socket = new Socket(target.url, {
    protocols: target.protocols,
    headers: target.headers,
  });
  socket.binaryType = 'arraybuffer';
  const queue: string[] = [];
  const outgoing: string[] = [];
  const waiters: Waiter[] = [];
  let closed = false;
  let opened = false;
  let localClose = false;
  let messages = 0;
  let failure: Error | undefined;

  const push = (value: string): void => {
    if (closed) return;
    messages += 1;
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter.resolve({ value, done: false });
    else queue.push(value);
  };

  const end = (): void => {
    if (closed) return;
    closed = true;
    for (const waiter of waiters) waiter.resolve({ value: undefined, done: true });
    waiters.length = 0;
  };

  const fail = (error: Error): void => {
    if (closed) return;
    closed = true;
    failure = error;
    for (const waiter of waiters) waiter.reject(error);
    waiters.length = 0;
  };

  socket.addEventListener('open', () => {
    opened = true;
    const queued = outgoing.splice(0);
    for (const data of queued) socket.send(data);
  });
  socket.addEventListener('message', (event) => {
    push(messageText(event.data));
  });
  socket.addEventListener('close', (event) => {
    if (localClose) {
      end();
      return;
    }
    const code = typeof event.code === 'number' ? event.code : 1006;
    const reason = typeof event.reason === 'string' ? event.reason : '';
    const abnormal = code !== 1000 && code !== 1005;
    if (abnormal || messages === 0) {
      fail(closeError(code, reason));
      return;
    }
    end();
  });
  socket.addEventListener('error', () => {
    if (localClose || closed) return;
    fail(new Error('socket error'));
  });

  return {
    send(data) {
      if (closed) return;
      if (!opened) {
        outgoing.push(data);
        return;
      }
      socket.send(data);
    },
    close() {
      localClose = true;
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
          if (failure !== undefined) throw failure;
          if (closed) return;
          const next = await new Promise<IteratorResult<string>>((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
          if (next.done === true || next.value === undefined) return;
          yield next.value;
        }
      },
    },
  };
}
