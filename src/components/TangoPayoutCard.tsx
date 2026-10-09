// Where a Tango's change goes, if not into your own wallet.
//
// WHAT THIS SETTING IS FOR. A round leaves a change output, and it is the
// strongest remaining linkability problem in Tango: its value is fixed by the
// round's arithmetic, so spending it later — to anyone, on its own, months
// afterwards — identifies which of the two identical shares were yours. The
// wallet can refuse to spend it alongside a share (undoesARound does), but it
// cannot stop the coin from eventually being spent. Getting it out of the
// wallet is the only clean fix.
//
// So: give a Lightning address you control, and the change output pays the
// service instead, with its value sent on. WhiSPa holds no Lightning balance
// — this money goes to an account the app never touches.
//
// IT SAYS WHEN, before the field rather than after a round: the change goes
// out once the round's transaction confirms, not when the address is saved.
// That gap is what makes a payout look lost when it is only pending.
//
// ONE PLACE: the Tango screen. It was briefly in Settings as well, which made
// the same switch answerable from two screens with no way to tell which one
// you had last used.
//
// THREE STATES, and the middle one is why this was rewritten. Turning the
// setting off used to delete the address, so coming back meant an empty field
// and no way to tell whether anything had been saved — the only route back on
// was remembering what had been typed. Off now keeps the address and shows it,
// greyed, with a way back on; forgetting it is a separate button that says so.
//
// Shown where the server says it can be paid, and nowhere else. `offered` is
// its answer and this renders nothing without it — never a network check of
// this client's own, because the question is not which chain the user is on
// but whether the instance has a payout wallet ON that chain. Mainnet with an
// LNbits wallet was the only yes for a long time; an NWC wallet reports its
// own chain, so a signet instance connected to a signet wallet is another.
// See siLNt helpers/nwc.py.

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as api from '@services/api';
import {
  LN_ADDRESS_EXAMPLE,
  PAYOUT_PROMPT,
  PAYOUT_WHEN,
  PAYOUT_WHEN_SET,
  PAYOUT_TITLE,
  PAYOUT_WHY,
  lnAddressProblem,
  payoutMinimumNote,
} from '@services/lnAddress';
import { colors } from '@/theme';

const PRIMARY = colors.primary;

