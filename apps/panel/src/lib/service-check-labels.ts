/** The service check's fixed list, key to label, as the backend has it
 * (apps/backend/src/modules/client-attempts/service-check-targets.ts,
 * current and previous lists). A report's own results carry only the
 * key; this is what staff read for it. service-check-labels.test.ts fails
 * when the backend list has a key this map does not. */
export const SERVICE_CHECK_LABELS: Readonly<Record<string, string>> = {
  instagram: "Instagram",
  instagram_app: "Instagram app API",
  whatsapp: "WhatsApp Web",
  whatsapp_media: "WhatsApp media",
  telegram: "Telegram Web",
  google: "Google",
  youtube: "YouTube",
  x: "X",
  control: "Control (Cloudflare)",
};

/** The label for a service key; the key itself only when it is on
 * neither list. */
export function serviceCheckLabel(key: string): string {
  return Object.prototype.hasOwnProperty.call(SERVICE_CHECK_LABELS, key) ? SERVICE_CHECK_LABELS[key] : key;
}
