// What a failed device-check MEANS — the one rule, shared by both clients.
//
// Reported 2026-11-08: *"lnbits instance is down — when opening mobile app it
// prompts for confirmation code for the device check"*.
//
// It did, and the device was fine. Both clients folded every `device-check`
// failure into "untrusted", and untrusted lands on the enrollment flow: a
// screen whose only action is to have the server EMAIL a six-digit code. When
// the server is what failed, that is a dead end wearing a security prompt, and
// it tells somebody something untrue about their own phone on the launch path.
//
// The distinction is cheap and the consequences are not, so it lives in one
// file that both clients import rather than as the same expression written
// twice. `authStore.ts` uses it on login and on restore; `LoginView.vue` uses
// it after sign-in.
//
// NOTHING HERE WIDENS ACCESS. "Unreachable" is not "trusted": the wallet stays
// behind the same gate, and every siLNt endpoint hangs off
// require_trusted_device server-side regardless of what any client believes.
// What changes is which screen is shown and what it says.

/**
 * Could the check have produced a verdict at all?
 *
 * NO STATUS is api.ts's network-failure error — DNS, refused connection, a
 * dead proxy, aeroplane mode. The request never reached anything that knows
 * what this device is.
 *
 * 5xx is the server answering "I am broken" rather than answering the
 * question. An LNbits that is up enough to 502 through its proxy has still not
 * said anything about this device.
 *
 * EVERYTHING ELSE IS A VERDICT, and is treated as one. A 403 from
 * require_trusted_device means exactly what it says — this device is not
 * trusted — and must keep landing on enrollment, which is the whole point of
 * the gate. A 401 is the caller's keys being dead, which `restore` handles
 * separately and ahead of this.
 */
export function checkWasImpossible(err: unknown): boolean {
  const status = (err as { status?: number } | null | undefined)?.status;
  return !status || status >= 500;
}

export type DeviceVerdict = 'trusted' | 'untrusted' | 'unreachable';

/**
 * The verdict from a thrown error, for the two call sites that have one.
 *
 * Deliberately NOT given the success case to fold in as well: a client that
 * got an answer should read `status === 'trusted'` itself, where it is
 * obvious, rather than passing a response through a helper whose name is about
 * failure.
 */
export function verdictFromError(err: unknown): DeviceVerdict {
  return checkWasImpossible(err) ? 'unreachable' : 'untrusted';
}
