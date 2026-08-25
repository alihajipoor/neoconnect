import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { load, type Store } from "@tauri-apps/plugin-store";
import { publicRequest } from "./api";

/** Supported interface languages.
 *
 * Persian is here because a large share of this product's users are in
 * Iran, where an English-only VPN client is a real barrier rather than a
 * nicety. `dir` travels with the language so a future addition (Arabic,
 * Kurdish) only has to declare itself rather than have direction inferred
 * somewhere else. */
export const LANGUAGES = {
  en: { label: "English", nativeLabel: "English", dir: "ltr" },
  fa: { label: "Persian", nativeLabel: "فارسی", dir: "rtl" },
} as const;

export type Language = keyof typeof LANGUAGES;

/** Every string the interface shows.
 *
 * A plain typed dictionary rather than an i18n library: this app has a
 * handful of screens, and TypeScript makes a missing Persian key a build
 * error, which is the main thing a library would otherwise buy. Adding
 * one costs a dependency and a runtime; this costs a line.
 */
const en = {
  "app.tagline": "Private, fast, yours.",
  "auth.signInToConnect": "Sign in to connect.",
  "auth.noCardRequired": "No credit card required to get started.",
  "verify.noCode": "Didn't get a code? Resend it",
  "loc.title": "Choose location",
  "loc.disconnectFirst": "Disconnect first to switch servers",
  // Shown when nothing is connected, where the line above would be
  // false: it told customers to disconnect while they already were.
  "loc.pickHint": "Pick a server and protocol",
  "loc.retry": "Retry",

  "nav.settings": "Settings",
  "nav.signOut": "Sign out",
  "nav.back": "Back",

  "auth.welcomeBack": "Welcome back",
  "auth.signIn": "Sign in",
  "auth.signingIn": "Signing in...",
  "auth.email": "Email",
  "auth.password": "Password",
  "auth.createAccount": "Create account",
  "auth.noAccount": "Don't have an account?",
  "auth.haveAccount": "Already have an account?",
  "auth.register": "Register",
  "auth.registering": "Creating...",

  "forgot.link": "Forgot your password?",
  "forgot.title": "Reset your password",
  "forgot.subtitle": "We'll email you a code to set a new one.",
  "forgot.sendCode": "Send me a code",
  "forgot.sending": "Sending...",
  "forgot.sent": "If that address is registered, a code is on its way. It expires in 30 minutes.",
  "forgot.code": "Code from the email",
  "forgot.newPassword": "New password",
  "forgot.confirmPassword": "Confirm new password",
  "forgot.submit": "Set new password",
  "forgot.submitting": "Saving...",
  "forgot.done": "Password changed. You can sign in now.",
  "forgot.backToSignIn": "Back to sign in",
  "forgot.tooShort": "At least 8 characters.",
  "forgot.mismatch": "These don't match.",

  "verify.title": "Check your email",
  "verify.sentTo": "We sent a code to {email}",
  "verify.code": "Verification code",
  "verify.confirm": "Confirm",
  "verify.confirming": "Confirming...",
  "verify.resend": "Send it again",
  "verify.sending": "Sending...",

  "dash.connect": "Connect",
  "dash.connecting": "Connecting...",
  "dash.disconnect": "Disconnect",
  "dash.disconnecting": "Disconnecting...",
  "dash.connected": "Connected",
  "dash.disconnected": "Not connected",
  "dash.dataUsed": "Data used",
  "dash.expires": "Expires",
  "dash.location": "Location",
  "dash.viewPlans": "View plans",
  "dash.noSubscription": "No active subscription",
  "dash.noPlanHint": "Choose a plan to start using Neoxify.",
  // Store builds only. They may not sell, and may not point at where to
  // buy either, so this cannot be a call to action. What it can do is
  // leave the customer knowing where they stand and that nothing is
  // broken -- which is the whole difference between an empty state and
  // a dead end.
  "dash.outOfData": "You've used all your data",
  "dash.planExpired": "Your plan has expired",
  "dash.renewHint": "Renew or change your plan to keep connecting.",
  // Deliberately names no website and offers no link. Both stores treat
  // steering a customer to an outside payment as their business, and the
  // customer already knows where they bought it -- what they need is to
  // be told that is where to go, and that it will show up here after.
  "dash.renewStore":
    "This plan is managed wherever you bought it. Sign in to your account there to renew -- once you have, it appears here again.",
  "dash.renewCta": "Renew plan",
  "dash.noPlanStore": "Your account is ready. As soon as a plan is added to it, it appears here and you can connect.",

  "plans.title": "Choose a plan",
  "plans.subtitle": "Pick a plan to start connecting.",
  "plans.crypto": "Crypto",
  "plans.card": "Card",
  "plans.loading": "Loading plans...",
  "plans.none": "No plans are available right now. Please check back shortly.",
  "plans.waiting": "Waiting for payment",

  "auth.referralCode": "Referral code (optional)",
  "auth.referralCodeHint": "From a friend who invited you",
  "update.downloading": "Downloading Neoxify {version}...",
  "update.downloadingPercent": "Downloading Neoxify {version} — {percent}%",
  "update.ready": "Neoxify {version} is ready to install.",
  "update.restart": "Restart now",
  "update.restarting": "Restarting...",
  "update.connectedFirst": "Disconnect before updating.",
  "dash.customModeDetached": "Connected, but Custom mode could not attach — your selected apps are going out unprotected.",
  "dash.unlimited": "Unlimited",
  "support.title": "Support",
  "support.subtitle": "Ask us anything — we answer as soon as we can.",
  "support.new": "New message",
  "support.newTitle": "What can we help with?",
  "support.subject": "Subject",
  "support.subjectHint": "A few words, e.g. \"Can't connect on Stealth\"",
  "support.message": "Message",
  "support.messageHint": "Tell us what happened, and what you already tried.",
  "support.send": "Send",
  "support.sending": "Sending...",
  "support.reply": "Write a reply",
  "support.replyWithin": "We usually reply within {hours} hours.",
  "support.replyWithinDay": "We usually reply within a day.",
  "support.closed": "Support is closed to new messages right now. Please check back later.",
  "support.closedTitle": "Not taking new messages",
  "support.empty": "No conversations yet.",
  "support.emptyHint": "Start one and it will appear here.",
  "support.you": "You",
  "support.team": "Support",
  "support.statusOpen": "Waiting for a reply",
  "support.statusAnswered": "Replied",
  "support.statusResolved": "Resolved",
  "support.unread": "New reply",
  "support.notLive": "This is not a live chat — you can close the app, and your reply will be here (and in your email) when it arrives.",
  "referrals.title": "Invite friends",
  "referrals.subtitle": "Share your code and earn free Neoxify time.",
  "referrals.off": "The referral programme isn't running at the moment. Check back soon.",
  "referrals.yourCode": "Your referral code",
  "referrals.rule": "Get {days} free days when one friend pays for {months} months, or {friends} friends pay for {each} each.",
  "referrals.copy": "Copy",
  "referrals.copied": "Copied",
  "referrals.progress": "Next free month",
  "referrals.monthsToGo": "{count} paid months to go",
  "referrals.almost": "Ready on the next check",
  "referrals.progressHint": "Best friend so far: {best} paid months. Friends who qualify: {qualifying}.",
  "referrals.friends": "Friends you invited",
  "referrals.friendsHint": "Shown partly hidden — their address stays private.",
  "referrals.noFriends": "Nobody yet. Share your code to get started.",
  "referrals.joined": "Joined",
  "referrals.pending": "Not activated",
  "referrals.paidMonths": "{count} paid months",
  "referrals.earned": "Free time you've earned",
  "referrals.freeDays": "{days} free days",
  "nav.referrals": "Invite friends",
  "settings.title": "Settings",
  "settings.subtitle": "Manage your account.",
  "settings.language": "Language",
  "settings.languageHint": "The app restarts nothing — the change is instant.",
  "settings.deleteAccount": "Delete account",
  "settings.deleteAccountHint": "Permanently remove your account and everything on it.",
  "settings.deleteWarning": "This cannot be undone. Your account, your connection credentials on every server, and any time remaining on your plan are all removed immediately. Invoices are kept for tax purposes with your personal details stripped out.",
  "settings.deleteTypeToConfirm": "Type {word} to confirm",
  "settings.deleteConfirmWord": "DELETE",
  "settings.deleteConfirm": "Delete permanently",
  "settings.deleteCancel": "Keep my account",
  "settings.deleting": "Deleting...",
  "settings.changePassword": "Change password",
  "settings.changePasswordHint": "You'll stay signed in on this device.",
  "settings.currentPassword": "Current password",
  "settings.newPassword": "New password",
  "settings.confirmPassword": "Confirm new password",
  "settings.passwordChanged": "Password changed. Any other devices have been signed out.",
  "settings.changing": "Changing...",
  "settings.tooShort": "At least 8 characters.",
  "dash.customActive":
    "Custom mode: only your chosen apps are going through the VPN. Their IPv6 is blocked rather than sent outside it, so an IPv6-only site will not open for them.",
  // The full-tunnel counterpart of the line above, and deliberately the
  // same shape of sentence: what is blocked, why, and what the customer
  // will notice. It is shown whenever the service reports a block is
  // actually installed -- never inferred from the protocol -- because
  // this is a promise about the machine's state and the app does not
  // make those without evidence.
  "dash.fullTunnelIpv6Blocked":
    "IPv6 is blocked while you're connected. Neoxify's servers carry IPv4 only, so IPv6 is stopped here rather than sent out around the VPN. An IPv6-only site won't open until you disconnect.",
  // Shown when the app's own check finds IPv6 still reaching the
  // internet while connected. That is the leak this release exists to
  // close, so the wording says "not protected" without hedging: the
  // customer's IPv4 may well be tunnelled, and their IPv6 is not.
  "dash.ipv6Escaping":
    "Some of your traffic is leaving over IPv6, outside the VPN. Your IPv6 address is visible to your network. Disconnect and reconnect; if it keeps happening, tell support.",
  "voucher.title": "Have a voucher?",
  "voucher.subtitle": "Enter a code to activate a plan without paying.",
  "voucher.placeholder": "Enter your code",
  "voucher.check": "Check",
  "voucher.valid": "This code is valid",
  "voucher.days": "days",
  "voucher.confirm": "Activate this plan",
  "voucher.cancel": "Cancel",
  "settings.general": "General",
  "settings.account": "Account",
  "settings.sections": "Sections",
  "settings.custom": "Custom mode",
  "settings.customBeta": "Beta",
  "settings.customHint": "Choose which apps use the VPN and which keep your normal connection. Still new — tell us if something looks wrong.",
  "settings.customOn": "On",
  "settings.customOff": "Off",
  "settings.customAddApp": "Add an app",
  "settings.customNoApps": "No apps chosen yet, so nothing is being routed. Add one to start.",
  "settings.customRemove": "Remove",
  "settings.customApplies": "Applies from your next connection.",
  "settings.customFailOpen": "While the app is switching servers, chosen apps briefly use your normal connection instead of stalling.",
  "settings.customTooMany": "You can choose up to {max} apps.",
  "settings.customAlready": "That app is already on the list.",
  "settings.customModeOnly": "Only these apps",
  "settings.customModeExcept": "All except these",
  "settings.customModeOnlyHint": "Only the apps you choose go through the VPN. Everything else uses your normal connection.",
  "settings.customModeExceptHint": "Everything goes through the VPN except the apps you choose.",
  "settings.customNoAppsExcept": "No apps chosen yet, so everything is going through the VPN. Add one to leave it out.",
  "settings.customPickRunning": "Choose from running apps",
  "settings.customPickFile": "Browse for a program",
  "settings.customRunningTitle": "Running apps",
  "settings.customRunningEmpty": "Nothing to show. Try browsing for the program instead.",
  "settings.customSearchEmpty": "No app matches that.",
  "settings.customAppParts": "{count} programs, all routed together",
  "settings.customRunningRefresh": "Refresh",
  "settings.customCancel": "Cancel",
  "settings.customAppUsesVpn": "Uses VPN",
  "settings.customAppBypasses": "Bypasses VPN",
  // Android picks from the installed-app list rather than a file
  // dialog, so these have no Windows counterpart.
  //
  // customAllApps is not a translation of customNoApps -- it is the
  // opposite fact. On Windows, on-with-nothing-chosen routes nothing;
  // on Android an empty allow-list would route nothing at all, so the
  // app falls back to a full tunnel instead. Same toggle state, opposite
  // consequence, and telling somebody the wrong one is worse than saying
  // nothing.
  // Android only: this build carries one engine, and a customer who
  // picked another protocol deserves the reason rather than a silent
  // substitution.
  // Shown when the control plane could not be reached and the screen is
  // running on the cached snapshot. Names the age of the data, because
  // the alternative is presenting a stale usage total as today's.
  "dash.offlineTitle": "Can't reach Neoxify right now — you can still connect.",
  "dash.offlineHint":
    "Using your saved servers. Data usage and expiry were last updated {when} and may be out of date.",
  "dash.androidWireguardOnly":
    "{protocol} isn't in the Android app yet, so it will connect with Fast instead.",
  "settings.customAllApps": "No apps chosen yet, so every app uses the VPN. Pick one to route just that app.",
  "settings.customHintNative": "Send only the apps you choose through the VPN. Everything else uses your normal connection.",
  "settings.customSearch": "Search apps",
  "settings.customNoMatches": "No apps match that.",
  "settings.customClear": "Clear selection",
  "settings.mismatch": "These don't match.",

  "dash.subscription": "Subscription",
  "dash.retry": "Retry",
  "dash.loadFailed": "Could not load your account.",
  "dash.changeLocation": "Change location",
  "dash.status.active": "ACTIVE",
  "dash.server": "Server",
  "dash.protocol": "Protocol",
  "dash.session": "Session",
  "dash.daysLeft": "days left",
  "dash.change": "Change",
  "dash.disconnectToChange": "Disconnect first to change server or protocol",
  "dash.protected": "You're protected",
  "dash.protectedHint": "Your traffic is encrypted and routed through Neoxify.",
  "dash.notProtected": "You're not protected",
  "dash.notProtectedHint": "Connect to encrypt your traffic and hide your IP.",
  "dash.degraded": "Not carrying traffic",
  "dash.degradedHint": "The tunnel is up but the server isn't responding. Your traffic is NOT protected. Try reconnecting or pick another server.",
  // The third answer, and the one the screen had no words for.
  //
  // For Xray, OpenVPN and IKEv2 the helper service reports "unknown"
  // health for as long as the engine process is alive, which is a
  // condition that holds whether or not a single packet is moving. The
  // app used to render that as "You're protected". It is not the
  // opposite either -- nothing came back negative -- and saying "you're
  // not protected" to someone whose tunnel is fine is the mistake that
  // gets a customer in Iran to disconnect and expose themselves.
  //
  // So the copy states exactly what is and is not known, and the
  // suggested action is reconnecting rather than anything alarming.
  "dash.unverified": "Connected, not confirmed",
  // The orb's own label, which has room for two or three words.
  "dash.unverifiedShort": "Not confirmed",
  "dash.unverifiedHint":
    "The tunnel is up and nothing says it's broken — but Neoxify hasn't been able to confirm your traffic is going through it. Reconnect if you need to be sure.",
  // Custom mode is a narrower claim and gets a narrower sentence: the
  // question there is not whether this machine is tunnelled but whether
  // the apps you chose are, and those are genuinely different facts.
  "dash.unverifiedCustomHint":
    "Custom mode is running and the tunnel is up, but Neoxify couldn't confirm your chosen apps' traffic is reaching the server. Reconnect if you need to be sure.",
  "dash.verifying": "Checking connection...",
  "dash.verifyingHint": "Setting up your tunnel — trying each protocol until one works. Click to stop.",
  // Said when the helper service cannot be reached, which is a different
  // thing from the tunnel being down and must not borrow its words. The
  // screen used to answer this case with "You're not protected", over a
  // tunnel that was live -- someone who believes that goes and does
  // something they would not have done otherwise.
  "dash.unknown": "Can't tell right now",
  "dash.unknownHint":
    "The Neoxify service isn't answering, so the app can't say whether you're protected. It keeps asking — until it answers, don't assume either way.",
  "dash.recheck": "Check status",
  "dash.switchedTo": "Your usual protocol didn't get through. Now using",
  // Used instead of the line above when failover crossed to a different
  // country. Naming only the protocol was accurate and still misleading:
  // a customer who chose Singapore deliberately was told "now using
  // Fast" and had to notice the server field to learn they were in
  // France. Whoever picked a country picked it for a reason.
  "dash.switchedServer": "Couldn't reach {from}. Now on {to} over {protocol}",
  // The same mismatch, without the accusation. Used when the server on
  // screen was never dialled -- nothing was pinned, so the ladder took
  // the fastest route, which was somewhere else. Saying "couldn't
  // reach" here blames a server that was never asked, and points the
  // customer at a problem that does not exist; it also buries the one
  // thing they can act on, which is that pinning a choice makes it stick.
  "dash.usedInstead": "Used {to} over {protocol}, not {from}. Pick a server to stay on it.",
  "dash.yourIp": "Your IP:",
  "err.serviceUnavailable": "The Neoxify background service isn't running. Restarting the app usually fixes this; reinstalling will if it doesn't.",
  "err.engineMissing": "Part of the installation is missing. Please reinstall Neoxify.",
  "err.serverUnreachable": "Couldn't reach this server. Your network may be blocking it — try another location.",
  "err.notCarryingTraffic": "Connected, but no traffic got through.",
  "err.allProtocolsFailed": "Tried every available protocol — none of them carried traffic.",
  "err.concurrentLimit": "Your plan's device limit is already in use. Disconnect another device and try again.",
  "err.quotaExhausted": "You've used all the data on your plan. Upgrade or wait for it to renew.",
  "err.subscriptionInactive": "Your subscription isn't active right now. Check its status on the dashboard.",
  "err.teardownStuck":
    "The tunnel is still shutting down. If your internet stays down, close and reopen the app.",
  // Said out loud rather than left as a dead button. This press started
  // nothing, and it deliberately names no server -- nothing was dialled,
  // so there is nothing to report about one.
  "err.connectBusy": "A connection attempt is already running. Give it a moment, then try again.",
  "err.unknown": "Couldn't connect.",
  "err.showDetail": "Technical details",

  // "Repair my network".
  //
  // Worded for somebody whose internet is already broken and who is
  // reading this on a phone next to a laptop that will not load
  // anything. Every sentence says what will happen rather than what the
  // feature is called: the promise is made before the button is pressed,
  // and the result afterwards names what was actually found -- never a
  // blanket "done", because the app does not report a state it has not
  // checked.
  "settings.repair": "Repair network",
  "repair.title": "Repair my network",
  "repair.subtitle": "Remove anything Neoxify has left behind on Windows.",
  "repair.explain":
    "Neoxify looks for, and removes: VPN engines left running, the DNS rule it sets while you're connected, routes on its own network adapters, its firewall rule, a leftover WireGuard tunnel service, and its entry in Windows' VPN list. Then it clears the DNS cache.",
  "repair.disconnects": "If you're connected, this disconnects you first.",
  // The fail-open promise, said out loud. Somebody in Iran deciding
  // whether to press a button labelled "repair" on the machine they use
  // to get online deserves to know it cannot lock anything down.
  "repair.safety":
    "It only removes things. It never blocks traffic, and it doesn't touch your normal internet settings.",
  "repair.run": "Repair now",
  "repair.running": "Repairing...",
  "repair.runAgain": "Repair again",
  "repair.resultClean": "Nothing was left behind — your network settings are as Windows had them.",
  "repair.resultFixed": "Repaired. Try connecting again.",
  // Good news with a caveat, not bad news. Every check that finished
  // succeeded; one could not finish, which says nothing either way.
  // Worded so it never claims the repair failed -- that is a state
  // nothing here verified. See `indeterminateSteps` in lib/repair.ts.
  "repair.resultUnverified":
    "Repaired, but one check couldn't finish, so it can't be confirmed. This usually just means a slow machine. Try connecting again; if it still doesn't work, run the command below as an administrator and send us what it prints.",
  "repair.resultProblems":
    "Some of it could not be repaired. Restarting Windows usually clears the rest; if it doesn't, run the command below as an administrator and send us what it prints.",
  "repair.failed": "The repair could not be run.",
  "repair.stepClean": "Nothing found",
  "repair.stepFixed": "Removed",
  "repair.stepFailed": "Still there",
  "repair.stepUnknown": "Couldn't check",
  "repair.step.tunnel": "Tunnel and Custom mode",
  "repair.step.engines": "Leftover VPN engines",
  "repair.step.dns": "Tunnel DNS rule",
  "repair.step.routes": "Routes on Neoxify adapters",
  "repair.step.firewall": "Custom mode firewall rule",
  "repair.step.wfp": "Windows traffic filters",
  "repair.step.wireguardService": "Leftover WireGuard tunnel service",
  "repair.step.ras": "Neoxify in Windows' VPN list",
  "repair.step.dnsCache": "DNS cache",
  // The case this button cannot serve, and the one that matters most:
  // the service being unreachable is exactly when a machine needs
  // repairing. So it hands over the command instead of failing quietly.
  "repair.noService": "The Neoxify service isn't answering, so the app can't repair anything for you.",
  "repair.noServiceHint":
    "Open Start, type cmd, right-click Command Prompt and choose \"Run as administrator\". Then run this:",
  "repair.copyCommand": "Copy command",
  "repair.copied": "Copied",
  // Offered in the connect-failure path, where somebody who cannot
  // connect is already looking, rather than only in a settings screen
  // they would have to think to open.
  "repair.inlineCta": "Still not connecting? Repair my network",

  // The diagnostics snapshot, in Support.
  "diag.title": "Send us your details",
  "diag.subtitle":
    "A short summary of what Neoxify has on this computer. Copy it into your message and we can see what you see.",
  "diag.collect": "Collect details",
  "diag.collecting": "Collecting...",
  "diag.copy": "Copy",
  "diag.copied": "Copied",
  // Said plainly, because a customer in Iran being asked to paste
  // something about their machine into a chat is right to want to know
  // what is in it.
  "diag.privacy":
    "No passwords, keys, server details or anything about which sites you visit. You can read all of it before you send it.",
  "diag.failed": "The Neoxify service isn't answering, so there's nothing to collect.",

  "plans.back": "Back",
  "plans.perDays": "for {days} days",
  "plans.data": "Data",
  "plans.speed": "Speed",
  "plans.devices": "Devices",
  "plans.unlimited": "Unlimited",
  "plans.upTo": "Up to {n} Mbps",
  "plans.devicesAtOnce": "{n} at once",
  "plans.bestValue": "Best value",
  "plans.payWith": "Pay with",
  "plans.amount": "Amount",
  "plans.toAddress": "To this address",
  "plans.openCheckout": "Open checkout",
  "plans.copied": "Copied",
  "plans.browserFailed": "We could not open your browser. Use the button below to try again.",
  "plans.copyAddress": "Copy address",

  // --- Gaming mode ------------------------------------------------
  //
  // Read the whole block as one thing: it is written so that no string
  // in it can be true while the machine is not in the state it names.
  //
  // Gaming mode installs DNS rules for named game services. It brings up
  // no tunnel and no adapter, and the machine's exit address is
  // unchanged. So "Connected" never appears here, no string promises a
  // lower ping or names a millisecond figure -- our best node measured
  // 72.8ms against 72.0ms direct, so a ping claim is one we cannot make
  // -- and `gaming.ipUnchanged` is on screen the entire time the mode is
  // selected. That last line is the anti-lie the whole feature hangs on.
  "dash.modeVpn": "VPN",
  "dash.modeGaming": "Gaming",
  "dash.modeVpnHint": "Everything on this computer goes through Neoxify.",
  "dash.modeGamingHint":
    "Only the game services you choose go through Neoxify. The game itself connects directly, on the shortest path.",

  "gaming.off": "Gaming mode is off",
  "gaming.offHint":
    "Nothing is being redirected right now. Turn it on to send the game services you chose through Neoxify.",
  "gaming.arming": "Setting up...",
  "gaming.armingHint": "Installing the rules for the games you chose.",
  "gaming.active": "Gaming mode is on",
  "gaming.activeHint":
    "The launcher, login and updates for the games you chose go through Neoxify. The game itself connects directly.",
  "gaming.partial": "Gaming mode is on, but not confirmed",
  // The exact sentence from the design, and it is not to be softened.
  // Rules present with a failed canary means the redirection may not be
  // happening at all, and a customer who is told it is "on" and nothing
  // else has been given a false pass.
  "gaming.partialHint":
    "Gaming mode is on, but Neoxify could not confirm your game traffic is reaching it.",
  "gaming.unknown": "Can't tell right now",
  "gaming.unknownHint":
    "Neoxify could not ask the helper service what it has installed, so it cannot say whether gaming mode is on.",
  // Replaces the exit-IP pill, which must not render in this mode: the
  // address is unchanged by design and showing one would be a plain lie.
  "gaming.pathDirect": "Game path: direct",
  "gaming.ipUnchanged": "Your computer's IP address does not change in this mode.",
  "gaming.turnOn": "Turn on",
  "gaming.turnOff": "Turn off",
  // On with nothing chosen is a reachable state and it does nothing at
  // all, so it says so in the warning chrome rather than sitting there
  // looking enabled -- the same defect class as the Custom-mode empty
  // state.
  "gaming.noGames": "No games chosen, so gaming mode does nothing. Add one below.",
  "gaming.noGamesDash": "No games chosen, so gaming mode does nothing. Pick one in Settings first.",
  "gaming.armFailed": "Gaming mode could not be turned on.",
  // The server's reasons, stated as the server gave them. Nothing here
  // claims a server was unreachable -- that would be a claim about a
  // dial that never happened.
  "gaming.needsPlan": "Gaming mode needs an active plan.",
  "gaming.notInPlan": "Your plan does not include gaming mode.",
  "gaming.noResolver": "Gaming mode is not available on your server yet.",
  "gaming.profileFailed": "Neoxify could not load the game list.",
  "gaming.retry": "Try again",
  "gaming.loading": "Loading games...",

  "settings.gaming": "Gaming",
  "gaming.title": "Gaming mode",
  "gaming.hint":
    "Send a game's launcher, login and updates through Neoxify, and leave the game itself on the direct path.",
  "gaming.chosen": "Games you've chosen",
  "gaming.addGame": "Add a game",
  "gaming.remove": "Remove",
  // What one row buys, said on the row. One row is one game: the
  // launcher and the game are not two things for the customer to find.
  "gaming.redirects": "Launcher, login and updates",
  "gaming.applies": "Changes take effect straight away while gaming mode is on.",
  "gaming.pickerTitle": "Choose a game",
  "gaming.search": "Search games",
  "gaming.searchEmpty": "No game matches that.",
  "gaming.listEmpty": "No games are on the list yet.",
  "gaming.cancel": "Cancel",
  "gaming.tooMany": "You can choose up to {max} games.",
  "gaming.games": "Games",
  "gaming.resolver": "Resolver",

  "common.loading": "Loading...",

  // The prominent disclosure shown once, before sign-in, on store
  // builds. Google Play requires an in-app explanation of why the app
  // needs VpnService and what data is collected, accepted by a
  // deliberate tap -- a privacy policy link alone does not satisfy it.
  // Worded as plainly as the policy it summarises: someone deciding
  // whether to trust a VPN in Iran is the reader.
  "disclosure.title": "Before you connect",
  "disclosure.subtitle": "What this app does, and what we collect. Please read it once.",
  "disclosure.vpnHeading": "Why Neoxify needs VPN permission",
  "disclosure.vpnBody":
    "Neoxify is a VPN. Android asks for your permission to create a VPN connection, and the app cannot work without it.",
  "disclosure.vpnBody2":
    "While you are connected, the app builds an encrypted tunnel and sends your device's internet traffic through the server you pick, so your connection stays private and can reach sites your network blocks. In Custom mode you choose which apps use the tunnel and the rest connect normally. Nothing is routed through the tunnel while you are disconnected.",
  "disclosure.dataHeading": "What we collect, and why",
  "disclosure.dataEmail":
    "Your email address and account ID — to create your account, sign you in, and contact you about it.",
  "disclosure.dataSupport":
    "Support messages you send from inside the app — so we can answer them.",
  "disclosure.dataDiagnostics":
    "Connection diagnostics — whether a connection worked, which server and protocol, the app version and any error message — so we can find and fix faults.",
  "disclosure.dataServerLogs":
    "Our VPN servers keep operational logs, which can include records of connections, so the service can be run and faults diagnosed.",
  "disclosure.dataNotSold":
    "We do not sell your data and we do not share it for advertising. In Custom mode, the list of apps you choose never leaves this device.",
  "disclosure.privacyLink": "Read the full privacy policy",
  "disclosure.accept": "Accept and continue",
} as const;

