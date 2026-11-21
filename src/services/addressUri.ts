// Turning whatever was scanned or pasted into a bare address.
//
// A QR code is rarely just an address. Wallets encode BIP-21 URIs
// (`bitcoin:bc1…?amount=…`), and Silent Payments ride in as an `sp=` parameter
// on one (`tsp=` on signet — BIP-321 keys a bech32 instruction by its HRP). Clipboards are worse: text picked up from a web page or a chat app
// routinely carries leading whitespace or a trailing newline, which a bech32
// decoder rejects with an unhelpful "invalid address".
//
// So both send flows and both apps run their input through here rather than
// each keeping its own idea of what a scan looks like.

export function parseScannedAddress(raw: string): string {
  const s = (raw || '').trim();
  // An sp= parameter wins: a URI carrying one is offering the Silent Payments
  // address as the better destination, with the on-chain one as the fallback.
  const m = s.match(/[?&]t?sp=([^&]+)/i);
  if (m) {
    try {
      return decodeURIComponent(m[1]).trim();
    } catch {
      return m[1].trim();
    }
  }
  // Otherwise strip the scheme and anything after it — amount, label, message.
  return s
    .replace(/^bitcoin:/i, '')
    .split('?')[0]
    .trim();
}
