import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAuthStore } from '@stores/authStore';
import * as api from '@services/api';
import { getWalletKeys, hasWalletKeys } from '@services/secureKeys';
import {
  cooldownRemaining,
  markScanStarted,
  setCooldown,
  SCAN_COOLDOWN_SECONDS,
} from '@services/scanCooldown';
import { resetCatchUp } from '../hooks/useCatchUpScan';
import RecoverKeysModal from '../components/RecoverKeysModal';
import {
  DAY_OPTIONS,
  describeLookback,
  lookbackBlocks,
  rangeFor,
  type Lookback,
} from '@services/scanLookback';
import { colors } from '@/theme';

const PRIMARY = colors.primary;
const POLL_MS = 1500;

// How far back a deliberate rescan can reach.
//
// WHY THIS EXISTS AT ALL. Everything else on this screen scans FORWARD from
// where the wallet got to. When a block was missed — read as empty, skipped
// while the oracle was behind, or passed over by a resume point that moved too
// far — there was no way to look at it again: "Up to date" disabled the only
// button, and the range is computed, not typed. Recovering a mainnet balance
// on 2026-10-03 meant editing last_scan_height in the database by hand.
//
// Days and a date, not block counts. It offered 10 / 144 / 1,008 / 4,320 with
// "about a day" printed beside each, which is the conversion done in the
// user's head off a label — and somebody whose payment never arrived knows
// when it was sent, not what height that was. services/scanLookback.ts does
// the arithmetic, and overshoots on purpose; see the note there.

