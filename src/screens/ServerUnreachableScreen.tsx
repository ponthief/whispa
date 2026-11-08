import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuthStore } from '@stores/authStore';
import { colors } from '@/theme';

const PRIMARY = colors.primary;

// Shown when the device-trust check could not be MADE, as opposed to coming
// back negative.
//
// Reported 2026-11-08: *"lnbits instance is down — when opening mobile app it
// prompts for confirmation code for the device check"*. It did, because a
// failed check was folded into "untrusted", and untrusted lands on
// DeviceConfirmScreen — which asks for a six-digit code the server emails,
// from the server that is down. The user is told their device is not trusted
// (it is), and offered the one action that cannot possibly work.
//
// This screen grants nothing the other one did not: the wallet is still behind
// the gate, and every siLNt endpoint checks device trust server-side anyway.
// What it does is say the true thing and offer the useful action, which is to
// ask again in a minute.
export default function ServerUnreachableScreen() {
  const recheckDevice = useAuthStore((s) => s.recheckDevice);
  const logout = useAuthStore((s) => s.logout);

  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const retry = useCallback(async () => {
    setBusy(true);
    setNote(null);
    const status = await recheckDevice();
    setBusy(false);
    // 'trusted' and 'untrusted' both navigate away by themselves — App.tsx is
    // watching the same value. Only staying here needs saying, and saying it
    // beats a button that looks like it did nothing.
    if (status === 'unreachable') setNote('Still no answer. The server is not back yet.');
  }, [recheckDevice]);

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.body}>
        <Text style={styles.mark}>⚡</Text>
        <Text style={styles.heading}>Can't reach the server</Text>
        <Text style={styles.sub}>
          Your wallet and its keys are fine and still on this phone. This app
          needs the server to check your balance and send payments, and it is
          not answering right now.
        </Text>
        <Text style={styles.sub}>
          Nothing is wrong with this device — it just could not ask. Try again
          in a few minutes.
        </Text>

        <TouchableOpacity
          style={[styles.primaryBtn, busy && styles.btnDisabled]}
          onPress={retry}
          disabled={busy}>
          {busy ? (
            <ActivityIndicator color={colors.onPrimary} />
          ) : (
            <Text style={styles.primaryBtnText}>Try again</Text>
          )}
        </TouchableOpacity>

        {note ? <Text style={styles.note}>{note}</Text> : null}

        {/* Signing out is deliberately the SECOND option and worded as what it
            costs. Somebody who cannot get in will reach for it, and on a phone
            whose keys are in the keystore a sign-out means typing the password
            again — which also needs the server that is down. */}
        <TouchableOpacity style={styles.linkBtn} onPress={() => logout()} disabled={busy}>
          <Text style={styles.linkBtnText}>Sign out</Text>
        </TouchableOpacity>
        <Text style={styles.footnote}>
          Signing out needs the server too, to sign back in.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1, padding: 28, justifyContent: 'center' },
  mark: { fontSize: 44, textAlign: 'center', marginBottom: 14 },
  heading: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
  },
  sub: {
    fontSize: 15,
    color: colors.muted,
    lineHeight: 22,
    textAlign: 'center',
    marginTop: 14,
  },
  primaryBtn: {
    backgroundColor: PRIMARY,
    borderRadius: 10,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 28,
  },
  primaryBtnText: { color: colors.onPrimary, fontSize: 16, fontWeight: '600' },
  btnDisabled: { opacity: 0.5 },
  note: { fontSize: 13, color: colors.danger, textAlign: 'center', marginTop: 14 },
  linkBtn: { marginTop: 18, paddingVertical: 8, alignItems: 'center' },
  linkBtnText: { color: colors.muted, fontSize: 15, fontWeight: '600' },
  footnote: {
    fontSize: 12,
    color: colors.faint,
    textAlign: 'center',
    marginTop: 4,
  },
});
