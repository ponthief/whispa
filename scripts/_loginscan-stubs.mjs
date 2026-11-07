// Stand-ins for the three modules useLoginScan.js reaches outside itself.
//
// ONE FILE SERVES ALL THREE on purpose: '@/stores/auth', '@/api' and
// '@/stores/toasts' are mapped here by the loader hook in check-catchup.mjs,
// and a named import only needs the name to exist. '@/stores/scanwatch' is
// deliberately NOT stubbed — it is half of what is under test.
//
// Everything the test needs to steer or observe hangs off `state`, so the
// check can say "the wallet is now caught up" and "no scan has been started"
// without a server, a browser or pinia.

export const state = {
  // what the fake backend reports
  tip: 900_000,
  walletRows: [],            // [{ id, last_scan_height, last_height }]
  progress: {},              // walletId -> { active: bool }
  config: {},                // blindbit config (login_scan_enabled, threshold)
  keys: { scanSecret: 'aa', spendKey: 'bb' },
  failures: new Set(),       // names of calls that should throw

  // what the code under test did
  started: [],               // [{ walletId, fromHeight, toHeight }]
  toasts: [],                // [{ msg, type }]
};

export function reset(over = {}) {
  state.tip = 900_000;
  state.walletRows = [];
  state.progress = {};
  state.config = {};
  state.keys = { scanSecret: 'aa', spendKey: 'bb' };
  state.failures = new Set();
  state.started = [];
  state.toasts = [];
  Object.assign(state, over);
}

const maybeFail = (name) => {
  if (state.failures.has(name)) throw new Error(`stub: ${name} unavailable`);
};

// ── '@/stores/auth' ─────────────────────────────────────────────────────────
export function useAuthStore() {
  return {
    inkey: 'inkey-1',
    walletId: 'w1',
    async getWalletKeys() {
      maybeFail('getWalletKeys');
      return state.keys;
    },
  };
}

// ── '@/stores/toasts' ───────────────────────────────────────────────────────
export function pushToast(msg, opts = {}) {
  state.toasts.push({ msg: String(msg), type: opts.type });
}

// ── '@/api' ─────────────────────────────────────────────────────────────────
export async function getBlindbitConfig() {
  maybeFail('getBlindbitConfig');
  return state.config;
}
export async function getChainTip() {
  maybeFail('getChainTip');
  return { height: state.tip };
}
export async function getScanProgress(_inkey, walletId) {
  maybeFail('getScanProgress');
  return state.progress[walletId] || { active: false };
}
export async function getSilntWallets() {
  maybeFail('getSilntWallets');
  return state.walletRows;
}
export async function startScan(_inkey, walletId, _secret, fromHeight, toHeight) {
  maybeFail('startScan');
  state.started.push({ walletId, fromHeight, toHeight });
  return { ok: true };
}