export type TranslationKey = keyof typeof en;

/** Persian. Kept as a full record so TypeScript refuses to build when a
 * key is added to English and not translated -- a half-translated screen
 * is worse than an untranslated one, because it looks broken rather than
 * unfinished. */
const fa: Record<TranslationKey, string> = {
  "app.tagline": "خصوصی، سریع، مال شما.",
  "auth.signInToConnect": "برای اتصال وارد شوید.",
  "auth.noCardRequired": "برای شروع نیازی به کارت بانکی نیست.",
  "verify.noCode": "کد را دریافت نکردید؟ ارسال دوباره",
  "loc.title": "انتخاب موقعیت",
  "loc.disconnectFirst": "برای تغییر سرور ابتدا قطع کنید",
  "loc.pickHint": "یک سرور و پروتکل انتخاب کنید",
  "loc.retry": "تلاش دوباره",

  "nav.settings": "تنظیمات",
  "nav.signOut": "خروج",
  "nav.back": "بازگشت",

  "auth.welcomeBack": "خوش آمدید",
  "auth.signIn": "ورود",
  "auth.signingIn": "در حال ورود...",
  "auth.email": "ایمیل",
  "auth.password": "رمز عبور",
  "auth.createAccount": "ساخت حساب",
  "auth.noAccount": "حساب کاربری ندارید؟",
  "auth.haveAccount": "قبلاً حساب ساخته‌اید؟",
  "auth.register": "ثبت‌نام",
  "auth.registering": "در حال ساخت...",

  "forgot.link": "رمز عبور را فراموش کرده‌اید؟",
  "forgot.title": "بازنشانی رمز عبور",
  "forgot.subtitle": "کدی برای تعیین رمز جدید ایمیل می‌کنیم.",
  "forgot.sendCode": "ارسال کد",
  "forgot.sending": "در حال ارسال...",
  "forgot.sent": "اگر این نشانی ثبت شده باشد، کد ارسال می‌شود. اعتبار آن ۳۰ دقیقه است.",
  "forgot.code": "کد داخل ایمیل",
  "forgot.newPassword": "رمز عبور جدید",
  "forgot.confirmPassword": "تکرار رمز عبور جدید",
  "forgot.submit": "ثبت رمز جدید",
  "forgot.submitting": "در حال ذخیره...",
  "forgot.done": "رمز عبور تغییر کرد. اکنون می‌توانید وارد شوید.",
  "forgot.backToSignIn": "بازگشت به ورود",
  "forgot.tooShort": "حداقل ۸ نویسه.",
  "forgot.mismatch": "یکسان نیستند.",

  "verify.title": "ایمیل خود را بررسی کنید",
  "verify.sentTo": "کد را به {email} فرستادیم",
  "verify.code": "کد تأیید",
  "verify.confirm": "تأیید",
  "verify.confirming": "در حال تأیید...",
  "verify.resend": "ارسال دوباره",
  "verify.sending": "در حال ارسال...",

  "dash.connect": "اتصال",
  "dash.connecting": "در حال اتصال...",
  "dash.disconnect": "قطع اتصال",
  "dash.disconnecting": "در حال قطع...",
  "dash.connected": "متصل",
  "dash.disconnected": "متصل نیستید",
  "dash.dataUsed": "مصرف داده",
  "dash.expires": "انقضا",
  "dash.location": "موقعیت",
  "dash.viewPlans": "مشاهده پلن‌ها",
  "dash.noSubscription": "اشتراک فعالی ندارید",
  "dash.noPlanHint": "برای شروع استفاده از نئوکسیفای یک پلن انتخاب کنید.",
  "dash.outOfData": "حجم پلن شما تمام شده است",
  "dash.planExpired": "اعتبار پلن شما به پایان رسیده است",
  "dash.renewHint": "برای ادامه اتصال، پلن خود را تمدید یا تغییر دهید.",
  "dash.renewStore":
    "این پلن از همان جایی که آن را خریده‌اید مدیریت می‌شود. برای تمدید، وارد حساب خود در همان‌جا شوید؛ پس از تمدید، دوباره همین‌جا نمایش داده می‌شود.",
  "dash.renewCta": "تمدید پلن",
  "dash.noPlanStore": "حساب شما آماده است. به‌محض افزوده‌شدن یک پلن، همین‌جا نمایش داده می‌شود و می‌توانید متصل شوید.",

  "plans.title": "انتخاب پلن",
  "plans.subtitle": "برای شروع اتصال یک پلن انتخاب کنید.",
  "plans.crypto": "رمزارز",
  "plans.card": "کارت بانکی",
  "plans.loading": "در حال بارگذاری پلن‌ها...",
  "plans.none": "در حال حاضر پلنی موجود نیست. کمی بعد دوباره سر بزنید.",
  "plans.waiting": "در انتظار پرداخت",

  "auth.referralCode": "کد معرف (اختیاری)",
  "auth.referralCodeHint": "از دوستی که شما را دعوت کرده",
  "update.downloading": "در حال دریافت نئوکسیفای {version}...",
  "update.downloadingPercent": "در حال دریافت نئوکسیفای {version} — {percent}٪",
  "update.ready": "نئوکسیفای {version} آماده نصب است.",
  "update.restart": "راه‌اندازی مجدد",
  "update.restarting": "در حال راه‌اندازی مجدد...",
  "update.connectedFirst": "برای به‌روزرسانی ابتدا قطع کنید.",
  "dash.customModeDetached": "متصل شد، اما حالت سفارشی وصل نشد — ترافیک برنامه‌های انتخابی شما بدون محافظت خارج می‌شود.",
  "dash.unlimited": "نامحدود",
  "support.title": "پشتیبانی",
  "support.subtitle": "هر سوالی دارید بپرسید — در اولین فرصت پاسخ می‌دهیم.",
  "support.new": "پیام جدید",
  "support.newTitle": "چه کمکی از ما بر می‌آید؟",
  "support.subject": "موضوع",
  "support.subjectHint": "در چند کلمه، مثلاً «با استلث وصل نمی‌شوم»",
  "support.message": "پیام",
  "support.messageHint": "بنویسید چه اتفاقی افتاده و چه کارهایی را امتحان کرده‌اید.",
  "support.send": "ارسال",
  "support.sending": "در حال ارسال...",
  "support.reply": "نوشتن پاسخ",
  "support.replyWithin": "معمولاً ظرف {hours} ساعت پاسخ می‌دهیم.",
  "support.replyWithinDay": "معمولاً ظرف یک روز پاسخ می‌دهیم.",
  "support.closed": "در حال حاضر پیام جدید پذیرفته نمی‌شود. لطفاً بعداً سر بزنید.",
  "support.closedTitle": "پیام جدید پذیرفته نمی‌شود",
  "support.empty": "هنوز گفتگویی ندارید.",
  "support.emptyHint": "یک گفتگو شروع کنید تا اینجا نمایش داده شود.",
  "support.you": "شما",
  "support.team": "پشتیبانی",
  "support.statusOpen": "در انتظار پاسخ",
  "support.statusAnswered": "پاسخ داده شد",
  "support.statusResolved": "بسته شد",
  "support.unread": "پاسخ جدید",
  "support.notLive": "این گفتگوی زنده نیست — می‌توانید برنامه را ببندید؛ پاسخ در همین‌جا و در ایمیل شما خواهد بود.",
  "referrals.title": "دعوت از دوستان",
  "referrals.subtitle": "کد خود را به اشتراک بگذارید و زمان رایگان بگیرید.",
  "referrals.off": "برنامه معرفی در حال حاضر فعال نیست. بعداً سر بزنید.",
  "referrals.yourCode": "کد معرف شما",
  "referrals.rule": "با {months} ماه اشتراک یک دوست، یا {friends} دوست با {each} ماه، {days} روز رایگان بگیرید.",
  "referrals.copy": "کپی",
  "referrals.copied": "کپی شد",
  "referrals.progress": "ماه رایگان بعدی",
  "referrals.monthsToGo": "{count} ماه پرداختی باقی مانده",
  "referrals.almost": "در بررسی بعدی آماده می‌شود",
  "referrals.progressHint": "بیشترین دوست: {best} ماه پرداختی. دوستان واجد شرایط: {qualifying}.",
  "referrals.friends": "دوستان دعوت‌شده",
  "referrals.friendsHint": "نیمه‌پنهان نمایش داده می‌شود — نشانی آنها خصوصی می‌ماند.",
  "referrals.noFriends": "هنوز کسی نیست. کد خود را به اشتراک بگذارید.",
  "referrals.joined": "عضو شد",
  "referrals.pending": "فعال نشده",
  "referrals.paidMonths": "{count} ماه پرداختی",
  "referrals.earned": "زمان رایگان کسب‌شده",
  "referrals.freeDays": "{days} روز رایگان",
  "nav.referrals": "دعوت از دوستان",
  "settings.title": "تنظیمات",
  "settings.subtitle": "مدیریت حساب کاربری.",
  "settings.language": "زبان",
  "settings.languageHint": "تغییر زبان بلافاصله اعمال می‌شود.",
  "settings.deleteAccount": "حذف حساب",
  "settings.deleteAccountHint": "حساب شما و همه‌چیز روی آن برای همیشه حذف می‌شود.",
  "settings.deleteWarning": "این کار برگشت‌پذیر نیست. حساب شما، اطلاعات اتصال شما روی همه سرورها و باقی‌ماندهٔ اشتراکتان بلافاصله حذف می‌شوند. فاکتورها برای مسائل مالیاتی نگه داشته می‌شوند، بدون اطلاعات شخصی شما.",
  "settings.deleteTypeToConfirm": "برای تأیید {word} را بنویسید",
  "settings.deleteConfirmWord": "DELETE",
  "settings.deleteConfirm": "حذف دائمی",
  "settings.deleteCancel": "حساب من بماند",
  "settings.deleting": "در حال حذف...",
  "settings.changePassword": "تغییر رمز عبور",
  "settings.changePasswordHint": "روی این دستگاه وارد می‌مانید.",
  "settings.currentPassword": "رمز عبور فعلی",
  "settings.newPassword": "رمز عبور جدید",
  "settings.confirmPassword": "تکرار رمز عبور جدید",
  "settings.passwordChanged": "رمز عبور تغییر کرد. دستگاه‌های دیگر از حساب خارج شدند.",
  "settings.changing": "در حال تغییر...",
  "settings.tooShort": "حداقل ۸ کاراکتر.",
  "dash.customActive":
    "حالت سفارشی: فقط برنامه‌های انتخابی شما از VPN عبور می‌کنند. IPv6 آن‌ها به جای ارسال بیرون از تونل مسدود می‌شود، بنابراین سایتی که فقط IPv6 دارد برایشان باز نمی‌شود.",
  "dash.fullTunnelIpv6Blocked":
    "تا زمانی که متصل هستید، IPv6 مسدود است. سرورهای Neoxify فقط IPv4 را منتقل می‌کنند، بنابراین IPv6 به جای ارسال بیرون از VPN همین‌جا متوقف می‌شود. سایتی که فقط IPv6 دارد تا وقتی اتصال را قطع نکنید باز نمی‌شود.",
  "dash.ipv6Escaping":
    "بخشی از ترافیک شما از طریق IPv6 و بیرون از VPN ارسال می‌شود. نشانی IPv6 شما برای شبکه‌تان دیده می‌شود. اتصال را قطع و دوباره وصل کنید؛ اگر باز هم تکرار شد، به پشتیبانی اطلاع دهید.",
  "voucher.title": "کد هدیه دارید؟",
  "voucher.subtitle": "با وارد کردن کد، بدون پرداخت اشتراک فعال کنید.",
  "voucher.placeholder": "کد خود را وارد کنید",
  "voucher.check": "بررسی",
  "voucher.valid": "این کد معتبر است",
  "voucher.days": "روز",
  "voucher.confirm": "فعال‌سازی این پلن",
  "voucher.cancel": "انصراف",
  "settings.general": "عمومی",
  "settings.account": "حساب کاربری",
  "settings.sections": "بخش‌ها",
  "settings.custom": "حالت سفارشی",
  "settings.customBeta": "آزمایشی",
  "settings.customHint": "فقط برنامه‌هایی که انتخاب می‌کنید از VPN عبور می‌کنند. بقیه از اینترنت معمولی استفاده می‌کنند.",
  "settings.customOn": "روشن",
  "settings.customOff": "خاموش",
  "settings.customAddApp": "افزودن برنامه",
  "settings.customNoApps": "هنوز برنامه‌ای انتخاب نشده، پس چیزی از تونل عبور نمی‌کند. یکی اضافه کنید.",
  "settings.customRemove": "حذف",
  "settings.customApplies": "از اتصال بعدی اعمال می‌شود.",
  "settings.customFailOpen": "هنگام تعویض سرور، برنامه‌های انتخابی به‌جای قطع شدن، لحظه‌ای از اینترنت معمولی استفاده می‌کنند.",
  "settings.customTooMany": "حداکثر {max} برنامه می‌توانید انتخاب کنید.",
  "settings.customAlready": "این برنامه از قبل در فهرست است.",
  "settings.customModeOnly": "فقط این برنامه‌ها",
  "settings.customModeExcept": "همه به‌جز این‌ها",
  "settings.customModeOnlyHint": "فقط برنامه‌هایی که انتخاب می‌کنید از VPN رد می‌شوند. بقیه از اینترنت معمولی شما استفاده می‌کنند.",
  "settings.customModeExceptHint": "همه چیز از VPN رد می‌شود، به‌جز برنامه‌هایی که انتخاب می‌کنید.",
  "settings.customNoAppsExcept": "هنوز برنامه‌ای انتخاب نشده، پس همه چیز از VPN رد می‌شود. برای کنار گذاشتن یکی، آن را اضافه کنید.",
  "settings.customPickRunning": "از برنامه‌های باز انتخاب کنید",
  "settings.customPickFile": "جست‌وجوی برنامه",
  "settings.customRunningTitle": "برنامه‌های در حال اجرا",
  "settings.customRunningEmpty": "چیزی برای نمایش نیست. به‌جایش برنامه را جست‌وجو کنید.",
  "settings.customSearchEmpty": "برنامه‌ای با این نام پیدا نشد.",
  "settings.customAppParts": "{count} برنامه، همه با هم مسیردهی می‌شوند",
  "settings.customRunningRefresh": "تازه‌سازی",
  "settings.customCancel": "انصراف",
  "settings.customAppUsesVpn": "از VPN استفاده می‌کند",
  "settings.customAppBypasses": "بدون VPN",
  "dash.offlineTitle": "در حال حاضر به Neoxify دسترسی نیست — همچنان می‌توانید متصل شوید.",
  "dash.offlineHint":
    "از سرورهای ذخیره‌شده استفاده می‌شود. مصرف داده و تاریخ انقضا آخرین بار در {when} به‌روز شده و ممکن است دقیق نباشد.",
  "dash.androidWireguardOnly":
    "پروتکل {protocol} هنوز در نسخه اندروید نیست، بنابراین با Fast متصل می‌شود.",
  "settings.customAllApps":
    "هنوز برنامه‌ای انتخاب نشده، پس همه برنامه‌ها از VPN عبور می‌کنند. برای عبور فقط یک برنامه، آن را انتخاب کنید.",
  "settings.customHintNative":
    "فقط برنامه‌هایی که انتخاب می‌کنید از VPN عبور می‌کنند. بقیه از اینترنت معمولی استفاده می‌کنند.",
  "settings.customSearch": "جست‌وجوی برنامه‌ها",
  "settings.customNoMatches": "برنامه‌ای با این نام پیدا نشد.",
  "settings.customClear": "پاک کردن انتخاب‌ها",
  "settings.mismatch": "یکسان نیستند.",

  "dash.subscription": "اشتراک",
  "dash.retry": "تلاش دوباره",
  "dash.loadFailed": "بارگذاری حساب کاربری ممکن نشد.",
  "dash.changeLocation": "تغییر موقعیت",
  "dash.status.active": "فعال",
  "dash.server": "سرور",
  "dash.protocol": "پروتکل",
  "dash.session": "مدت اتصال",
  "dash.daysLeft": "روز مانده",
  "dash.change": "تغییر",
  "dash.disconnectToChange": "برای تغییر سرور یا پروتکل، ابتدا قطع اتصال کنید",
  "dash.protected": "شما محافظت می‌شوید",
  "dash.protectedHint": "ترافیک شما رمزگذاری شده و از طریق نئوکسیفای عبور می‌کند.",
  "dash.notProtected": "شما محافظت نمی‌شوید",
  "dash.notProtectedHint": "برای رمزگذاری ترافیک و پنهان‌کردن آی‌پی خود متصل شوید.",
  "dash.degraded": "ترافیک عبور نمی‌کند",
  "dash.degradedHint": "تونل برقرار است اما سرور پاسخ نمی‌دهد. ترافیک شما محافظت نمی‌شود. دوباره وصل شوید یا سرور دیگری انتخاب کنید.",
  "dash.unverified": "متصل، اما تأیید نشده",
  "dash.unverifiedShort": "تأیید نشده",
  "dash.unverifiedHint":
    "تونل برقرار است و نشانه‌ای از خرابی دیده نمی‌شود — اما نئوکسیفای نتوانسته تأیید کند که ترافیک شما واقعاً از آن عبور می‌کند. اگر می‌خواهید مطمئن شوید، دوباره وصل شوید.",
  "dash.unverifiedCustomHint":
    "حالت سفارشی در حال اجراست و تونل برقرار است، اما نئوکسیفای نتوانست تأیید کند که ترافیک برنامه‌های انتخابی شما به سرور می‌رسد. اگر می‌خواهید مطمئن شوید، دوباره وصل شوید.",
  "dash.verifying": "در حال بررسی اتصال...",
  "dash.verifyingHint": "در حال برقراری تونل — هر پروتکل امتحان می‌شود. برای توقف کلیک کنید.",
  "dash.unknown": "در حال حاضر مشخص نیست",
  "dash.unknownHint":
    "سرویس نئوکسیفای پاسخ نمی‌دهد، بنابراین برنامه نمی‌تواند بگوید محافظت شده‌اید یا نه. تلاش ادامه دارد — تا پاسخ نیامده، هیچ‌کدام را فرض نکنید.",
  "dash.recheck": "بررسی وضعیت",
  "dash.switchedTo": "پروتکل همیشگی شما عبور نکرد. اکنون از این استفاده می‌شود:",
  "dash.switchedServer": "دسترسی به {from} ممکن نشد. اکنون {to} با {protocol}",
  "dash.usedInstead": "به‌جای {from}، {to} با {protocol} استفاده شد. برای ثابت‌ماندن، یک سرور انتخاب کنید.",
  "dash.yourIp": "آی‌پی شما:",
  "err.serviceUnavailable": "سرویس پس‌زمینه نئوکسیفای اجرا نمی‌شود. معمولاً راه‌اندازی دوباره برنامه مشکل را حل می‌کند.",
  "err.engineMissing": "بخشی از نصب ناقص است. لطفاً دوباره نصب کنید.",
  "err.teardownStuck":
    "تونل هنوز در حال بسته شدن است. اگر اینترنت شما وصل نشد، برنامه را ببندید و دوباره باز کنید.",
  "err.serverUnreachable": "این سرور در دسترس نیست. موقعیت دیگری را امتحان کنید.",
  "err.notCarryingTraffic": "اتصال برقرار شد اما ترافیکی عبور نکرد.",
  "err.allProtocolsFailed": "همه پروتکل‌های موجود امتحان شدند — هیچ‌کدام ترافیک را عبور ندادند.",
  "err.concurrentLimit": "سقف دستگاه‌های پلن شما پر شده است. یک دستگاه دیگر را قطع کنید.",
  "err.quotaExhausted": "حجم پلن شما تمام شده است.",
  "err.subscriptionInactive": "اشتراک شما فعال نیست.",
  "err.connectBusy": "یک تلاش برای اتصال در حال انجام است. کمی صبر کنید و دوباره امتحان کنید.",
  "err.unknown": "اتصال برقرار نشد.",
  "err.showDetail": "جزئیات فنی",

  "settings.repair": "ترمیم شبکه",
  "repair.title": "ترمیم شبکهٔ من",
  "repair.subtitle": "هر چیزی را که نئوکسیفای در ویندوز جا گذاشته پاک می‌کند.",
  "repair.explain":
    "نئوکسیفای این موارد را پیدا و پاک می‌کند: موتورهای VPN که هنوز در حال اجرا مانده‌اند، قانون DNS که هنگام اتصال تنظیم می‌شود، مسیرهای روی کارت‌های شبکهٔ خودش، قانون فایروال آن، سرویس تونل وایرگارد جامانده، و ورودی آن در فهرست VPN ویندوز. در پایان هم حافظهٔ نهان DNS را خالی می‌کند.",
  "repair.disconnects": "اگر متصل باشید، ابتدا اتصال شما قطع می‌شود.",
  "repair.safety":
    "این کار فقط چیزها را حذف می‌کند. هیچ ترافیکی را مسدود نمی‌کند و به تنظیمات اینترنت عادی شما دست نمی‌زند.",
  "repair.run": "شروع ترمیم",
  "repair.running": "در حال ترمیم...",
  "repair.runAgain": "ترمیم دوباره",
  "repair.resultClean": "چیزی جا نمانده بود — تنظیمات شبکهٔ شما همان است که ویندوز داشت.",
  "repair.resultFixed": "ترمیم انجام شد. دوباره برای اتصال تلاش کنید.",
  "repair.resultUnverified":
    "ترمیم انجام شد، اما یک بررسی کامل نشد و نمی‌توان آن را تأیید کرد. معمولاً فقط به‌دلیل کندی دستگاه است. دوباره برای اتصال تلاش کنید؛ اگر باز هم کار نکرد، دستور زیر را با دسترسی مدیر اجرا کنید و خروجی آن را برای ما بفرستید.",
  "repair.resultProblems":
    "بخشی از آن ترمیم نشد. معمولاً راه‌اندازی دوبارهٔ ویندوز باقی را پاک می‌کند؛ اگر نشد، دستور زیر را با دسترسی مدیر اجرا کنید و خروجی آن را برای ما بفرستید.",
  "repair.failed": "ترمیم انجام نشد.",
  "repair.stepClean": "چیزی پیدا نشد",
  "repair.stepFixed": "پاک شد",
  "repair.stepFailed": "هنوز باقی است",
  "repair.stepUnknown": "قابل بررسی نبود",
  "repair.step.tunnel": "تونل و حالت سفارشی",
  "repair.step.engines": "موتورهای جاماندهٔ VPN",
  "repair.step.dns": "قانون DNS تونل",
  "repair.step.routes": "مسیرها روی کارت‌های شبکهٔ نئوکسیفای",
  "repair.step.firewall": "قانون فایروال حالت سفارشی",
  "repair.step.wfp": "فیلترهای ترافیک ویندوز",
  "repair.step.wireguardService": "سرویس تونل جاماندهٔ وایرگارد",
  "repair.step.ras": "نئوکسیفای در فهرست VPN ویندوز",
  "repair.step.dnsCache": "حافظهٔ نهان DNS",
  "repair.noService": "سرویس نئوکسیفای پاسخ نمی‌دهد، بنابراین برنامه نمی‌تواند این کار را برای شما انجام دهد.",
  "repair.noServiceHint":
    "منوی Start را باز کنید، cmd را بنویسید، روی Command Prompt راست‌کلیک کنید و «Run as administrator» را بزنید. سپس این دستور را اجرا کنید:",
  "repair.copyCommand": "کپی دستور",
  "repair.copied": "کپی شد",
  "repair.inlineCta": "هنوز وصل نمی‌شود؟ شبکه‌ام را ترمیم کن",

  "diag.title": "ارسال اطلاعات دستگاه",
  "diag.subtitle":
    "خلاصه‌ای کوتاه از آنچه نئوکسیفای روی این کامپیوتر دارد. آن را در پیام خود بگذارید تا ما هم همان چیزی را ببینیم که شما می‌بینید.",
  "diag.collect": "جمع‌آوری اطلاعات",
  "diag.collecting": "در حال جمع‌آوری...",
  "diag.copy": "کپی",
  "diag.copied": "کپی شد",
  "diag.privacy":
    "هیچ رمز عبور، کلید، مشخصات سرور یا اطلاعاتی دربارهٔ سایت‌هایی که باز می‌کنید در آن نیست. پیش از ارسال می‌توانید همهٔ آن را بخوانید.",
  "diag.failed": "سرویس نئوکسیفای پاسخ نمی‌دهد، بنابراین چیزی برای جمع‌آوری نیست.",

  "plans.back": "بازگشت",
  "plans.perDays": "برای {days} روز",
  "plans.data": "حجم",
  "plans.speed": "سرعت",
  "plans.devices": "دستگاه",
  "plans.unlimited": "نامحدود",
  "plans.upTo": "تا {n} مگابیت",
  "plans.devicesAtOnce": "{n} همزمان",
  "plans.bestValue": "بهترین انتخاب",
  "plans.payWith": "پرداخت با",
  "plans.amount": "مبلغ",
  "plans.toAddress": "به این آدرس",
  "plans.openCheckout": "باز کردن صفحه پرداخت",
  "plans.copied": "کپی شد",
  "plans.browserFailed": "مرورگر باز نشد. با دکمه زیر دوباره تلاش کنید.",
  "plans.copyAddress": "کپی آدرس",

  // Gaming mode. The Persian carries the honest wording too, not a
  // softened translation -- «شما محافظت می‌شوید» must never appear on a
  // screen where nothing is tunnelled, and nothing here says it.
  "dash.modeVpn": "وی‌پی‌ان",
  "dash.modeGaming": "بازی",
  "dash.modeVpnHint": "همه‌ی ترافیک این رایانه از نئوکسیفای عبور می‌کند.",
  "dash.modeGamingHint":
    "فقط سرویس‌های بازی‌ای که انتخاب می‌کنید از نئوکسیفای عبور می‌کنند. خود بازی مستقیم و از کوتاه‌ترین مسیر وصل می‌شود.",

  "gaming.off": "حالت بازی خاموش است",
  "gaming.offHint":
    "در حال حاضر هیچ ترافیکی هدایت نمی‌شود. برای عبور دادن سرویس‌های بازی‌ای که انتخاب کرده‌اید، آن را روشن کنید.",
  "gaming.arming": "در حال آماده‌سازی...",
  "gaming.armingHint": "قواعد بازی‌هایی که انتخاب کرده‌اید در حال نصب است.",
  "gaming.active": "حالت بازی روشن است",
  "gaming.activeHint":
    "لانچر، ورود و به‌روزرسانی بازی‌هایی که انتخاب کرده‌اید از نئوکسیفای عبور می‌کند. خود بازی مستقیم وصل می‌شود.",
  "gaming.partial": "حالت بازی روشن است، اما تأیید نشده",
  "gaming.partialHint":
    "حالت بازی روشن است، اما نئوکسیفای نتوانست تأیید کند که ترافیک بازی شما به آن می‌رسد.",
  "gaming.unknown": "الان نمی‌توان گفت",
  "gaming.unknownHint":
    "نئوکسیفای نتوانست از سرویس کمکی بپرسد چه چیزی نصب شده است، پس نمی‌تواند بگوید حالت بازی روشن است یا نه.",
  "gaming.pathDirect": "مسیر بازی: مستقیم",
  "gaming.ipUnchanged": "در این حالت نشانی آی‌پی رایانه‌ی شما تغییر نمی‌کند.",
  "gaming.turnOn": "روشن کردن",
  "gaming.turnOff": "خاموش کردن",
  "gaming.noGames": "هیچ بازی‌ای انتخاب نشده است، پس حالت بازی هیچ کاری نمی‌کند. از پایین یکی اضافه کنید.",
  "gaming.noGamesDash":
    "هیچ بازی‌ای انتخاب نشده است، پس حالت بازی هیچ کاری نمی‌کند. ابتدا در تنظیمات یک بازی انتخاب کنید.",
  "gaming.armFailed": "حالت بازی روشن نشد.",
  "gaming.needsPlan": "حالت بازی به یک اشتراک فعال نیاز دارد.",
  "gaming.notInPlan": "اشتراک شما شامل حالت بازی نمی‌شود.",
  "gaming.noResolver": "حالت بازی هنوز روی سرور شما در دسترس نیست.",
  "gaming.profileFailed": "نئوکسیفای نتوانست فهرست بازی‌ها را بارگیری کند.",
  "gaming.retry": "تلاش دوباره",
  "gaming.loading": "در حال بارگذاری بازی‌ها...",

  "settings.gaming": "بازی",
  "gaming.title": "حالت بازی",
  "gaming.hint":
    "لانچر، ورود و به‌روزرسانی یک بازی را از نئوکسیفای عبور دهید و خود بازی را روی مسیر مستقیم بگذارید.",
  "gaming.chosen": "بازی‌هایی که انتخاب کرده‌اید",
  "gaming.addGame": "افزودن بازی",
  "gaming.remove": "حذف",
  "gaming.redirects": "لانچر، ورود و به‌روزرسانی‌ها",
  "gaming.applies": "تا وقتی حالت بازی روشن است، تغییرات بلافاصله اعمال می‌شود.",
  "gaming.pickerTitle": "انتخاب بازی",
  "gaming.search": "جست‌وجوی بازی",
  "gaming.searchEmpty": "هیچ بازی‌ای با این عبارت پیدا نشد.",
  "gaming.listEmpty": "هنوز هیچ بازی‌ای در فهرست نیست.",
  "gaming.cancel": "انصراف",
  "gaming.tooMany": "حداکثر {max} بازی می‌توانید انتخاب کنید.",
  "gaming.games": "بازی‌ها",
  "gaming.resolver": "سرور نام",

  "common.loading": "در حال بارگذاری...",

  "disclosure.title": "پیش از اتصال",
  "disclosure.subtitle": "این برنامه چه می‌کند و ما چه اطلاعاتی جمع‌آوری می‌کنیم. لطفاً یک بار بخوانید.",
  "disclosure.vpnHeading": "چرا نئوکسیفای به دسترسی وی‌پی‌ان نیاز دارد",
  "disclosure.vpnBody":
    "نئوکسیفای یک وی‌پی‌ان است. اندروید برای ساختن اتصال وی‌پی‌ان از شما اجازه می‌گیرد و برنامه بدون آن کار نمی‌کند.",
  "disclosure.vpnBody2":
    "تا زمانی که متصل هستید، برنامه یک تونل رمزنگاری‌شده می‌سازد و ترافیک اینترنت دستگاه شما را از سروری که انتخاب می‌کنید عبور می‌دهد، تا اتصال شما خصوصی بماند و به سایت‌هایی که شبکه‌تان مسدود کرده دسترسی داشته باشید. در حالت سفارشی، خودتان انتخاب می‌کنید کدام برنامه‌ها از تونل استفاده کنند و بقیه به‌طور عادی متصل می‌شوند. وقتی قطع هستید، هیچ ترافیکی از تونل عبور نمی‌کند.",
  "disclosure.dataHeading": "چه اطلاعاتی جمع‌آوری می‌کنیم و چرا",
  "disclosure.dataEmail":
    "آدرس ایمیل و شناسه حساب شما — برای ساخت حساب، ورود شما، و تماس با شما درباره حساب.",
  "disclosure.dataSupport":
    "پیام‌های پشتیبانی که از داخل برنامه می‌فرستید — تا بتوانیم پاسخ دهیم.",
  "disclosure.dataDiagnostics":
    "اطلاعات عیب‌یابی اتصال — اینکه اتصال برقرار شد یا نه، کدام سرور و پروتکل، نسخه برنامه و متن خطا — تا بتوانیم اشکالات را پیدا و برطرف کنیم.",
  "disclosure.dataServerLogs":
    "سرورهای وی‌پی‌ان ما گزارش‌های عملیاتی نگه می‌دارند که می‌تواند شامل سوابق اتصال باشد، تا سرویس اداره شود و اشکالات تشخیص داده شوند.",
  "disclosure.dataNotSold":
    "ما اطلاعات شما را نمی‌فروشیم و برای تبلیغات با کسی به اشتراک نمی‌گذاریم. در حالت سفارشی، فهرست برنامه‌هایی که انتخاب می‌کنید هرگز از این دستگاه خارج نمی‌شود.",
  "disclosure.privacyLink": "خواندن متن کامل سیاست حریم خصوصی",
  "disclosure.accept": "می‌پذیرم و ادامه می‌دهم",
};