function groupThousands(n: number): string {
  return Math.floor(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

interface ScanResult {
  found: number;
  scanned: number;
  total: number;
  stopped: boolean;
}

// Where a resume scan should start: the block after the last scanned one (or the
// birth height for a never-scanned wallet), clamped to [minHeight, tip].
function resumeFrom(
  birth: number,
  scanned: number,
  tip: number,
  minHeight: number,
): number {
  let start = scanned > birth ? scanned + 1 : birth;
  if (minHeight && start < minHeight) start = minHeight;
  if (tip && start > tip) start = tip;
  return start;
}

// Rendered inside the Receive screen, reached from the row beneath the BIP-353
// card rather than from the segment: with background scanning on, a manual scan
// is redundant, so it does not deserve a permanent slot. A plain panel — no
// SafeAreaView or page header of its own; Receive supplies both, including the
// way back.
export default function ScanPanel() {
  const inkey = useAuthStore((s) => s.inkey);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [missing, setMissing] = useState(false);
  const [wallet, setWallet] = useState<api.SilntWallet | null>(null);
  const [keysPresent, setKeysPresent] = useState(false);
  const [showRecover, setShowRecover] = useState(false);

  const [tip, setTip] = useState<number | null>(null);
  const [minHeight, setMinHeight] = useState(0);
  const [fromHeight, setFromHeight] = useState('');
  const [toHeight, setToHeight] = useState('');

  const [scanning, setScanning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState<api.ScanProgress>({
    active: false,
    current: 0,
    total: 0,
    found: 0,
  });
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldownSec] = useState(0);
  // Which lookback is armed, or null for the ordinary catch-up. Cleared after
  // a scan starts so the next press is the ordinary one again — a rescan is a
  // thing you choose each time, not a mode the screen stays in.
  const [lookback, setLookback] = useState<Lookback | null>(null);
  // The date field is shown only once asked for: it is the uncommon answer,
  // and four chips plus a permanently open text input is a lot of screen for
  // "my payment has not arrived".
  const [dateOpen, setDateOpen] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Holds the latest `poll` so `load` can attach to a running scan without a
  // circular useCallback dependency (poll depends on load, load must not depend
  // on poll). Assigned right after poll is defined below.
  const pollFn = useRef<(walletId: string) => void>(() => {});
  // Guards against a transient/stale backend read right after a scan: the
  // highest last_scan_height we've seen (monotonic — scanning only moves
  // forward) and the last-known min scan height. Using these for the resume
  // range means a momentarily-low read can never produce a below-minimum
  // `from` (which the server rejects with a spurious min-height error).
  const walletIdRef = useRef<string | null>(null);
  const scannedFloorRef = useRef(0);
  const minHeightRef = useRef(0);
  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);
  useEffect(() => stopPoll, [stopPoll]);

  const load = useCallback(async () => {
    if (!inkey) {
      setLoading(false);
      return;
    }
    setError(null);
    try {
      const [walletsRes, tipRes, cfgRes] = await Promise.allSettled([
        api.getSilntWallets(inkey),
        api.getChainTip(inkey),
        api.getAppConfig(inkey),
      ]);

      const w =
        walletsRes.status === 'fulfilled'
          ? api.pickSilntWallet(walletsRes.value)
          : null;
      if (!w) {
        setWallet(null);
        setMissing(true);
        return;
      }
      setMissing(false);
      setWallet(w);
      setKeysPresent(await hasWalletKeys(w.id));

      // Reset the monotonic floors when switching wallets.
      if (walletIdRef.current !== w.id) {
        walletIdRef.current = w.id;
        scannedFloorRef.current = 0;
      }
      // last_scan_height only ever advances; keep the highest we've seen so a
      // stale/racy low read right after a scan can't rewind the resume point.
      scannedFloorRef.current = Math.max(
        scannedFloorRef.current,
        Number(w.last_scan_height) || 0,
      );

      const newTip =
        tipRes.status === 'fulfilled' ? Number(tipRes.value?.height) || null : null;
      setTip(newTip);
      // Keep the last-known min height if the config fetch failed/returned 0, so
      // the clamp and the send-time validation never momentarily drop to 0.
      let minH =
        cfgRes.status === 'fulfilled' ? Number(cfgRes.value?.min_scan_height) || 0 : 0;
      if (!minH) minH = minHeightRef.current;
      else minHeightRef.current = minH;
      setMinHeight(minH);

      // Attach to an already-running scan (the login catch-up, or one started
      // elsewhere) so its progress shows here immediately. Without this the
      // panel would render an enabled "Start scan" button over a scan that's
      // already in flight, and tapping it just fires a duplicate the server
      // rejects — which is what made progress appear only after a tab switch.
      let active = false;
      // Kept past the `if` below: an IDLE scan's record is where a gap from
      // the last run is reported, and that is exactly the case the range has
      // to be set from.
      let p0: api.ScanProgress | null = null;
      try {
        p0 = await api.getScanProgress(inkey, w.id);
        if (p0?.active) {
          active = true;
          setProgress(p0);
          setScanning(true);
          pollFn.current(w.id);
        } else if (p0) {
          // Not scanning, but it may still be reporting a block it could not
          // read. Nothing else on this screen would ever show it.
          setProgress(p0);
        }
      } catch {
        /* treat as no active scan */
      }

      // Prefill the range when idle (not mid-scan and none just detected), and
      // always when the fields are still empty.
      //
      // The empty case matters because it is what a wallet looks like when the
      // server reports a scan that is not really running: the panel attaches to
      // it, so `active` is true, so the range never got filled in and the user
      // was left staring at "From __ up to __" with no way to start anything.
      // Filling empty fields can never overwrite something the user typed.
      if (newTip) {
        const birth = Number(w.last_height) || 0;
        // A gap wins over the resume point. resumeFrom floors the start at the
        // highest height ever seen, which is what stops a transient low read
        // rewinding the range — and is also what made an unread block
        // unreachable: the only honest place to start is the block that was
        // never looked at.
        const unread = p0?.gap ?? null;
        const from = String(
          unread != null
            ? Math.max(unread, minH || 0)
            : resumeFrom(birth, scannedFloorRef.current, newTip, minH),
        );
        const idle = !scanning && !active;
        // Updater form so each field is compared against its LIVE value — this
        // callback's closure can be a keystroke behind, and overwriting a height
        // the user is halfway through typing would be worse than a blank field.
        setFromHeight((cur) => (idle || !cur ? from : cur));
        setToHeight((cur) => (idle || !cur ? String(newTip) : cur));
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to load scan status.');
    } finally {
      setLoading(false);
    }
  }, [inkey, scanning]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inkey]);

  // Tick the scan cooldown once a second so the Start button re-enables on time.
  // The id is lifted out rather than reaching through `wallet` inside: the
  // effect only ever wanted the id, and depending on the whole object would
  // restart the timer every time the wallet was refetched into a new object
  // with the same contents.
  const cooldownWalletId = wallet?.id;
  useEffect(() => {
    if (!cooldownWalletId) return undefined;
    const tick = () => setCooldownSec(cooldownRemaining(cooldownWalletId));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [cooldownWalletId]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // Effective scanned height: floored at the highest we've seen so a transient
  // low read doesn't make the status/labels flicker backwards (and disagree with
  // the resume range, which uses the same floor).
  const effectiveScanned = Math.max(
    Number(wallet?.last_scan_height) || 0,
    Number(wallet?.last_height) || 0,
    scannedFloorRef.current,
  );

  // A block the last scan could not read. Until it is read, the wallet has a
  // hole in it and nothing else on this screen may claim otherwise.
  const gap = progress.gap ?? null;

  const upToDate = (() => {
    if (!wallet || !tip) return false;
    // NOT "up to date" with a hole in it, whatever the heights say. This is
    // how a mainnet change output went missing: the scan reported complete,
    // the wallet read as scanned to the tip, and the block holding the
    // payment had never been looked at.
    if (gap != null) return false;
    return effectiveScanned >= tip;
  })();

  const pct = progress.total
    ? Math.min(100, Math.floor((progress.current / progress.total) * 100))
    : 0;

  const poll = useCallback(
    (walletId: string) => {
      stopPoll();
      pollRef.current = setInterval(async () => {
        if (!inkey) return;
        try {
          const p = await api.getScanProgress(inkey, walletId);
          setProgress(p);
          if (!p.active) {
            stopPoll();
            setScanning(false);
            if (p.total > 0) {
              setResult({
                found: p.found,
                scanned: p.current,
                total: p.total,
                stopped: p.current < p.total,
              });
            }
            // Refresh wallet + tip so heights/up-to-date reflect the new state.
            await load();
          }
        } catch {
          /* transient — keep polling */
        }
      }, POLL_MS);
    },
    [inkey, stopPoll, load],
  );
  // Keep the ref pointing at the current poll so load() can attach to a
  // running scan (see the active-scan check above).
  pollFn.current = poll;

  const onStart = useCallback(async () => {
    setError(null);
    setResult(null);
    if (!wallet || !inkey) return;

    const wait = cooldownRemaining(wallet.id);
    if (wait > 0) {
      setError(`Please wait ${wait}s before scanning again.`);
      return;
    }

    // An armed rescan wins over the computed range. It is the only thing on
    // this screen that deliberately goes BACKWARDS, and the server will not
    // let it rewind the resume point (set_last_scan_height only moves
    // forward), so it costs the blocks it scans and nothing else.
    //
    // Resolved HERE rather than held in state, so a date sits in the field
    // across midnight and still means the day it names.
    const back = lookback != null && tip ? lookbackBlocks(lookback) : null;
    if (lookback?.kind === 'date' && back == null) {
      setError('Enter a past date as YYYY-MM-DD.');
      return;
    }
    const armed = back != null && tip ? rangeFor(back, tip, minHeight) : null;
    const from = armed ? armed.from : Number(fromHeight);
    const to = armed ? armed.to : Number(toHeight);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      setError('Enter both From and To heights.');
      return;
    }
    if (minHeight && from < minHeight) {
      setError(`From height can't be below ${groupThousands(minHeight)}.`);
      return;
    }
    if (from > to) {
      setError("From height can't be greater than To height.");
      return;
    }
    if (tip && to > tip) {
      setError(`To height can't be above the chain tip (${groupThousands(tip)}).`);
      return;
    }

    const keys = await getWalletKeys(wallet.id);
    if (!keys) {
      setError('Wallet keys are not on this device. Recover them to scan.');
      return;
    }

    setScanning(true);
    setProgress({ active: true, current: 0, total: 0, found: 0 });
    try {
      await api.startScan(inkey, wallet.id, keys.scanSecret, from, to);
      // Disarm: the next press is the ordinary catch-up again.
      setLookback(null);
      markScanStarted(wallet.id); // arm the 1-min cooldown
      setCooldownSec(cooldownRemaining(wallet.id));
      poll(wallet.id);
    } catch (e: any) {
      const raw = e?.message || '';
      const msg = raw.toLowerCase();
      if (/already running|another scan/.test(msg)) {
        // A scan is already running (e.g. the login catch-up) — attach to it.
        poll(wallet.id);
      } else if (/recently|too many|try again in/.test(msg)) {
        // Backend cooldown — sync the client timer to the reported wait.
        const m = raw.match(/(\d+)\s*second/i);
        setCooldown(wallet.id, m ? Number(m[1]) : SCAN_COOLDOWN_SECONDS);
        setCooldownSec(cooldownRemaining(wallet.id));
        setScanning(false);
        setError(raw || 'Wallet was scanned recently. Try again shortly.');
      } else {
        setScanning(false);
        setError(raw || 'Scan failed to start.');
      }
    }
  }, [wallet, inkey, fromHeight, toHeight, minHeight, tip, poll, lookback]);

  const onStop = useCallback(async () => {
    if (!wallet || !inkey) return;
    setStopping(true);
    try {
      await api.stopScan(inkey, wallet.id);
    } catch {
      /* ignore */
    } finally {
      setStopping(false);
    }
  }, [wallet, inkey]);

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={PRIMARY} />
      </View>
    );
  }

  if (missing) {
    return (
      <View style={styles.center}>
        <Text style={styles.info}>
          No Silent Payments wallet on this network. Create one on the Wallet tab
          first.
        </Text>
      </View>
    );
  }

  const behind =
    tip && wallet ? Math.max(0, tip - effectiveScanned) : null;

  // What the armed lookback resolves to right now, or null when nothing is
  // armed and when a typed date is not yet a date. Both the caption and the
  // button read it, so a half-typed date disables the button instead of
  // scanning some other range.
  const armedBlocks = lookback != null && tip ? lookbackBlocks(lookback) : null;
  const armedRange =
    armedBlocks != null && tip ? rangeFor(armedBlocks, tip, minHeight) : null;
  // Nothing to scan forward to AND nothing armed, or armed but not yet
  // resolvable.
  const scanBlocked = armedRange
    ? false
    : lookback != null
    ? true
    : upToDate;

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={PRIMARY}
          />
        }>
        <Text style={styles.subhead}>
          Scan the chain to find Silent Payments sent to your address.
        </Text>

        <View style={styles.card}>
          <Row label="Chain tip" value={tip ? groupThousands(tip) : '—'} />
          <Row
            label="Scanned to"
            value={
              // last_scan_height is 0/1 (or ≤ birth) until a scan makes real
              // progress, so only show a height once it's past the wallet's
              // birth — otherwise a never-scanned wallet reads "Scanned to 1".
              wallet && effectiveScanned > Number(wallet.last_height || 0)
                ? groupThousands(effectiveScanned)
                : '—'
            }
          />
          <Row
            label="Status"
            value={
              gap != null
                ? `Block ${groupThousands(gap)} unread`
                : upToDate
                ? 'Up to date'
                : behind != null
                ? `${groupThousands(behind)} block${behind === 1 ? '' : 's'} behind`
                : '—'
            }
            valueStyle={upToDate && gap == null ? styles.ok : styles.warnText}
          />
        </View>

        {gap != null ? (
          <View style={styles.card}>
            <Text style={styles.warn}>
              The server could not read block {groupThousands(gap)}, so anything
              paid to you in it has not been seen. The blocks above it were
              scanned. Scanning from {groupThousands(gap)} again is below, and
              will work once the server's index covers that block.
            </Text>
          </View>
        ) : null}

        {!keysPresent ? (
          <View style={styles.card}>
            <Text style={styles.warn}>
              This wallet's keys aren't on this device, so it can't scan. Restore
              them from your recovery phrase.
            </Text>
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={() => setShowRecover(true)}>
              <Text style={styles.primaryBtnText}>Recover Keys</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.card}>
            {scanning ? (
              <>
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${pct}%` }]} />
                </View>
                <Text style={styles.progressText}>
                  {groupThousands(progress.current)} /{' '}
                  {groupThousands(progress.total)} blocks · {pct}%
                  {progress.found > 0
                    ? ` · ${progress.found} found`
                    : ''}
                </Text>
                <TouchableOpacity
                  style={[styles.stopBtn, stopping && styles.btnDisabled]}
                  onPress={onStop}
                  disabled={stopping}>
                  <Text style={styles.stopBtnText}>
                    {stopping ? 'Stopping…' : 'Stop'}
                  </Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                {armedRange ? (
                  <Text style={styles.rangeCaption}>
                    Blocks {groupThousands(armedRange.from)} –{' '}
                    {groupThousands(armedRange.to)}
                  </Text>
                ) : !upToDate && behind && fromHeight && toHeight ? (
                  <Text style={styles.rangeCaption}>
                    Blocks {groupThousands(Number(fromHeight))} –{' '}
                    {groupThousands(Number(toHeight))}
                  </Text>
                ) : null}
                <TouchableOpacity
                  style={[
                    styles.primaryBtn,
                    (scanBlocked || cooldown > 0) && styles.btnDisabled,
                  ]}
                  onPress={onStart}
                  disabled={scanBlocked || cooldown > 0}>
                  <Text style={styles.primaryBtnText}>
                    {cooldown > 0
                      ? `Scan again in ${cooldown}s`
                      : armedRange
                      ? `Rescan ${describeLookback(lookback)}`
                      : lookback != null
                      ? 'Enter a date'
                      : upToDate
                      ? 'Up to date'
                      : behind
                      ? `Scan ${groupThousands(behind)} block${
                          behind === 1 ? '' : 's'
                        }`
                      : 'Start scan'}
                  </Text>
                </TouchableOpacity>

                {/* Looking BACKWARDS, which nothing else here does. Offered
                    whatever the wallet's state, because "up to date" is
                    exactly when somebody needs it: a payment that never
                    appeared is in a block the wallet believes it has already
                    read. The server will not let this rewind the resume
                    point, so the only cost is the blocks it scans. */}
                <View style={styles.lookback}>
                  <Text style={styles.lookbackLabel}>
                    Payment missing? Look again from:
                  </Text>
                  <View style={styles.lookbackRow}>
                    {DAY_OPTIONS.map((days) => {
                      const on =
                        lookback?.kind === 'days' && lookback.days === days;
                      return (
                        <TouchableOpacity
                          key={days}
                          style={[styles.chip, on && styles.chipOn]}
                          onPress={() => {
                            setDateOpen(false);
                            setLookback(on ? null : { kind: 'days', days });
                          }}>
                          <Text style={[styles.chipText, on && styles.chipTextOn]}>
                            {days}d
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                    <TouchableOpacity
                      style={[styles.chip, dateOpen && styles.chipOn]}
                      onPress={() => {
                        const open = !dateOpen;
                        setDateOpen(open);
                        setLookback(open ? { kind: 'date', date: '' } : null);
                      }}>
                      <Text
                        style={[styles.chipText, dateOpen && styles.chipTextOn]}>
                        Date
                      </Text>
                    </TouchableOpacity>
                  </View>
                  {dateOpen ? (
                    <TextInput
                      style={styles.dateInput}
                      value={lookback?.kind === 'date' ? lookback.date : ''}
                      onChangeText={(date) => setLookback({ kind: 'date', date })}
                      placeholder="YYYY-MM-DD"
                      placeholderTextColor={colors.faint}
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="numbers-and-punctuation"
                      maxLength={10}
                    />
                  ) : null}
                  <Text style={styles.lookbackHelp}>
                    {armedBlocks != null
                      ? `About ${groupThousands(armedBlocks)} blocks. ` +
                        'Nothing already scanned is lost.'
                      : 'Pick how far back, then scan.'}
                  </Text>
                </View>
              </>
            )}

            {error ? <Text style={styles.error}>{error}</Text> : null}

            {result && !scanning ? (
              <View style={styles.result}>
                <Text style={styles.resultTitle}>
                  {result.stopped ? 'Scan stopped' : 'Scan complete'}
                </Text>
                <Text style={styles.resultLine}>
                  {groupThousands(result.scanned)} of{' '}
                  {groupThousands(result.total)} blocks scanned
                </Text>
                <Text
                  style={[
                    styles.resultLine,
                    result.found > 0 && styles.resultFound,
                  ]}>
                  {result.found > 0
                    ? `${result.found} new output${result.found === 1 ? '' : 's'} found`
                    : 'No new outputs found'}
                </Text>
              </View>
            ) : null}
          </View>
        )}
      </ScrollView>

      <RecoverKeysModal
        visible={showRecover}
        wallet={wallet}
        onClose={() => setShowRecover(false)}
        onRecovered={() => {
          setShowRecover(false);
          setKeysPresent(true);
          if (wallet) resetCatchUp(wallet.id);
          load();
        }}
      />
    </View>
  );
}

function Row({
  label,
  value,
  valueStyle,
}: {
  label: string;
  value: string;
  valueStyle?: object;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, valueStyle]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    minHeight: 220,
  },
  content: { padding: 16, paddingTop: 4 },
  subhead: { fontSize: 14, color: colors.muted, marginTop: 4, marginBottom: 16 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 20,
    marginBottom: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  rowLabel: { fontSize: 14, color: colors.muted },
  rowValue: { fontSize: 14, fontWeight: '600', color: colors.text },
  ok: { color: colors.green },
  warnText: { color: PRIMARY },

  lookback: { marginTop: 18 },
  lookbackLabel: { fontSize: 13, color: colors.text, marginBottom: 8 },
  lookbackRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
    backgroundColor: colors.surfaceAlt,
  },
  chipOn: { borderColor: PRIMARY, backgroundColor: PRIMARY },
  chipText: { fontSize: 13, color: colors.text },
  chipTextOn: { color: colors.onPrimary, fontWeight: '600' },
  lookbackHelp: { fontSize: 12, color: colors.faint, marginTop: 8, lineHeight: 17 },
  dateInput: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    backgroundColor: colors.surfaceAlt,
    fontSize: 15,
  },
  rangeCaption: {
    fontSize: 13,
    color: colors.muted,
    textAlign: 'center',
    marginBottom: 4,
  },

  progressTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.surfaceAlt,
    marginTop: 20,
    overflow: 'hidden',
  },
  progressFill: { height: 8, backgroundColor: PRIMARY, borderRadius: 4 },
  progressText: { fontSize: 13, color: colors.muted, marginTop: 8, textAlign: 'center' },

  primaryBtn: {
    backgroundColor: PRIMARY,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 20,
  },
  primaryBtnText: {
    color: colors.onPrimary,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  btnDisabled: { opacity: 0.45 },
  stopBtn: {
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 16,
  },
  stopBtnText: { color: colors.danger, fontSize: 15, fontWeight: '600' },

  error: { color: colors.danger, fontSize: 13, marginTop: 14, textAlign: 'center' },
  warn: { fontSize: 13, color: colors.danger, lineHeight: 19 },
  info: { fontSize: 14, color: colors.muted, textAlign: 'center', lineHeight: 20 },

  result: {
    marginTop: 18,
    paddingTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    alignItems: 'center',
  },
  resultTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  resultLine: { fontSize: 14, color: colors.muted, marginTop: 4 },
  resultFound: { color: colors.green, fontWeight: '600' },
});
