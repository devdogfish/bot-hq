import type { ComputerState } from '@shared/types';

/** Screens are 1280x960 unless the server says otherwise; the primary bot has the computer's own 1920x1080 display. */
export const DEFAULT_SCREEN = { width: 1280, height: 960 };
export const PRIMARY_SCREEN = { width: 1920, height: 1080 };

/** Pixel size of a bot's screen on the shared computer, for the viewer's aspect ratio. Before the server reports one, assume the usual size so the frame does not change shape when the screen appears. */
export function screenSize(c: ComputerState | null, botId: string, primary = false): { width: number; height: number } {
  const s = c?.screens.find((x) => x.botId === botId);
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
  return s && ok(s.width) && ok(s.height) ? { width: s.width, height: s.height } : primary ? PRIMARY_SCREEN : DEFAULT_SCREEN;
}
