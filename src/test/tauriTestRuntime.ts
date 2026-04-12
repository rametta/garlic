type InvokeHandler = (command: string, args?: unknown) => Promise<unknown>;
type EventCallback = (event: { payload: unknown }) => void;

let invokeHandler: InvokeHandler | null = null;
const listeners = new Map<string, Set<EventCallback>>();

export function setTauriInvokeHandler(handler: InvokeHandler) {
  invokeHandler = handler;
}

export function resetTauriTestRuntime() {
  invokeHandler = null;
  listeners.clear();
}

export async function invokeForTests<T>(command: string, args?: unknown): Promise<T> {
  if (!invokeHandler) {
    throw new Error(`No Tauri test invoke handler registered for command "${command}".`);
  }
  return (await invokeHandler(command, args)) as T;
}

export async function listenForTests(
  eventName: string,
  callback: (event: { payload: unknown }) => void,
): Promise<() => void> {
  const callbacks = listeners.get(eventName) ?? new Set<EventCallback>();
  callbacks.add(callback);
  listeners.set(eventName, callbacks);
  return () => {
    const current = listeners.get(eventName);
    if (!current) return;
    current.delete(callback);
    if (current.size === 0) {
      listeners.delete(eventName);
    }
  };
}

export function emitTauriEvent(eventName: string, payload: unknown) {
  const callbacks = listeners.get(eventName);
  if (!callbacks) return;
  for (const callback of callbacks) {
    callback({ payload });
  }
}