export default function TangoPayoutCard({
  inkey,
  network,
}: {
  inkey: string | null;
  network: string;
}) {
  const [setting, setSetting] = useState<api.TangoPayoutSetting | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!inkey || !network) return;
    try {
      const s = await api.getTangoPayoutSetting(inkey, network);
      setSetting(s);
      setDraft(s.address || '');
    } catch {
      // A setting that cannot be read is not worth an error on a screen about
      // something else. It renders nothing, and the round is unaffected.
      setSetting(null);
    }
  }, [inkey, network]);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(async () => {
    Keyboard.dismiss();
    setError(null);
    setNote(null);
    const value = draft.trim().toLowerCase();
    // The shape, locally, so an obvious typo costs no round trip. Whether
    // anyone answers there is the server's to find out.
    const problem = lnAddressProblem(value);
    if (problem) {
      setError(problem);
      return;
    }
    if (!inkey) return;
    setBusy(true);
    try {
      await api.setTangoLnAddress(inkey, network, value);
      setEditing(false);
      setNote('Saved. Your change will be sent here after a round confirms.');
      await load();
    } catch (e: any) {
      // Worth showing verbatim: the server resolved the address and is saying
      // what it found — unreachable, or a minimum above a change payout.
      setError(e?.message || 'Could not save that address.');
    } finally {
      setBusy(false);
    }
  }, [draft, inkey, network, load]);

  // Off, but remembered. The address stays saved and shown, so turning it
  // back on is a tap — which is the whole reason this is not a delete.
  const setEnabled = useCallback(
    async (on: boolean) => {
      if (!inkey) return;
      setBusy(true);
      setError(null);
      setNote(null);
      try {
        await api.setTangoPayoutEnabled(inkey, network, on);
        setNote(
          on
            ? 'Back on. Your change will be sent to this address.'
            : 'Turned off. Your change stays in your wallet, and this address '
              + 'is kept so you can turn it back on.',
        );
        setEditing(false);
        await load();
      } catch (e: any) {
        setError(e?.message || 'Could not change that.');
      } finally {
        setBusy(false);
      }
    },
    [inkey, network, load],
  );

  // The heavier half: stop holding the address at all.
  const forget = useCallback(async () => {
    if (!inkey) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteTangoLnAddress(inkey, network);
      setNote('Forgotten. Your change will stay in your wallet.');
      setDraft('');
      setEditing(false);
      await load();
    } catch (e: any) {
      setError(e?.message || 'Could not forget that address.');
    } finally {
      setBusy(false);
    }
  }, [inkey, network, load]);

  // Off mainnet, or not configured on this instance: nothing to offer, and a
  // field that cannot work is worse than no field.
  if (!setting || !setting.offered) return null;

  const saved = !!setting.address;
  // Saved and switched on. Off keeps the address, so these are not the
  // same question.
  const on = saved && setting.enabled;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>{PAYOUT_TITLE}</Text>

      {!setting.ready ? (
        // The chain allows it; this instance has not switched it on.
        <Text style={styles.muted}>
          Not available on this server yet. Your change stays in your wallet.
        </Text>
      ) : (
        <>
          <Text style={styles.body}>{PAYOUT_WHY}</Text>
          <Text style={styles.when}>{PAYOUT_WHEN}</Text>
          {/* Beside WHEN, because both are about timing and this is the one
              that decides whether the switch in front of you applies to the
              round you are about to start. */}
          <Text style={styles.when}>{PAYOUT_WHEN_SET}</Text>
          <Text style={styles.muted}>
            {payoutMinimumNote(setting.min_change_sats)}
          </Text>

          {saved && !editing ? (
            <>
              {/* Saved but off: say so, because an address sitting there
                  looks like it is in use. */}
              {!on ? (
                <Text style={styles.offLabel}>
                  Off — your change stays in your wallet.
                </Text>
              ) : null}
              <View style={styles.savedRow}>
                <Text
                  style={[styles.savedAddr, !on && styles.savedAddrOff]}
                  numberOfLines={1}>
                  {setting.address}
                </Text>
                {on ? (
                  <TouchableOpacity
                    onPress={() => setEnabled(false)}
                    disabled={busy}>
                    <Text style={styles.removeLink}>Turn off</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    onPress={() => setEnabled(true)}
                    disabled={busy}>
                    <Text style={styles.link}>Turn on</Text>
                  </TouchableOpacity>
                )}
              </View>
              <View style={styles.actions}>
                <TouchableOpacity
                  onPress={() => {
                    setNote(null);
                    setError(null);
                    setEditing(true);
                  }}>
                  <Text style={styles.link}>Change address</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={forget} disabled={busy}>
                  <Text style={styles.forgetLink}>Forget it</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <View>
              <Text style={styles.prompt}>{PAYOUT_PROMPT}</Text>
              <TextInput
                style={styles.input}
                value={draft}
                onChangeText={(t) => {
                  setDraft(t);
                  setError(null);
                  setNote(null);
                }}
                placeholder={LN_ADDRESS_EXAMPLE}
                placeholderTextColor={colors.faint}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
              />
              <View style={styles.actions}>
                <TouchableOpacity
                  style={[
                    styles.saveBtn,
                    (busy || !draft.trim()) && styles.btnDisabled,
                  ]}
                  onPress={save}
                  disabled={busy || !draft.trim()}>
                  {busy ? (
                    <ActivityIndicator color={colors.onPrimary} size="small" />
                  ) : (
                    <Text style={styles.saveText}>Save</Text>
                  )}
                </TouchableOpacity>
                {saved ? (
                  <TouchableOpacity
                    onPress={() => {
                      setEditing(false);
                      setDraft(setting.address);
                      setError(null);
                    }}>
                    <Text style={styles.link}>Cancel</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          )}

          {error ? <Text style={styles.error}>{error}</Text> : null}
          {note ? <Text style={styles.note}>{note}</Text> : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 14,
    marginTop: 16,
  },
  title: { fontSize: 15, fontWeight: '600', color: colors.text },
  body: { fontSize: 13, color: colors.muted, lineHeight: 18, marginTop: 6 },
  when: { fontSize: 13, color: colors.muted, lineHeight: 18, marginTop: 8 },
  muted: { fontSize: 12, color: colors.faint, lineHeight: 17, marginTop: 8 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: 10,
    paddingVertical: 9,
    marginTop: 12,
    fontSize: 13,
    color: colors.text,
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 10 },
  saveBtn: {
    backgroundColor: PRIMARY,
    borderRadius: 8,
    paddingHorizontal: 18,
    paddingVertical: 9,
  },
  saveText: { color: colors.onPrimary, fontSize: 13, fontWeight: '600' },
  btnDisabled: { opacity: 0.5 },
  savedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginTop: 12,
  },
  savedAddr: {
    flex: 1,
    fontSize: 13,
    color: colors.text,
    fontFamily: 'monospace',
  },
  savedAddrOff: { color: colors.faint },
  link: { fontSize: 13, fontWeight: '600', color: PRIMARY },
  removeLink: { fontSize: 13, fontWeight: '600', color: colors.warn },
  forgetLink: { fontSize: 13, fontWeight: '600', color: colors.danger },
  offLabel: { fontSize: 12, color: colors.faint, marginTop: 12 },
  prompt: { fontSize: 13, color: colors.text, marginTop: 12 },
  error: { fontSize: 12, color: colors.danger, lineHeight: 17, marginTop: 10 },
  note: { fontSize: 12, color: colors.green, lineHeight: 17, marginTop: 10 },
});
