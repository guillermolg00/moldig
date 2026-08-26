/**
 * `useInput` with the non-TTY guard.
 *
 * Ink throws when a component asks for raw mode on a stdin that has none (a piped run);
 * gating on `isRawModeSupported` keeps the final-frame-only path alive. Never call
 * `process.stdin.setRawMode` by hand.
 */
import { useInput, useStdin, type Key } from "ink";

export type KeyHandler = (input: string, key: Key) => void;

export function useKeys(handler: KeyHandler, active = true): void {
  const { isRawModeSupported } = useStdin();
  // Typed `boolean`, but at runtime it is `stdin.isTTY`, which is `undefined` (not `false`)
  // on a pipe — and `useInput` only stands down for a literal `false`.
  const supported: unknown = isRawModeSupported;
  useInput(handler, { isActive: active && supported === true });
}

export function isUp(input: string, key: Key): boolean {
  return key.upArrow || input === "k";
}

export function isDown(input: string, key: Key): boolean {
  return key.downArrow || input === "j";
}
