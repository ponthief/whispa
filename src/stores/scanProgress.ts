import { create } from 'zustand';
import * as api from '@services/api';

/**
 * Whether a scan is running, for anything that wants to say so.
 *
 * WHY THIS HAD TO BE SHARED. Every screen polled `getScanProgress` for itself,
 * so each one only knew about a scan IT had started. The Wallet screen's
 * catch-up banner is driven by useCatchUpScan, which evaluates a wallet once
 * per app session — so a scan begun from the Scan panel, or still running from
 * before the app was opened, or kicked off after a send, left the Wallet screen
 * showing nothing at all while thousands of blocks went past. Reported
 * 2026-10-15: "there is nothing on the Wallet page to notify the user".
 *
 * NO IDLE POLLING. A scan cannot start without this app starting it, so every
 * site that calls `api.startScan` calls `kick` as well, and the Wallet screen
 * checks once when it loads — which is what catches a scan that was already
 * running. Polling on a timer to discover something this app did itself would
 * be traffic spent asking a question it already knows the answer to.
 *
 * The poll stops the moment the server says `active` is false. Nothing here
 * retries a failed read beyond the next tick: a progress bar that vanishes for
 * a moment is better than one that reports a stale percentage, and the bar is
 * not what any decision rests on.
 */

const POLL_MS = 2500;

interface ScanProgressState {
  walletId: string | null;
  progress: api.ScanProgress | null;
  /** True between a start and the server saying it finished. */
  active: boolean;
  /** Ask once, and keep asking while it is running. */
  kick: (inkey: string | null, walletId: string | null) => void;
  stop: () => void;
}

let timer: ReturnType<typeof setInterval> | null = null;

function clear() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export const useScanProgress = create<ScanProgressState>((set, get) => ({
  walletId: null,
  progress: null,
  active: false,

  kick: (inkey, walletId) => {
    if (!inkey || !walletId) return;
    // A different wallet is a different scan. Drop what was on screen rather
    // than letting one wallet's percentage sit under another's balance.
    if (get().walletId !== walletId) {
      clear();
      set({ walletId, progress: null, active: false });
    }
    const read = async () => {
      // The wallet can change under a poll that is already in flight.
      const id = get().walletId;
      if (!id) return;
      try {
        const p = await api.getScanProgress(inkey, id);
        if (get().walletId !== id) return;
        set({ progress: p, active: !!p.active });
        if (!p.active) clear();
      } catch {
        // Transient. The next tick asks again; if this was the immediate read
        // and nothing is running, the poll below settles it.
      }
    };
    read();
    if (!timer) timer = setInterval(read, POLL_MS);
  },

  stop: () => {
    clear();
    set({ walletId: null, progress: null, active: false });
  },
}));

/**
 * The percentage to draw, or null when there is nothing honest to draw.
 *
 * `total` is zero on a scan that has not reported a range yet, and dividing by
 * it gives NaN — which renders as a bar of no width that still takes up a row.
 * Null is the signal to show an indeterminate bar instead, which is the truth:
 * something is running and nobody knows how far along.
 */
export function scanPercent(p: api.ScanProgress | null): number | null {
  if (!p || !p.total || p.total <= 0) return null;
  const pct = (Number(p.current || 0) / Number(p.total)) * 100;
  if (!Number.isFinite(pct)) return null;
  return Math.max(0, Math.min(100, pct));
}
