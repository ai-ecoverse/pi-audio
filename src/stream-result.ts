export interface StreamResult<T> {
  readonly result: Promise<T>;
  finish(value: T): void;
  fail(error: Error): void;
}

export function streamResult<T>(): StreamResult<T> {
  let settled = false;
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  void result.catch(() => {});
  return {
    result,
    finish(value) {
      if (settled) return;
      settled = true;
      resolve(value);
    },
    fail(error) {
      if (settled) return;
      settled = true;
      reject(error);
    },
  };
}
