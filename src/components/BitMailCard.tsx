import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { useAuthStore } from '@stores/authStore';
import { useBitmailAlert } from '@stores/bitmailAlert';
import * as api from '@services/api';
import { colors } from '@/theme';
import BrandText from './BrandText';

const PRIMARY = colors.primary;
// Mirror the backend rules (models.py): 3–20 chars, lowercase letters/digits/-/_,
// plus a reserved list. "Taken" can only be confirmed on submit (no lookup API).
const USERNAME_RE = /^[a-z0-9_-]{3,20}$/;
const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'root', 'support', 'help', 'info', 'abuse',
  'postmaster', 'webmaster', 'system', 'anthropic', 'claude', 'bot',
  'moderator', 'mod', 'service', 'noreply', 'no-reply', 'test', 'demo',
]);

// Inline validation message (null = ok, or too short to judge yet).
function usernameIssue(u: string): string | null {
  if (!u) return null;
  if (u.length < 3) return null; // don't nag while they're still typing
  if (!USERNAME_RE.test(u)) {
    return 'Use 3–20 lowercase letters, digits, - or _.';
  }
  if (RESERVED_USERNAMES.has(u)) return 'This username is reserved. Choose another.';
  return null;
}

interface Props {
  wallet: api.SilntWallet;
}

/**
 * BitMail (BIP-353) request card. Rendered only when the account has an SP
 * wallet (the parent gates on that) and the server has a domain configured.
 * Shows the existing BitMail, a pending request (with cancel), or a request form.
 */
