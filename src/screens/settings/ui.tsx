import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TextInputProps,
  View,
  ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, fonts, radius, space, type } from '@/theme';

// The pieces Settings is built from.
//
// Settings used to be one 1000-line screen that styled every row itself, and it
// showed: the same switch row existed in four slightly different sizes, help
// text sat at three different colours, and nothing was bigger than anything
// else. These are the shapes it actually uses, defined once, so a new setting is
// a line of markup rather than another twenty lines of StyleSheet.
//
// Nothing here knows what a wallet is. That is the point — a sub-page composes
// these and holds the logic.

// ── Page shell ──────────────────────────────────────────────────────────────

// A settings page. `onBack` turns the title into a sub-page: no tab bar entry
// leads here, so the way out has to be on screen.
export function Page({
  title,
  subtitle,
  onBack,
  children,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  children: React.ReactNode;
}) {
  return (
    <SafeAreaView style={styles.page} edges={['top']}>
      <View style={styles.header}>
        {onBack ? (
          <Pressable
            onPress={onBack}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Back to settings"
            style={({ pressed }) => [styles.back, pressed && styles.backPressed]}>
            <Text style={styles.backText}>‹ Settings</Text>
          </Pressable>
        ) : null}
        <Text style={styles.headerTitle}>{title}</Text>
        {subtitle ? <Text style={styles.headerSub}>{subtitle}</Text> : null}
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollBody}
        keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Grouping ────────────────────────────────────────────────────────────────

// A titled group of rows. The overline sits OUTSIDE the card, which is what
// makes a long page skimmable: the eye runs down the labels in the gutter
// instead of reading into each card to find out what it is.
export function Group({
  title,
  footer,
  children,
  style,
}: {
  title?: string;
  footer?: string;
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  return (
    <View style={[styles.group, style]}>
      {title ? <Text style={styles.overline}>{title}</Text> : null}
      <View style={styles.card}>{children}</View>
      {footer ? <Text style={styles.groupFooter}>{footer}</Text> : null}
    </View>
  );
}

// ── Rows ────────────────────────────────────────────────────────────────────

// A tappable row: name on the left, value and chevron on the right. The whole
// row is the target, not the chevron — a 15px glyph is not a button.
export function NavRow({
  title,
  value,
  help,
  danger,
  onPress,
  first,
}: {
  title: string;
  value?: string;
  help?: string;
  danger?: boolean;
  onPress: () => void;
  first?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.row,
        !first && styles.rowSeparated,
        pressed && styles.rowPressed,
      ]}>
      <View style={styles.rowMain}>
        <Text style={[styles.rowTitle, danger && styles.rowTitleDanger]}>
          {title}
        </Text>
        {help ? <Text style={styles.rowHelp}>{help}</Text> : null}
      </View>
      {value ? (
        <Text style={styles.rowValue} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      <Text style={[styles.chevron, danger && styles.chevronDanger]}>›</Text>
    </Pressable>
  );
}

// A row that only reports something.
export function InfoRow({
  title,
  value,
  first,
  mono = true,
}: {
  title: string;
  value: string;
  first?: boolean;
  mono?: boolean;
}) {
  return (
    <View style={[styles.row, !first && styles.rowSeparated]}>
      <Text style={[styles.rowTitle, styles.infoTitle]}>{title}</Text>
      <Text
        style={[styles.rowValue, styles.infoValue, !mono && styles.rowValueSans]}
        numberOfLines={1}
        ellipsizeMode="middle">
        {value}
      </Text>
    </View>
  );
}

// A switch with its explanation. `busy` replaces the switch rather than sitting
// beside it, so the row does not change width while a request is in flight.
export function SwitchRow({
  title,
  help,
  value,
  onValueChange,
  busy,
  disabled,
  first,
  children,
}: {
  title: string;
  help?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  busy?: boolean;
  disabled?: boolean;
  first?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <View style={[styles.block, !first && styles.rowSeparated]}>
      <View style={styles.switchHead}>
        <Text style={styles.rowTitle}>{title}</Text>
        {busy ? (
          <ActivityIndicator color={colors.primary} />
        ) : (
          <Switch
            value={value}
            onValueChange={onValueChange}
            disabled={disabled}
            thumbColor={value ? colors.primary : '#8296a8'}
            trackColor={{ true: colors.primaryDim, false: colors.surfaceAlt }}
          />
        )}
      </View>
      {help ? <Text style={styles.help}>{help}</Text> : null}
      {children}
    </View>
  );
}

// A block inside a card for anything that is not a row: a chip group, an input,
// a paragraph and a button.
export function Block({
  title,
  help,
  first,
  children,
}: {
  title?: string;
  help?: string;
  first?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <View style={[styles.block, !first && styles.rowSeparated]}>
      {title ? <Text style={styles.blockTitle}>{title}</Text> : null}
      {help ? <Text style={styles.help}>{help}</Text> : null}
      {children}
    </View>
  );
}

export function Help({ children }: { children: React.ReactNode }) {
  return <Text style={styles.help}>{children}</Text>;
}

// ── Chips ───────────────────────────────────────────────────────────────────

// A single-choice set. Wraps, because five delays do not fit one phone row and
// a truncated chip leaves the user guessing which one they picked.
export function Chips<T>({
  options,
  selected,
  onSelect,
}: {
  options: { key: T; label: string }[];
  selected: T;
  onSelect: (key: T) => void;
}) {
  return (
    <View style={styles.chipRow}>
      {options.map((opt) => {
        const on = opt.key === selected;
        return (
          <Pressable
            key={String(opt.key)}
            onPress={() => onSelect(opt.key)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={opt.label}
            style={({ pressed }) => [
              styles.chip,
              on && styles.chipOn,
              pressed && styles.chipPressed,
            ]}>
            <Text style={[styles.chipText, on && styles.chipTextOn]}>
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── Buttons ─────────────────────────────────────────────────────────────────

type ButtonKind = 'primary' | 'secondary' | 'danger';

export function Button({
  label,
  onPress,
  kind = 'primary',
  busy,
  disabled,
  small,
  style,
}: {
  label: string;
  onPress: () => void;
  kind?: ButtonKind;
  busy?: boolean;
  disabled?: boolean;
  small?: boolean;
  style?: ViewStyle;
}) {
  const off = disabled || busy;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off }}
      style={({ pressed }) => [
        styles.btn,
        small && styles.btnSmall,
        kind === 'primary' && styles.btnPrimary,
        kind === 'secondary' && styles.btnSecondary,
        kind === 'danger' && styles.btnDanger,
        // Dimming rather than greying: a disabled button still has to read as
        // the same button, or the layout appears to change when it enables.
        off && styles.btnOff,
        pressed && styles.btnPressed,
        style,
      ]}>
      {busy ? (
        <ActivityIndicator
          color={kind === 'primary' ? colors.onPrimary : colors.primary}
        />
      ) : (
        <Text
          style={[
            small ? styles.btnTextSmall : styles.btnText,
            kind === 'primary' && styles.btnTextPrimary,
            kind === 'secondary' && styles.btnTextSecondary,
            kind === 'danger' && styles.btnTextDanger,
          ]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

// ── Input ───────────────────────────────────────────────────────────────────

// An input with its action beside it. One component because they are always
// used together here, and because the button's height has to match the field's
// — the thing that looked most unfinished about the old screen.
export function Field({
  action,
  onAction,
  actionBusy,
  actionDisabled,
  ...input
}: TextInputProps & {
  action: string;
  onAction: () => void;
  actionBusy?: boolean;
  actionDisabled?: boolean;
}) {
  return (
    <View style={styles.fieldRow}>
      <TextInput
        {...input}
        style={styles.input}
        placeholderTextColor={colors.faint}
      />
      <Button
        label={action}
        onPress={onAction}
        busy={actionBusy}
        disabled={actionDisabled}
        style={styles.fieldBtn}
      />
    </View>
  );
}

// ── Inline messages ─────────────────────────────────────────────────────────

// Tinted rather than bare coloured text. A sentence in red under a switch reads
// as part of the description; a tinted band reads as a thing that just happened.
/**
 * A multi-line input on its own line.
 *
 * `Field` puts its input in a row beside a button, which is right for one
 * short value and wrong for a twelve-word recovery phrase: the words wrap into
 * a column two or three characters wide. This is the same input styling with
 * the row and the button taken away, so the caller renders its own buttons
 * below.
 */
export function TextArea(props: TextInputProps) {
  return (
    <TextInput
      multiline
      textAlignVertical="top"
      {...props}
      style={styles.textArea}
      placeholderTextColor={colors.faint}
    />
  );
}

/**
 * A single-line value on its own line.
 *
 * `Field` puts its input in a row beside a button, which is wrong when two of
 * these stack (a password and its confirmation), and `TextArea` is multiline.
 *
 * NOT MASKED, and it used to be (`SecretInput`, with `secureTextEntry`). The
 * one thing typed into it is the backup password — a per-file password with no
 * checksum, typed once, not an account credential — and seeing it is the only
 * way to tell you are typing what you typed before. Masking it is also how
 * "I can't restore" happens when the file is perfectly good and the typing was
 * not, with nothing on screen able to say which. Autocorrect and capitalisation
 * stay off: both would alter the password silently.
 */
export function LineInput(props: TextInputProps) {
  return (
    <TextInput
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      {...props}
      style={styles.lineInput}
      placeholderTextColor={colors.faint}
    />
  );
}

export function Note({
  kind,
  children,
}: {
  kind: 'error' | 'ok' | 'info';
  children: React.ReactNode;
}) {
  return (
    <View
      style={[
        styles.note,
        kind === 'error' && styles.noteError,
        kind === 'ok' && styles.noteOk,
        kind === 'info' && styles.noteInfo,
      ]}>
      <Text
        style={[
          styles.noteText,
          kind === 'error' && styles.noteTextError,
          kind === 'ok' && styles.noteTextOk,
        ]}>
        {children}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  header: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.md,
  },
  back: { alignSelf: 'flex-start', paddingVertical: space.xs, marginBottom: 2 },
  backPressed: { opacity: 0.6 },
  backText: { ...type.button, color: colors.primary },
  headerTitle: { ...type.title, color: colors.text },
  headerSub: { ...type.help, color: colors.muted, marginTop: space.xs },
  scroll: { flex: 1 },
  scrollBody: {
    paddingHorizontal: space.lg,
    paddingBottom: space.xxl,
  },

  group: { marginBottom: space.xl },
  overline: {
    ...type.overline,
    color: colors.faint,
    marginBottom: space.sm,
    marginLeft: 2,
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  groupFooter: {
    ...type.caption,
    color: colors.faint,
    marginTop: space.sm,
    marginLeft: 2,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    // The gap is the fix for a label sitting flush against its value: a row is
    // two or three Texts side by side, and without it the only thing keeping
    // them apart was one child happening to have flex: 1. InfoRow had no such
    // child, so "Name" ran straight into the wallet's name. Declared once here
    // rather than as a margin on each child, so a new kind of row cannot
    // reintroduce it.
    gap: space.md,
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    // 56px of height at this padding: a comfortable target, and tall enough
    // that a list of them has rhythm rather than looking crammed.
    paddingVertical: space.md + 2,
    minHeight: 56,
  },
  rowSeparated: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  rowPressed: { backgroundColor: colors.surfaceAlt },
  rowMain: { flex: 1 },
  rowTitle: { ...type.rowTitle, color: colors.text },
  rowTitleDanger: { color: colors.danger },
  rowHelp: { ...type.caption, color: colors.faint, marginTop: 3 },
  rowValue: {
    ...type.value,
    color: colors.muted,
    // Shrinks rather than grows: in a NavRow the title block owns the space and
    // a long value gives way to it.
    flexShrink: 1,
    textAlign: 'right',
  },
  // An InfoRow is only a label and a value, so the value takes what is left and
  // sits against the right edge while the label keeps its full width.
  infoTitle: { flexShrink: 0 },
  infoValue: { flex: 1 },
  rowValueSans: { ...type.help, color: colors.muted },
  chevron: {
    fontFamily: fonts.sans,
    fontSize: 22,
    lineHeight: 24,
    color: colors.inactive,
  },
  chevronDanger: { color: colors.danger },

  block: { paddingHorizontal: space.lg, paddingVertical: space.lg },
  blockTitle: { ...type.rowTitle, color: colors.text, marginBottom: space.xs },
  switchHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 30,
  },
  help: { ...type.help, color: colors.muted, marginTop: space.sm },

  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    marginTop: space.md,
  },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.pill,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  chipOn: { borderColor: colors.primary, backgroundColor: colors.accentTint },
  chipPressed: { opacity: 0.7 },
  chipText: { ...type.buttonSmall, color: colors.muted },
  chipTextOn: { color: colors.primary },

  btn: {
    borderRadius: radius.sm,
    minHeight: 46,
    paddingHorizontal: space.xl,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  btnSmall: { minHeight: 38, paddingHorizontal: space.lg },
  btnPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  btnSecondary: {
    backgroundColor: 'transparent',
    borderColor: colors.borderHi,
  },
  btnDanger: { backgroundColor: colors.dangerTint, borderColor: colors.danger },
  btnOff: { opacity: 0.45 },
  btnPressed: { opacity: 0.8 },
  btnText: { ...type.button },
  btnTextSmall: { ...type.buttonSmall },
  btnTextPrimary: { color: colors.onPrimary },
  btnTextSecondary: { color: colors.text },
  btnTextDanger: { color: colors.danger },

  fieldRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: space.sm,
    marginTop: space.md,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: space.md,
    // Height comes from the button's minHeight via alignItems:'stretch', so the
    // two always line up whatever the font metrics do.
    paddingVertical: 10,
    fontFamily: type.value.fontFamily,
    fontSize: 15,
    color: colors.text,
  },
  fieldBtn: { paddingHorizontal: space.lg },

  lineInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    marginTop: space.md,
    fontFamily: type.value.fontFamily,
    fontSize: 15,
    // Stated, not inherited — see textArea below.
    color: colors.text,
  },

  textArea: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    marginTop: space.md,
    minHeight: 76,
    fontFamily: type.value.fontFamily,
    fontSize: 15,
    // Stated rather than inherited. A TextInput, like a <button>, does not take
    // the surrounding text colour on every platform, and the failure is a field
    // whose text is invisible against the surface — the same shape as the
    // wallet card's unreadable balance tabs recorded in CLAUDE.md.
    color: colors.text,
  },

  note: {
    borderRadius: radius.sm,
    borderLeftWidth: 3,
    paddingVertical: 10,
    paddingHorizontal: space.md,
    marginTop: space.md,
  },
  noteError: {
    backgroundColor: colors.dangerTint,
    borderLeftColor: colors.danger,
  },
  noteOk: { backgroundColor: colors.greenTint, borderLeftColor: colors.green },
  noteInfo: {
    backgroundColor: colors.surfaceAlt,
    borderLeftColor: colors.borderHi,
  },
  noteText: { ...type.help, color: colors.strong },
  noteTextError: { color: colors.danger },
  noteTextOk: { color: colors.green },
});
