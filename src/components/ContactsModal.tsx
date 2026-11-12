import React, { useState } from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as api from '@services/api';
import { CONTACT_UNVERIFIED, CONTACT_VERIFIED } from '@services/sendWarnings';
import { colors } from '@/theme';

const PRIMARY = colors.primary;

function truncMid(s: string, head = 12, tail = 8): string {
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

interface Props {
  visible: boolean;
  contacts: api.SpContact[];
  onClose: () => void;
  onPick: (value: string) => void;
  onDelete: (id: string) => void;
  onUpdate?: (id: string, value: string) => Promise<void>;
}

export default function ContactsModal({
  visible,
  contacts,
  onClose,
  onPick,
  onDelete,
  onUpdate,
}: Props) {
  // Which contact is being repointed, and at what. A saved SP address cannot
  // be corrected any other way: deleting and re-adding loses the name.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async (id: string) => {
    if (!onUpdate) return;
    setBusy(true);
    setErr(null);
    try {
      await onUpdate(id, draft.trim());
      setEditing(null);
    } catch (e: any) {
      setErr(e?.message || 'Could not update that contact.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.header}>
          <Text style={styles.title}>Contacts</Text>
          <TouchableOpacity onPress={onClose} hitSlop={8}>
            <Text style={styles.close}>Done</Text>
          </TouchableOpacity>
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          {contacts.length === 0 ? (
            <Text style={styles.empty}>
              No saved contacts yet. Enter a recipient on the Send screen and tap
              “Save contact”.
            </Text>
          ) : (
            contacts.map((c) => (
              <View key={c.id} style={styles.card}>
                <View style={styles.row}>
                  <View style={styles.info}>
                    <Text style={styles.label} numberOfLines={1}>
                      {c.label || c.value}
                      {c.kind === 'bitmail' ? '  ✉' : ''}
                    </Text>
                    <Text style={styles.value} numberOfLines={1}>
                      {c.unreadable ? 'Address cannot be read' : truncMid(c.value)}
                    </Text>
                  </View>
                  {/* Nothing to use: an unreadable contact has no address, and
                      a Use button over an empty one would put nothing in the
                      recipient field and look like it did something. */}
                  {c.unreadable ? null : (
                    <TouchableOpacity
                      style={styles.useBtn}
                      onPress={() => {
                        onPick(c.value);
                        onClose();
                      }}>
                      <Text style={styles.useText}>Use</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    style={styles.removeBtn}
                    onPress={() => onDelete(c.id)}>
                    <Text style={styles.removeText}>Remove</Text>
                  </TouchableOpacity>
                </View>

                {/* What the server can honestly say about this address, in the
                    words the web app uses too — services/sendWarnings.ts has
                    the reasoning behind the wording. */}
                {c.unreadable ? (
                  <Text style={styles.warnNote}>
                    This address cannot be read. Tap “Change address” to enter it again.
                  </Text>
                ) : c.kind === 'sp' && c.whispa === true ? (
                  <Text style={styles.okNote}>{CONTACT_VERIFIED}</Text>
                ) : c.kind === 'sp' && c.whispa === false ? (
                  <Text style={styles.warnNote}>{CONTACT_UNVERIFIED}</Text>
                ) : null}

                {onUpdate && editing === c.id ? (
                  <View>
                    <TextInput
                      style={styles.input}
                      value={draft}
                      onChangeText={setDraft}
                      autoCapitalize="none"
                      autoCorrect={false}
                      placeholder="sp1… or name@domain"
                      placeholderTextColor={colors.faint}
                    />
                    {err ? <Text style={styles.warnNote}>{err}</Text> : null}
                    <View style={styles.editRow}>
                      <TouchableOpacity
                        style={styles.useBtn}
                        disabled={busy || !draft.trim()}
                        onPress={() => save(c.id)}>
                        <Text style={styles.useText}>
                          {busy ? 'Saving…' : 'Save'}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.removeBtn}
                        onPress={() => setEditing(null)}>
                        <Text style={styles.cancelText}>Cancel</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : onUpdate ? (
                  <TouchableOpacity
                    onPress={() => {
                      setErr(null);
                      setDraft(c.value);
                      setEditing(c.id);
                    }}>
                    <Text style={styles.editText}>Change address</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ))
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: { fontSize: 22, fontWeight: 'bold', color: colors.text },
  close: { fontSize: 16, fontWeight: '600', color: PRIMARY },
  content: { padding: 16, paddingTop: 4 },
  empty: { fontSize: 14, color: colors.faint, textAlign: 'center', marginTop: 24, lineHeight: 20 },
  card: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
  },
  row: { flexDirection: 'row', alignItems: 'center' },
  okNote: { fontSize: 12, color: colors.green, marginTop: 8, lineHeight: 17 },
  warnNote: { fontSize: 12, color: colors.warn, marginTop: 8, lineHeight: 17 },
  editText: { fontSize: 13, fontWeight: '600', color: PRIMARY, marginTop: 10 },
  cancelText: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  editRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 10,
    fontSize: 13,
    fontFamily: 'monospace',
    color: colors.text,
  },
  info: { flex: 1, marginRight: 10 },
  label: { fontSize: 15, fontWeight: '600', color: colors.text },
  value: { fontSize: 12, color: colors.faint, fontFamily: 'monospace', marginTop: 2 },
  useBtn: {
    backgroundColor: PRIMARY,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginRight: 8,
  },
  useText: { color: colors.onPrimary, fontSize: 13, fontWeight: '600' },
  removeBtn: { paddingHorizontal: 6, paddingVertical: 8 },
  removeText: { color: colors.danger, fontSize: 13, fontWeight: '600' },
});