const DICTIONARIES: Record<Language, Record<TranslationKey, string>> = { en, fa };

const STORE_FILE = "settings.json";
const STORE_KEY = "language";

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  storePromise ??= load(STORE_FILE, { autoSave: true });
  return storePromise;
}

interface I18nValue {
  language: Language;
  dir: "ltr" | "rtl";
  setLanguage: (language: Language) => void;
  /** Translates a key, substituting {placeholders} from `vars`. */
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

/** Picks the starting language when nothing has been chosen yet.
 *
 * Reads the OS locale rather than defaulting to English, so a Persian
 * speaker opening the app for the first time sees Persian without having
 * to find a setting written in a language they may not read. */
function detectLanguage(): Language {
  const locale = typeof navigator !== "undefined" ? navigator.language : "";
  return locale.toLowerCase().startsWith("fa") ? "fa" : "en";
}

/** Where the customer is, according to the CDN in front of the API.
 *
 * The OS locale alone is not enough, and the gap is the common case
 * rather than an edge one: a great many customers in Iran run Windows in
 * English, so `navigator.language` says `en-US` and they were shown an
 * English app they may not read -- with the language switch itself
 * written in English.
 *
 * Cloudflare labels every proxied request with the country, so this
 * costs one small request and no GeoIP data of our own. Deliberately
 * best-effort and quick to give up: this decides a default that is one
 * tap to change, and must never delay or block the first screen. A
 * blocked network, an old server that does not return the field, or a
 * request that took too long all mean "unknown", which means English.
 */
async function detectCountry(): Promise<string | undefined> {
  try {
    const result = await publicRequest<{ ip: string; country?: string }>("/health/ip");
    return result.ok ? result.data.country : undefined;
  } catch {
    return undefined;
  }
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>(detectLanguage);

  // Restores the saved choice. Until it resolves the detected language is
  // shown, so the first paint is never blank waiting on disk.
  useEffect(() => {
    void (async () => {
      let saved: Language | undefined;
      try {
        saved = await (await getStore()).get<Language>(STORE_KEY);
        if (saved && saved in LANGUAGES) setLanguageState(saved);
      } catch {
        // A settings file that can't be read is not worth failing over --
        // the detected language is a fine answer.
      }

      // Only when the customer has never chosen. An explicit choice is
      // final: someone in Iran who switched to English must not be put
      // back into Persian every launch, which would read as the app
      // ignoring them.
      if (saved && saved in LANGUAGES) return;
      // The OS locale already said Persian, so there is nothing to add
      // and no reason to spend a request finding out.
      if (detectLanguage() === "fa") return;

      const country = await detectCountry();
      if (country === "IR") setLanguageState("fa");
    })();
  }, []);

  const dir = LANGUAGES[language].dir;

  // Set on the document rather than a wrapper element so it reaches
  // portalled content -- dialogs and dropdowns render outside the React
  // tree and would otherwise stay left-to-right.
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = dir;
  }, [language, dir]);

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    void (async () => {
      try {
        await (await getStore()).set(STORE_KEY, next);
      } catch {
        // Persisting is best-effort: the change already applied, and
        // failing to remember it is better than refusing to switch.
      }
    })();
  }, []);

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>) => {
      let text: string = DICTIONARIES[language][key] ?? en[key] ?? key;
      if (vars) {
        for (const [name, value] of Object.entries(vars)) {
          text = text.split(`{${name}}`).join(String(value));
        }
      }
      return text;
    },
    [language],
  );

  return <I18nContext.Provider value={{ language, dir, setLanguage, t }}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
