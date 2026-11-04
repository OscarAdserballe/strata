export interface AskHandle {
  open(): void;
  close(): void;
  isOpen(): boolean;
  prefill(text: string): void;
  attach?(files: File[]): void;
}

const asks: { id: number; handle: AskHandle }[] = [];
let seq = 0;

export function registerAsk(handle: AskHandle): () => void {
  const id = ++seq;
  asks.push({ id, handle });
  return () => {
    const at = asks.findIndex((a) => a.id === id);
    if (at >= 0) asks.splice(at, 1);
  };
}

const top = (): AskHandle | null => asks[asks.length - 1]?.handle ?? null;

export function openAsk(): boolean {
  const a = top();
  if (!a) return false;
  a.open();
  return true;
}

export function closeAsk(): boolean {
  const a = top();
  if (!a || !a.isOpen()) return false;
  a.close();
  return true;
}

export function askIsOpen(): boolean { return !!top()?.isOpen(); }

export function prefillAsk(text: string): boolean {
  const a = top();
  if (!a) return false;
  a.prefill(text);
  return true;
}

export function attachToAsk(files: File[]): boolean {
  const a = top();
  if (!a?.attach) return false;
  a.attach(files);
  return true;
}
