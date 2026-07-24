/** Plain, minimal email bodies -- no branded HTML template system exists
 * yet, and building one is disproportionate to this milestone. Each
 * template returns both an html and a text body (nodemailer sends both;
 * mail clients prefer html, text is the fallback). */

function wrap(bodyHtml: string): string {
  return `<div style="font-family: sans-serif; font-size: 14px; line-height: 1.6; color: #1a1a1a;">${bodyHtml}</div>`;
}

export function welcomeEmail() {
  return {
    subject: "Welcome to NeoConnect",
    html: wrap(`<p>Your NeoConnect account has been created.</p>
<p>Check your inbox for a separate verification email -- you'll need to confirm your address before you can connect to the VPN.</p>`),
    text: "Your NeoConnect account has been created. Check your inbox for a separate verification email -- you'll need to confirm your address before you can connect to the VPN.",
  };
}

export function verificationEmail(token: string) {
  return {
    subject: "Verify your NeoConnect email address",
    html: wrap(`<p>Confirm your email address to activate your NeoConnect account.</p>
<p>Open the NeoConnect app and enter this verification code, or use the link below if you're on a device with the app installed:</p>
<p style="font-size: 20px; font-weight: bold; letter-spacing: 2px;">${token}</p>
<p><a href="neoconnect://verify-email?token=${encodeURIComponent(token)}">neoconnect://verify-email?token=${encodeURIComponent(token)}</a></p>
<p>This link expires in 24 hours.</p>`),
    text: `Confirm your email address to activate your NeoConnect account. Verification code: ${token} (expires in 24 hours). Or open: neoconnect://verify-email?token=${encodeURIComponent(token)}`,
  };
}

export function passwordResetEmail(token: string) {
  return {
    subject: "Reset your NeoConnect password",
    html: wrap(`<p>A password reset was requested for your NeoConnect account.</p>
<p>If this was you, enter this code in the app, or use the link below:</p>
<p style="font-size: 20px; font-weight: bold; letter-spacing: 2px;">${token}</p>
<p><a href="neoconnect://reset-password?token=${encodeURIComponent(token)}">neoconnect://reset-password?token=${encodeURIComponent(token)}</a></p>
<p>This link expires in 30 minutes. If you didn't request this, you can safely ignore this email.</p>`),
    text: `A password reset was requested for your NeoConnect account. Code: ${token} (expires in 30 minutes). Or open: neoconnect://reset-password?token=${encodeURIComponent(token)}. If you didn't request this, ignore this email.`,
  };
}

export function lowDataWarningEmail(remainingGb: number) {
  return {
    subject: "Your NeoConnect data is running low",
    html: wrap(`<p>You have about <strong>${remainingGb.toFixed(1)} GB</strong> of data remaining on your current plan.</p>
<p>Once your data cap is reached, your VPN connection will be paused until you renew or upgrade.</p>`),
    text: `You have about ${remainingGb.toFixed(1)} GB of data remaining on your current plan. Once your data cap is reached, your VPN connection will be paused until you renew or upgrade.`,
  };
}

export function expiringSoonEmail(daysRemaining: number) {
  return {
    subject: "Your NeoConnect subscription is expiring soon",
    html: wrap(`<p>Your subscription expires in about <strong>${daysRemaining} day${daysRemaining === 1 ? "" : "s"}</strong>.</p>
<p>Renew before it expires to keep your VPN connection active without interruption.</p>`),
    text: `Your subscription expires in about ${daysRemaining} day(s). Renew before it expires to keep your VPN connection active without interruption.`,
  };
}
