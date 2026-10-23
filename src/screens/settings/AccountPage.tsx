import React, { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import * as api from '@services/api';
import { useAuthStore } from '@stores/authStore';
import { space } from '@/theme';
import { Block, Button, Field, Group, InfoRow, Note, Page } from './ui';

// Who you are signed in as, and the two things you can do about it.
export default function AccountPage({ onBack }: { onBack: () => void }) {
  const username = useAuthStore((s) => s.username);
  const email = useAuthStore((s) => s.email);
  const inkey = useAuthStore((s) => s.inkey);
  const logout = useAuthStore((s) => s.logout);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteMsg, setInviteMsg] = useState<string | null>(null);
  const [inviteErr, setInviteErr] = useState<string | null>(null);

  const onInvite = useCallback(async () => {
    if (!inkey) return;
    const address = inviteEmail.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
      setInviteErr('Enter a valid email address.');
      setInviteMsg(null);
      return;
    }
    setInviting(true);
    setInviteErr(null);
    setInviteMsg(null);
    try {
      const res = await api.sendInvite(inkey, address);
      setInviteEmail('');
      setInviteMsg(res?.message || `Invitation sent to ${address}.`);
    } catch (e: any) {
      setInviteErr(e?.message || 'Could not send the invitation.');
    } finally {
      setInviting(false);
    }
  }, [inkey, inviteEmail]);

  // Signing out erases the session kept on this phone, so the next launch asks
  // for the password again. Worth saying, since the whole point of the app lock
  // is that it normally does not.
  const onLogout = useCallback(() => {
    Alert.alert(
      'Sign out?',
      'You will need your password to sign in again on this phone. Your wallet keys and recovery phrase stay where they are.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: () => logout() },
      ],
    );
  }, [logout]);

  return (
    <Page title="Account" onBack={onBack}>
      <Group title="Signed in as">
        <InfoRow first title="Username" value={username || '—'} />
        <InfoRow title="Email" value={email || '—'} />
      </Group>

      <Group
        title="Invite a friend"
        footer="We email them a sign-up link. Their address is used for the invite and not stored.">
        <Block first>
          <Field
            value={inviteEmail}
            onChangeText={(t: string) => {
              setInviteEmail(t);
              setInviteErr(null);
              setInviteMsg(null);
            }}
            placeholder="friend@email.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            action="Send"
            onAction={onInvite}
            actionBusy={inviting}
            actionDisabled={!inviteEmail.trim()}
          />
          {inviteErr ? <Note kind="error">{inviteErr}</Note> : null}
          {inviteMsg ? <Note kind="ok">{inviteMsg}</Note> : null}
        </Block>
      </Group>

      <Group title="Session">
        <Block first>
          <Button
            label="Sign out"
            kind="danger"
            onPress={onLogout}
            style={{ marginTop: space.md }}
          />
        </Block>
      </Group>
    </Page>
  );
}
