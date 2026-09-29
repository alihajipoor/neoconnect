import { cn } from "../lib/utils";

/** The marks the brands themselves publish, drawn inline.
 *
 * lucide dropped its brand icons over trademark concerns, which left
 * the community row standing a globe, a speech bubble, a camera and a
 * paper plane in for four named products. Four generic glyphs beside
 * four brand names reads as unfinished, and the row is the one place
 * the app points at things outside itself.
 *
 * Inline rather than an icon package: five glyphs do not justify a
 * dependency, and lucide is already here for everything that is not a
 * brand. Path data as each brand distributes it (via simple-icons,
 * which tracks their own guidelines) -- these are trademarks, so they
 * are copied rather than redrawn.
 *
 * Nothing here sets a colour. `fill="currentColor"` is the whole point:
 * a mark picks up the hover, focus and muted treatment of whatever it
 * sits in, exactly as the lucide icon it replaced did, so the row needed
 * no styling changes at all.
 */

/** The shared shell.
 *
 * lucide draws inside a 2px margin of its 24-unit box; a brand path
 * uses the whole box. Dropped in at the same nominal size the Discord
 * blob sat visibly larger and heavier than the globe beside it, so the
 * transform maps 0..24 onto 2..22 to put both on one optical grid.
 * A filled mark still carries more weight than a 2px stroke -- that is
 * inherent to the marks and not something to "fix" by redrawing them.
 */
function BrandMark({ path, className }: { path: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={cn("size-4 shrink-0", className)}
    >
      <g transform="translate(2 2) scale(0.83333)">
        <path d={path} />
      </g>
    </svg>
  );
}

const DISCORD =
  "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z";

const INSTAGRAM =
  "M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077";

const TELEGRAM =
  "M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z";

export function DiscordIcon({ className }: { className?: string }) {
  return <BrandMark path={DISCORD} className={className} />;
}

export function InstagramIcon({ className }: { className?: string }) {
  return <BrandMark path={INSTAGRAM} className={className} />;
}

export function TelegramIcon({ className }: { className?: string }) {
  return <BrandMark path={TELEGRAM} className={className} />;
}

/* --- Sign-in providers ---------------------------------------------
   Apple and Google both publish binding rules for these marks, and a
   wrong or recoloured one is a review finding rather than a matter of
   taste. Apple's logo may be solid white or solid black and nothing
   else, which suits `currentColor`. Google's may not be recoloured at
   all -- their four brand colours are the mark -- so it is the one icon
   here that ignores currentColor and carries its own fills. */

const APPLE =
  "M17.05 12.536c-.024-2.69 2.196-3.98 2.296-4.043-1.25-1.83-3.194-2.08-3.885-2.108-1.654-.168-3.23.974-4.07.974-.84 0-2.133-.95-3.508-.924-1.805.027-3.47 1.05-4.397 2.665-1.874 3.25-.479 8.062 1.35 10.7.893 1.29 1.958 2.74 3.355 2.688 1.346-.055 1.855-.87 3.483-.87 1.628 0 2.086.87 3.51.843 1.45-.026 2.368-1.315 3.255-2.61 1.026-1.497 1.448-2.946 1.472-3.02-.032-.014-2.825-1.084-2.854-4.295M14.39 4.59c.743-.9 1.244-2.152 1.107-3.4-1.07.044-2.367.713-3.135 1.612-.688.797-1.29 2.07-1.128 3.292 1.194.093 2.413-.607 3.156-1.504";

export function AppleIcon({ className }: { className?: string }) {
  return <BrandMark path={APPLE} className={className} />;
}

export function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M23.52 12.273c0-.851-.076-1.67-.218-2.455H12v4.642h6.458a5.52 5.52 0 0 1-2.396 3.622v3.01h3.878c2.269-2.089 3.58-5.165 3.58-8.819"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.956-1.075 7.94-2.908l-3.877-3.01c-1.075.72-2.45 1.145-4.063 1.145-3.126 0-5.772-2.111-6.716-4.948H1.276v3.109A11.995 11.995 0 0 0 12 24"
      />
      <path
        fill="#FBBC05"
        d="M5.284 14.279A7.212 7.212 0 0 1 4.909 12c0-.791.136-1.56.375-2.279V6.612H1.276A11.995 11.995 0 0 0 0 12c0 1.937.464 3.769 1.276 5.388l4.008-3.109Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.773c1.762 0 3.344.605 4.587 1.794l3.442-3.442C17.951 1.19 15.235 0 12 0 7.31 0 3.255 2.689 1.276 6.612l4.008 3.109C6.228 6.884 8.874 4.773 12 4.773"
      />
    </svg>
  );
}

const FACEBOOK =
  "M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073";

export function FacebookIcon({ className }: { className?: string }) {
  return <BrandMark path={FACEBOOK} className={className} />;
}