export default function BitMailCard({ wallet }: Props) {
  const inkey = useAuthStore((s) => s.inkey);
  const tamper = useBitmailAlert((s) => s.tamper);

  const [loading, setLoading] = useState(true);
  const [domain, setDomain] = useState('');
  const [requests, setRequests] = useState<api.Bip353Request[]>([]);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [avail, setAvail] = useState<'idle' | 'checking' | 'ok' | 'taken'>('idle');

  // Debounced live availability check once the name passes local validation.
  useEffect(() => {
    const u = username.trim().toLowerCase();
    if (!inkey || !USERNAME_RE.test(u) || RESERVED_USERNAMES.has(u)) {
      setAvail('idle');
      return;
    }
    setAvail('checking');
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await api.checkBip353Available(inkey, u);
        if (!cancelled) setAvail(res.available ? 'ok' : 'taken');
      } catch {
        // Endpoint unavailable (older backend) — don't block; submit still validates.
        if (!cancelled) setAvail('idle');
      }
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [username, inkey]);

  const load = useCallback(async () => {
    if (!inkey) return;
    try {
      const [dom, reqs] = await Promise.allSettled([
        api.getBitmailDomain(inkey),
        api.listMyBip353Requests(inkey),
      ]);
      setDomain(dom.status === 'fulfilled' ? dom.value?.domain || '' : '');
      setRequests(reqs.status === 'fulfilled' ? reqs.value : []);
    } catch {
      /* leave defaults */
    } finally {
      setLoading(false);
    }
  }, [inkey]);

  useEffect(() => {
    load();
  }, [load]);

  const pending = useMemo(
    () =>
      requests.find((r) => r.wallet_id === wallet.id && r.status === 'pending'),
    [requests, wallet.id],
  );
  const approved = useMemo(
    () =>
      requests.find((r) => r.wallet_id === wallet.id && r.status === 'approved'),
    [requests, wallet.id],
  );

  const current =
    wallet.hr_address ||
    (approved && domain
      ? `${approved.final_username || approved.requested_username}@${domain}`
      : '');

  const onRequest = useCallback(async () => {
    setError(null);
    const u = username.trim().toLowerCase();
    if (!USERNAME_RE.test(u)) {
      setError('Username must be 3–20 chars: lowercase letters, digits, - or _.');
      return;
    }
    if (RESERVED_USERNAMES.has(u)) {
      setError('This username is reserved. Choose another.');
      return;
    }
    if (!inkey) return;
    setBusy(true);
    try {
      await api.createBip353Request(inkey, {
        wallet_id: wallet.id,
        requested_username: u,
      });
      setUsername('');
      await load();
    } catch (e: any) {
      setError(e?.message || 'Could not submit request.');
    } finally {
      setBusy(false);
    }
  }, [username, inkey, wallet.id, load]);

  const onCancel = useCallback(async () => {
    if (!inkey || !pending) return;
    setBusy(true);
    try {
      await api.cancelBip353Request(inkey, pending.id);
      await load();
    } catch (e: any) {
      setError(e?.message || 'Could not cancel request.');
    } finally {
      setBusy(false);
    }
  }, [inkey, pending, load]);

  // Feature unavailable on this server — render nothing.
  if (!loading && !domain) return null;

  const tampered = !!tamper && tamper.bitmail === (wallet.hr_address || current);

  return (
    <View style={styles.card}>
      <BrandText style={styles.title} text="BitMail (BIP-353)" />

      {tampered ? (
        <View style={styles.tamper}>
          <Text style={styles.tamperTitle}>⚠ Tampering detected</Text>
          <Text style={styles.tamperBody}>
            This BitMail resolves to {tamper!.resolved.slice(0, 14)}… instead of
            your wallet address. Don't rely on it — your admin has been alerted.
          </Text>
        </View>
      ) : null}

      {loading ? (
        <ActivityIndicator style={styles.spinner} color={PRIMARY} />
      ) : current ? (
        <>
          <Text style={styles.caption}>
            A human-readable address that resolves to this wallet.
          </Text>
          <Text style={styles.address}>{current}</Text>
          <TouchableOpacity
            style={styles.ghostBtn}
            onPress={() => Clipboard.setString(current)}>
            <Text style={styles.ghostBtnText}>Copy</Text>
          </TouchableOpacity>
        </>
      ) : pending ? (
        <>
          <Text style={styles.caption}>Request submitted — awaiting approval.</Text>
          <Text style={styles.address}>
            {pending.requested_username}@{domain}
          </Text>
          <View style={styles.pendingRow}>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>Pending</Text>
            </View>
            <TouchableOpacity onPress={onCancel} disabled={busy}>
              <Text style={styles.cancel}>{busy ? '…' : 'Cancel'}</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : (
        <>
          <Text style={styles.caption}>
            Request a memorable address like name@{domain} for this wallet.
          </Text>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={username}
              onChangeText={(t) => {
                setUsername(t.toLowerCase().replace(/[^a-z0-9_-]/g, ''));
                setError(null);
              }}
              placeholder="name"
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={20}
            />
            <Text style={styles.domain}>@{domain}</Text>
          </View>
          {usernameIssue(username) ? (
            <Text style={styles.issue}>{usernameIssue(username)}</Text>
          ) : avail === 'checking' ? (
            <Text style={styles.caption}>Checking availability…</Text>
          ) : avail === 'ok' ? (
            <Text style={styles.available}>✓ {username}@{domain} is available</Text>
          ) : avail === 'taken' ? (
            <Text style={styles.issue}>✗ That username is already taken</Text>
          ) : (
            <Text style={styles.caption}>
              3–20 chars: lowercase letters, digits, - or _.
            </Text>
          )}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {(() => {
            const invalid =
              !USERNAME_RE.test(username) ||
              RESERVED_USERNAMES.has(username) ||
              avail === 'taken';
            return (
              <TouchableOpacity
                style={[styles.primaryBtn, (busy || invalid) && styles.btnDisabled]}
                onPress={onRequest}
                disabled={busy || invalid}>
                {busy ? (
                  <ActivityIndicator color={colors.onPrimary} />
                ) : (
                  <BrandText style={styles.primaryBtnText} text="Request BitMail" />
                )}
              </TouchableOpacity>
            );
          })()}
        </>
      )}
      {error && (current || pending) ? (
        <Text style={styles.error}>{error}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 20,
    marginTop: 16,
    alignSelf: 'stretch',
  },
  title: { fontSize: 16, fontWeight: '700', color: colors.text },
  caption: { fontSize: 13, color: colors.muted, marginTop: 6, lineHeight: 18 },
  spinner: { marginTop: 12, alignSelf: 'flex-start' },
  address: {
    fontSize: 16,
    fontWeight: '600',
    color: PRIMARY,
    marginTop: 12,
  },
  inputRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.surfaceAlt,
  },
  domain: { fontSize: 15, color: colors.muted, marginLeft: 8 },
  primaryBtn: {
    backgroundColor: PRIMARY,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 14,
  },
  primaryBtnText: { color: colors.onPrimary, fontSize: 15, fontWeight: '600' },
  btnDisabled: { opacity: 0.5 },
  ghostBtn: {
    borderWidth: 1,
    borderColor: PRIMARY,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 14,
  },
  ghostBtnText: { color: PRIMARY, fontSize: 14, fontWeight: '600' },
  pendingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 14,
  },
  badge: {
    backgroundColor: 'rgba(249,115,22,0.12)',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgeText: { color: PRIMARY, fontSize: 12, fontWeight: '700' },
  cancel: { color: colors.danger, fontSize: 14, fontWeight: '600' },
  error: { color: colors.danger, fontSize: 13, marginTop: 12 },
  issue: { color: colors.danger, fontSize: 12, marginTop: 8 },
  available: { color: colors.green, fontSize: 12, fontWeight: '600', marginTop: 8 },
  tamper: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.danger,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginTop: 12,
  },
  tamperTitle: { fontSize: 14, fontWeight: '700', color: colors.danger },
  tamperBody: { fontSize: 12, color: colors.danger, marginTop: 4, lineHeight: 17 },
});

