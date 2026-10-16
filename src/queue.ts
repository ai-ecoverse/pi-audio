export interface PushQueue<T> {
  push(value: T): void;
  end(): void;
  readonly iterable: AsyncIterable<T>;
}

export function pushQueue<T>(): PushQueue<T> {
  const values: T[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  const notify = () => {
    const current = wake;
    wake = undefined;
    current?.();
  };
  return {
    push(value) {
      if (ended) return;
      values.push(value);
      notify();
    },
    end() {
      ended = true;
      notify();
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        let index = 0;
        while (true) {
          if (index < values.length) {
            const value = values[index];
            index += 1;
            if (value !== undefined) yield value;
            continue;
          }
          if (ended) return;
          await new Promise<void>((resolve) => {
            wake = () => {
              wake = undefined;
              resolve();
            };
            if (index < values.length || ended) wake();
          });
        }
      },
    },
  };
}
