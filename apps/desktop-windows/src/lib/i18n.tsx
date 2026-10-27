import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { load, type Store } from "@tauri-apps/plugin-store";
import { apiRequest, publicRequest } from "./api";
import { getTokens } from "./session";

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
  "app.tagline": "Your private connection.",
  "auth.continueWithGoogle": "Continue with Google",
  "auth.continueWithApple": "Continue with Apple",
  "auth.continueWithFacebook": "Continue with Facebook",
  "auth.orUseEmail": "or use email",
  "auth.socialFailed": "Sign-in didn't work. Try again.",
  "auth.socialUnavailable": "This sign-in option isn't available right now. Use another one.",
  "auth.appleNoAccount": "Sign in to your Apple Account in Settings, then try again.",
  // Under the Google and Facebook buttons while their browser sign-in is
  // open, and after it closes without a result (SocialSignIn). The app
  // starts that page on whichever Neoxify address answers, but the
  // provider sends the browser back to one fixed address, the backend's
  // PUBLIC_API_URL, which is behind Cloudflare; where Cloudflare is
  // blocked that last step never loads. Email sign-in goes through every
  // address the app knows. If PUBLIC_API_URL ever moves off Cloudflare,
  // this sentence has to change with it.
  "auth.socialNeedsCloudflare":
    "Google and Facebook sign-in comes back to the app through Cloudflare, which some networks block. If the sign-in page doesn't load, close it and sign in with your email and password below.",
  // Ends a Google or Facebook sign-in still waiting on the browser, on
  // Windows, where closing the browser tells the app nothing.
  "auth.socialCancel": "Cancel",
  "auth.signInToConnect": "Sign in to connect.",
  "auth.noCardRequired": "No card needed to sign up.",
  "verify.noCode": "Send the code again",
  "loc.title": "Choose location",
  "loc.disconnectFirst": "Disconnect first to switch servers",
  // Shown when nothing is connected, where the line above would be
  // false: it told customers to disconnect while they already were.
  "loc.pickHint": "Pick a server and protocol",
  "loc.serverN": "Server {n}",
  "loc.retry": "Retry",
  // The first row of the picker, and what a new install starts on. It
  // promises only what the ladder does: an order, and moving on by
  // itself. Not "the best" or "the fastest" server.
  "loc.automatic": "Automatic (recommended)",
  "loc.automaticHint": "Tries what's most likely to work on your network first, and moves on to the next option if it fails",
  "loc.automaticShort": "Automatic",
  // Hedged and dated on purpose: filtering differs between two people on
  // the same ISP and changes day to day, so this is what others saw
  // recently -- never a promise about this customer.
  "loc.ispWorks": "Worked for most people on your network recently",
  "loc.ispFailing": "Failing for most people on your network recently",
  "loc.ispCount": "{customers} of {outOf} people, last {hours} hours",
  "loc.recommendedOnly": "Only show what worked on my network",
  "dash.serverAuto": "Server (auto)",

  "nav.settings": "Settings",
  "nav.signOut": "Sign out",
  "nav.signingOut": "Signing out...",
  "nav.back": "Back",
  // Shown on the sign-in screen when the tunnel could not be confirmed
  // down. It must not reassure: the customer may still be connected
  // under the account they just left, and a restart is what certainly
  // ends it.
  "signout.tunnelUnconfirmed":
    "You're signed out, but the app couldn't confirm the VPN was switched off. Restart Neoxify or this device to be sure.",
  // The server ended the session (signed out elsewhere, password
  // changed, account removed). Says nothing about the VPN: that it is
  // off is what reaching this screen without the line above means.
  "signout.sessionEnded": "Your session ended. Sign in again to continue.",
  // The sign-in screen's notice after the verification email's "Open in
  // Neoxify" link. The reason is a failed request's own text, already in
  // the customer's language (failure-text.ts).
  "auth.emailVerifiedNotice": "Email confirmed. Sign in to continue.",
  "auth.verifyLinkFailed": "Couldn't confirm your email: {reason}",

  "auth.welcomeBack": "Welcome back",
  "auth.signIn": "Sign in",
  "auth.signingIn": "Signing in...",
  "auth.email": "Email",
  "auth.password": "Password",
  "auth.createAccount": "Create account",
  "auth.noAccount": "Don't have an account?",
  "auth.haveAccount": "Already have an account?",
  "auth.register": "Register",
  "auth.registering": "Creating account...",

  "forgot.link": "Forgot your password?",
  "forgot.title": "Reset your password",
  "forgot.subtitle": "We'll email you a code to set a new one.",
  "forgot.sendCode": "Send code",
  "forgot.sending": "Sending...",
  "forgot.sent": "If this email has an account, we've sent it a code. The code works for 30 minutes.",
  "forgot.code": "Code from the email",
  "forgot.newPassword": "New password",
  "forgot.confirmPassword": "Confirm new password",
  "forgot.submit": "Save new password",
  "forgot.submitting": "Saving...",
  "forgot.done": "Password changed. You can sign in now.",
  "forgot.backToSignIn": "Back to sign in",
  "forgot.tooShort": "At least 8 characters.",
  "forgot.mismatch": "Passwords don't match.",

  "verify.title": "Check your email",
  "verify.sentTo": "We sent a code to {email}",
  "verify.code": "Confirmation code",
  "verify.confirm": "Confirm",
  "verify.confirming": "Confirming...",
  "verify.resend": "Send the code again",
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
  "dash.noSubscription": "No active plan",
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
    "You manage this plan where you bought it. Sign in there to renew it. After you renew, it shows here again.",
  "dash.renewCta": "Renew plan",
  "dash.noPlanStore": "Your account is ready. When a plan is added to it, the plan shows here and you can connect.",

  "plans.title": "Choose a plan",
  "plans.subtitle": "Pick a plan to start connecting.",
  "plans.subtitleActive": "Buy another plan or use a voucher.",
  "plans.crypto": "Crypto",
  "plans.card": "Card",
  "plans.loading": "Loading plans...",
  "plans.none": "No plans are available right now. Check again later.",
  "plans.waiting": "Waiting for payment",

  "auth.referralCode": "Referral code (optional)",
  "auth.referralCodeHint": "From a friend who invited you",
  "update.downloading": "Downloading Neoxify {version}...",
  "update.downloadingPercent": "Downloading Neoxify {version} ({percent}%)",
  "update.ready": "Neoxify {version} is ready to install.",
  "update.restart": "Restart now",
  "update.restarting": "Restarting...",
  "update.connectedFirst": "Disconnect before updating.",
  "update.androidAvailable": "Neoxify {version} is available",
  "update.androidHint": "It downloads in your browser. Android asks before installing it. Your settings and sign-in are kept.",
  "update.androidDownload": "Download",
  "update.androidOpenFailed": "The download didn't open. Try again.",
  "dash.customModeDetached": "Connected, but Custom mode didn't start. The apps you chose are going out without protection.",
  "dash.unlimited": "Unlimited",
  "support.title": "Support",
  "support.subtitle": "Write to us and we'll answer as soon as we can.",
  "support.new": "New message",
  "support.newTitle": "What do you need help with?",
  "support.subject": "Subject",
  "support.subjectHint": "A few words, e.g. \"Can't connect on Stealth\"",
  "support.message": "Message",
  "support.messageHint": "Tell us what happened and what you already tried.",
  "support.send": "Send",
  "support.sending": "Sending...",
  "support.reply": "Write a reply",
  "support.replyWithin": "We usually reply within {hours} hours.",
  "support.replyWithinDay": "We usually reply within a day.",
  "support.closed": "Support isn't taking new messages right now. Try again later.",
  "support.closedTitle": "Not taking new messages",
  "support.empty": "No conversations yet.",
  "support.emptyHint": "Messages you send show up here.",
  "support.you": "You",
  "support.team": "Support",
  "support.statusOpen": "Waiting for a reply",
  "support.statusAnswered": "Replied",
  "support.statusResolved": "Resolved",
  "support.unread": "New reply",
  "support.notLive": "This isn't a live chat. You can close the app. Our reply will show up here and in your email.",
  "referrals.title": "Invite friends",
  "referrals.subtitle": "Share your code and get free days of Neoxify.",
  "referrals.off": "Inviting friends isn't available right now.",
  "referrals.yourCode": "Your referral code",
  "referrals.rule": "Get {days} free days when one friend pays for {months} months, or {friends} friends pay for {each} months each.",
  "referrals.copy": "Copy",
  "referrals.copied": "Copied",
  "referrals.progress": "Next free month",
  "referrals.monthsToGo": "{count} paid months to go",
  "referrals.almost": "Ready on the next check",
  "referrals.progressHint": "Most paid by one friend so far: {best} months. Friends who qualify: {qualifying}.",
  "referrals.friends": "Friends you invited",
  "referrals.friendsHint": "Email addresses are partly hidden for privacy.",
  "referrals.noFriends": "No one yet. Share your code with friends.",
  "referrals.joined": "Joined",
  "referrals.pending": "Not activated",
  "referrals.paidMonths": "{count} paid months",
  "referrals.earned": "Free time you've earned",
  "referrals.freeDays": "{days} free days",
  "nav.referrals": "Invite friends",
  "settings.title": "Settings",
  "settings.subtitle": "Manage your account.",
  "settings.language": "Language",
  "settings.languageHint": "The change applies right away.",
  "settings.deleteAccount": "Delete account",
  "settings.deleteAccountHint": "Deletes your account and everything in it for good.",
  "settings.deleteWarning": "This can't be undone. Your account, your connection details on every server and any time left on your plan are deleted right away. Invoices are kept for tax reasons, without your personal details.",
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
  "settings.passwordChanged": "Password changed. Your other devices were signed out.",
  "settings.changing": "Changing...",
  "settings.tooShort": "At least 8 characters.",
  // The ping sentence is here for the same reason the IPv6 one is: it is
  // true of Custom mode always rather than news about this session, and
  // the counter that records it climbs from the first second, so a
  // warning keyed on it would be permanently lit and therefore unread.
  //
  // It says "every app on this computer" because that is the truth and
  // the narrower claim would be a lie. Nothing can tell which program
  // sent a ping -- there is no port on one and Windows keeps no ICMP
  // equivalent of the TCP and UDP endpoint tables -- so the block cannot
  // be narrowed to the chosen apps. See `redirect::icmp_echo_request`.
  "dash.customActive":
    "Custom mode: only the apps you chose go through the VPN. Their IPv6 is blocked instead of going outside the VPN, so sites that only have IPv6 won't open for them. Ping is blocked too, for every app on this computer, because the VPN can't carry it and it would show your real address to every server your games ping. In-game ping and latency numbers won't work while this is on.",
  // The full-tunnel counterpart of the line above, and deliberately the
  // same shape of sentence: what is blocked, why, and what the customer
  // will notice. It is shown whenever the service reports a block is
  // actually installed -- never inferred from the protocol -- because
  // this is a promise about the machine's state and the app does not
  // make those without evidence.
  "dash.fullTunnelIpv6Blocked":
    "IPv6 is blocked while you're connected. Neoxify's servers only carry IPv4, so IPv6 is stopped on this device instead of going around the VPN. Sites that only have IPv6 won't open until you disconnect.",
  // Shown when the app's own check finds IPv6 still reaching the
  // internet while connected. That is the leak this release exists to
  // close, so the wording says "not protected" without hedging: the
  // customer's IPv4 may well be tunnelled, and their IPv6 is not.
  "dash.ipv6Escaping":
    "Some of your traffic is going out over IPv6, outside the VPN, and your network can see your IPv6 address. Disconnect and connect again. If it keeps happening, contact support.",
  // Shown when an engine asked for the tunnel's DNS rule and the service
  // could not install it. The tunnel is up and carrying traffic, so the
  // wording must not read as "you are not connected" -- and the lookups
  // are not pinned to it, so it must not read as "you are protected"
  // either. Both halves are stated, in that order, because a customer in
  // Iran who reads only the first line still has to come away knowing
  // which part is not covered.
  "dash.tunnelDnsUnforced":
    "Your traffic is going through the VPN, but Neoxify couldn't send this device's DNS lookups through it. Your internet provider's DNS can still answer them, and on a filtered network those answers are often wrong, so some sites may not open. Disconnect and reconnect to try again. If it keeps happening, use Repair network.",
  // Shown when a full tunnel on Stealth or Compatible is up and Neoxify
  // could not stop connections going around it on this computer (the
  // service's `ipv4_confined: false` -- the owner's decision (d)). The
  // rest of this computer's connections are not held to the tunnel, so it
  // must not read as "protected". What is not covered is said plainly:
  // programs that send straight over the network, and connections opened
  // before Connect. Nothing about the tunnel itself carrying traffic: the
  // line shows in "not confirmed" and "not carrying traffic" too, where
  // the headline says that part. Never shown in Custom mode or on WireGuard (its own
  // kill switch does this); Built-in has a line of its own below.
  "dash.ipv4NotConfined":
    "Neoxify couldn't stop other connections on this computer from going around the VPN. Your network may still see programs that send straight over it, and connections opened before you connected. Disconnect and connect again. If it keeps happening, contact support.",
  // The same line for Built-in (IKEv2), which is not confined by choice
  // in this version: its plan waits on its own proof, so reconnecting
  // changes nothing, and the way to full protection is another protocol.
  // The service says so with `ipv4_confined: false` (unconfinedLine).
  "dash.ipv4NotConfinedIkev2":
    "Built-in uses this device's own VPN, and Neoxify can't yet stop other connections on this computer from going around it. Your network may still see programs that send straight over it, and connections opened before you connected. For full protection, use another protocol.",
  // Shown when the customer selected an application that was already
  // open. Custom mode routes the connections a program makes *after* it
  // is selected; the ones it already held cannot be moved, because a
  // live TCP connection is a socket to the real destination and
  // rewriting half of one breaks it rather than redirecting it.
  //
  // Both halves are stated, in that order, and the wording deliberately
  // does not round either of them off. "Some of its traffic is already
  // going through" would be reassurance the app cannot back up, and
  // saying only "restart it" would imply nothing is routed until they
  // do. What is covered and what is not are the two facts a customer
  // needs in order to decide whether to bother.
  // Custom mode's own counters, as the service codes them
  // (lib/custom-mode-problem.ts); the service's English sentence is the
  // fallback for a code this app does not know.
  "dash.customProblemInjectionRefused":
    "Windows is refusing the redirected packets, so the apps you chose aren't reaching the VPN. Restarting Neoxify usually fixes this.",
  "dash.customProblemNoReplies":
    "The apps you chose are being sent through the VPN, but nothing is coming back, so their connections will hang. The VPN isn't carrying their traffic.",
  "dash.customProblemNoAppTraffic":
    "None of the apps you chose has sent any traffic. If one of them is running, the wrong program may have been picked. Some apps run under a different program file.",
  "dash.customProblemAdapterGone":
    "The VPN adapter Custom mode was using disappeared, so Custom mode stopped and the apps you chose are using your normal connection. Connect again to protect them.",
  "dash.splitTunnelRestartNeeded":
    "{apps} was already open when you chose it. New connections it makes go through the VPN, but the ones it already had don't, because moving them would break them. Close it and open it again to send all of its traffic through the VPN.",
  "voucher.title": "Have a voucher?",
  "voucher.subtitle": "Enter a code to get a plan without paying.",
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
  "settings.customHint": "Choose which apps use the VPN and which keep your normal connection. This is still new, so tell us if something looks wrong.",
  "settings.customOn": "On",
  "settings.customOff": "Off",
  "settings.customAddApp": "Add an app",
  "settings.customNoApps": "No apps chosen yet, so nothing goes through the VPN. Add one to start.",
  "settings.customRemove": "Remove",
  "settings.customApplies": "Applies from your next connection.",
  "settings.customFailOpen": "While the app switches servers, the apps you chose briefly use your normal connection instead of stalling.",
  // Stated on the card that turns the feature on, because it is a cost
  // of turning it on and the customer should meet it there rather than
  // discover it as a broken ping display mid-game.
  //
  // Deliberately explicit that this is not per-app. The block cannot be
  // narrowed to the chosen programs: nothing can attribute a ping to a
  // program, so narrowing it is not a thing that was skipped, it is a
  // thing that does not exist. Saying "your chosen apps' ping" would be
  // a smaller and false claim.
  "settings.customIcmpTitle": "Ping stops working while Custom mode is on",
  "settings.customIcmpBody":
    "The VPN can't carry ping, so Neoxify blocks ping for every app on this computer instead of letting it go around the VPN. Otherwise it would show your real address to every server it reached, and any latency number would measure your normal connection, not Neoxify. Games that show a ping number will show nothing or an error while this is on.",
  "settings.customTooMany": "You can choose up to {max} apps.",
  "settings.customAlready": "That app is already on the list.",
  "settings.customModeOnly": "Only these apps",
  "settings.customModeExcept": "All except these",
  "settings.customModeOnlyHint": "Only the apps you choose go through the VPN. Everything else uses your normal connection.",
  "settings.customModeExceptHint": "Everything goes through the VPN except the apps you choose.",
  "settings.customNoAppsExcept": "No apps chosen yet, so everything goes through the VPN. Add an app to leave it out.",
  "settings.customPickRunning": "Choose from running apps",
  // Also the filter label in the native Windows file dialog, which is why
  // it exists as a key at all -- it was hardcoded English, so a Persian
  // customer clicked a Persian button and got an English dropdown.
  "settings.customFileFilter": "Programs",
  "settings.customPickFile": "Browse for a program",
  "settings.customRunningTitle": "Running apps",
  "settings.customRunningEmpty": "Nothing to show. Try browsing for the program instead.",
  "settings.customSearchEmpty": "No app matches that.",
  "settings.customAppParts": "{count} programs, sent through the VPN together",
  "settings.customRunningRefresh": "Refresh",
  "settings.customCancel": "Cancel",
  "settings.customAppUsesVpn": "Uses VPN",
  "settings.customAppBypasses": "Bypasses VPN",
  // Adding a game by name. The value is that Neoxify knows which
  // programs a game needs and the customer does not: choosing one
  // executable and getting half a product is a failure already on the
  // record here.
  //
  // What it can honestly do is bounded, and every string below is
  // bounded the same way. A program is added only when it is running,
  // because that is the only way this side learns its real path --
  // there is no filesystem search here, and the split tunnel matches on
  // the full path rather than the filename. That is deliberate: a
  // filename match is what lets any program called VALORANT.exe be
  // routed as VALORANT.
  "settings.customPickGame": "Add a game",
  "settings.customGameTitle": "Add a game's programs",
  // Not "Neoxify knows which programs each game uses". It does not know:
  // the list is harvested from publisher metadata and none of it has been
  // checked against a running install. The picker says so too, and the two
  // strings sit on the same card, so they must not contradict each other.
  "settings.customGameHint":
    "Neoxify has a list of the programs each game is expected to use. Start the game or its launcher first. Neoxify adds the programs it can see running, by their full path.",
  "settings.customGameParts": "{count} programs",
  "settings.customGameAdded": "Added {count} of {total} programs for {game}.",
  "settings.customGameMissing":
    "These weren't running, so they weren't added: {names}. Start them and add the game again, or use Browse.",
  // Said when a game the customer was told was incomplete stops being
  // incomplete. The card carried a warning naming the missing programs
  // for as long as they were missing; going quiet the moment it is
  // fixed would leave that warning as the last thing they were told.
  "settings.customGameCompleted":
    "{game} is complete now. Neoxify found {names} running and added it, so the whole game goes through together.",
  // Only when an exit was actually chosen. A group with no preference
  // gains nothing to announce, and saying an exit now applies when none
  // was picked would be a claim about routing that is not true.
  "settings.customGameCompletedExit": "The exit you chose for {game} applies from the next connection.",
  // The cap, reached by the re-scan rather than by a click. Nothing was
  // added for this game on purpose: adding the binaries that fit is how
  // a game ends up split across the tunnel and outside it.
  "settings.customGameRescanTooMany":
    "{game} is still incomplete. Adding {names} would go over the {max}-program limit, so nothing was added for it, because adding only part of a game isn't worth it. Remove a program to make room.",
  // A game that resolved *nothing*, kept on screen rather than said once.
  //
  // The old sentence here was honest about the outcome and wrong about
  // the remedy: it said "start the game and add it again", which is
  // useless advice when the game is already running and the catalogue is
  // naming programs that do not exist on this machine. That is not
  // hypothetical -- Old School RuneScape's row named the two executables
  // from Valve's appinfo for the Steam build, and Jagex's own installer
  // ships JagexLauncher.exe instead, so a customer with the game open in
  // front of them could add it forever and route nothing.
  //
  // So it now names what it looked for. A customer who can see that the
  // names are not their game's can stop trying and use the working path,
  // and it is the one piece of information that turns a dead end into a
  // bug report worth having.
  "settings.customGameNone": "Nothing was added for {game}",
  "settings.customGameNoneBody":
    "Neoxify looked for these programs and none of them is running: {names}. If {game} is running right now, this list doesn't match the way you installed it. Neoxify's names come from the Steam version, and other installers use different ones. Use \"Choose from running apps\" and pick it yourself. That adds it properly.",
  "settings.customGameNoneAction": "Choose from running apps",
  "settings.customGameEmpty": "Neoxify has no program list for any game.",
  // A game that is only partly added, said again and kept on screen.
  //
  // `customGameMissing` above says it once, in the notice, at the moment
  // the game is added -- and the customer who added a game from its
  // launcher screen is exactly the customer who scrolled past that
  // sentence and never saw it again. This one stays.
  //
  // It is not a tidiness message. A program that is not on the list is
  // not carried, so when it starts it reaches the game's servers from
  // the customer's own address while the rest of the game reaches them
  // through the tunnel: one account, two source addresses, at the same
  // instant. `docs/design/ban-safety.md` mechanism 4 -- the one failure
  // this product could manufacture rather than merely fail to prevent.
  //
  // Written as what happens, not as a warning about what might. The
  // customer is told the mechanism because the mechanism is what tells
  // them which of the two fixes to reach for.
  "settings.customGameSplit": "Only part of {game} is added",
  "settings.customGameSplitBody":
    "Not added: {names}. These keep your normal connection, so if one starts while the rest of {game} goes through Neoxify, the game reaches its servers from two addresses at once. Game publishers treat that as account sharing. Start every part of the game, then add it again.",
  // Why a game did not get the exit it was given.
  //
  // Both are inert on today's data, in the way `customGameScoped` is:
  // no screen sets a per-game exit yet. They exist so that whoever
  // builds that picker cannot ship a silently withheld preference,
  // which would be the app deciding something on the customer's behalf
  // and not saying so.
  "settings.customGameExitPartial":
    "{game} uses the same exit as the rest of your traffic. Not all of its programs are added ({names}), and Neoxify won't put part of a game on an exit of its own.",
  "settings.customGameExitConflict":
    "{game} and {others} run the same program, so they can't use different exits. Until you set them to the same exit, both use the same exit as the rest of your traffic.",
  // The ceiling, said in the units the customer chose in: games, not
  // programs. Every game is named rather than only the ones past the
  // limit, because nothing here chose which ones those would be -- see
  // `exitsForGames` rule 4 for why trimming is refused.
  "settings.customGameExitOverCeiling":
    "{game} uses the same exit as the rest of your traffic. You chose {chosen} different exits, and Neoxify can use {limit} at once. Set some of your games to share an exit, and they will all move to the exits you picked.",
  // The picker itself.
  //
  // Two things it has to say and cannot leave to be inferred:
  //
  // * an exit is not a server. Two of the servers in the location list
  //   can be one exit -- the fast one and the stealthy one on the same
  //   machine, or a relay whose far end is a machine you can also reach
  //   directly -- and a customer who thinks they have spread two games
  //   across two places has spread nothing.
  // * only one is live at a time. This is a preference applied when you
  //   connect, not two connections at once, and a screen that let that
  //   be assumed would be selling something the product cannot do.
  "settings.customExitTitle": "Where each game connects from",
  "settings.customExitHint":
    "Choose the place each game appears to connect from. Some servers in your list share an exit, so they appear here once.",
  "settings.customExitFor": "Exit for {game}",
  "settings.customExitNone": "Same as the rest of your traffic",
  // A relayed route is dialled at one machine and leaves from another,
  // so the name in the location list is the entry and says nothing
  // about where this traffic appears from. Neoxify does not publish
  // which server backs a relay's exit -- a fleet that can be listed is
  // a fleet that gets labelled as a VPN, and ours is not listed. So the
  // honest label is what it is reached through, and no claim about
  // where it is.
  "settings.customExitHidden": "Exit reached through {via}",
  "settings.customExitDown": "(not reachable right now)",
  "settings.customExitGone": "The exit you chose, which isn't available now",
  // Shown on an exit that would be a fourth. The label is kept so the
  // customer can still see which exit it is -- the limit is the reason
  // it cannot be picked, not a reason to hide what it was.
  "settings.customExitAtLimit": "{label} (the limit is {limit} exits at once)",
  // The four answers. The fourth is the one that earns its place: with
  // nothing being carried there is no match and no mismatch, and saying
  // either would be the same as a "Connected" indicator nothing
  // checked.
  "settings.customExitOnPreferred": "On your exit",
  "settings.customExitFallback": "On another exit",
  "settings.customExitUnknown": "Not established",
  "settings.customExitNoPreference": "No preference",
  "settings.customExitUnknownHint":
    "Neoxify only says where a game connects from while it is actually carrying that game's traffic. Connect, start the game and come back.",
  "settings.customExitFallbackHint":
    "{game} is going through the exit this connection uses, not the one you chose. It still works. To move it, change the server on the main screen and connect again.",
  // Replaced "one connection leaves from one exit", which stopped
  // being true for the Xray-carried protocols when the engine learned
  // to run several tagged inbounds. Kept as two sentences in two
  // strings because they are two different facts and a customer needs
  // both: how many, and on what.
  "settings.customExitConcurrent":
    "Up to {limit} games can use {limit} different exits at the same time. A game without a chosen exit, and everything else you send through the VPN, uses the same exit as the connection itself.",
  "settings.customExitXrayOnly":
    "This needs one of the Xray protocols. On WireGuard, OpenVPN or IKEv2, one connection has one exit, so every game uses that exit. Neoxify shows this on the game's row.",
  // Destination scoping, said out loud in both directions.
  //
  // "Uses VPN" is now two different promises and the customer cannot
  // tell which one they got by looking. Someone whose game is scoped
  // will open its launcher, see their real IP, and conclude the feature
  // is broken -- so the narrower promise has to be the one that is
  // stated, not the one that is inferred.
  //
  // The second string is the more important one. It is what an
  // incomplete address list produces, it is the common case today, and
  // "the whole application is carried" is a bigger claim than "only its
  // servers are" -- overstating it is the kind of quiet inaccuracy this
  // app exists to refuse.
  "settings.customAppScoped": "Game servers only",
  "settings.customAppScopedHint":
    "Only this program's traffic to the game's own servers goes through the VPN. Everything else it does keeps your normal connection.",
  "settings.customGameScoped":
    "Only {game}'s traffic to its own game servers goes through the VPN. Everything else it does keeps your normal connection.",
  // No "yet". A complete publisher address list was measured to be
  // unbuildable -- the account surface lives outside the publisher's own
  // ASN for every publisher checked -- so this is what the product does,
  // not a stage it is passing through.
  "settings.customGameWholeApp":
    "Everything these programs do goes through the VPN. Neoxify doesn't have a complete list of this game's server addresses, and sending only part of them is worse than sending none.",
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
  "dash.offlineTitle": "Can't reach Neoxify right now. You can still connect.",
  // Shown instead while the load is still waiting, past the point where it
  // used to give up: nothing has answered yet, and it has not stopped.
  "dash.offlineTrying": "Still trying to reach Neoxify. You can connect with your saved servers in the meantime.",
  // Shown instead when the load was answered, with an error: Neoxify, or
  // something in front of it, did reply. The error follows on its own line.
  "dash.offlineAnswered": "Neoxify couldn't load your account just now. You can still connect.",
  "dash.offlineHint":
    "Using your saved servers. Data usage and expiry were last updated {when} and may be out of date.",
  "dash.androidWireguardOnly":
    "{protocol} isn't available in the mobile app, so it will connect with Fast instead.",
  "settings.customAllApps": "No apps chosen yet, so every app uses the VPN. Choose an app to send only that app through it.",
  "settings.customHintNative": "Send only the apps you choose through the VPN. Everything else uses your normal connection.",
  "settings.customSearch": "Search apps",
  "settings.customNoMatches": "No apps match that.",
  "settings.customClear": "Clear selection",
  "settings.mismatch": "Passwords don't match.",

  "dash.subscription": "Plan",
  "dash.retry": "Retry",
  "dash.loadFailed": "Couldn't load your account.",
  "dash.changeLocation": "Change location",
  "dash.status.active": "ACTIVE",
  "dash.server": "Server",
  "dash.protocol": "Protocol",
  "dash.session": "Session",
  "dash.daysLeft": "days left",
  "dash.change": "Change",
  "dash.disconnectToChange": "Disconnect first to change server or protocol",
  "dash.protected": "You're protected",
  "dash.protectedHint": "Your traffic is encrypted and goes through Neoxify.",
  // The headline over a full tunnel whose IPv4 confinement did not go in
  // (`warnsUnconfined`): the tunnel carries traffic and was verified, and
  // "You're protected" would still be more than is true. The line under
  // the orb (`dash.ipv4NotConfined`) says what is not covered.
  "dash.connectedNotConfined": "Connected, not fully protected",
  "dash.connectedNotConfinedHint": "Your traffic goes through Neoxify, but some connections on this computer may still go around it.",
  "dash.notProtected": "You're not protected",
  "dash.notProtectedHint": "Connect to encrypt your traffic and hide your IP.",
  // A tunnel the screen was vouching for closed without anyone asking.
  // "You're not protected / Connect to encrypt..." above is written for
  // somebody who has not connected yet; this is somebody whose traffic
  // was protected a second ago and is not now. Measured on 2026-10-06:
  // the engine died, traffic went out direct in 0.2s, and the screen said
  // "You're protected" for another 17 seconds. It now says this instead,
  // within about a second. Since 2026-10-07 the app reconnects by itself
  // first (auto-reconnect.ts, and the "dash.reconnecting" lines below);
  // these are the words once it has stopped trying -- or when it was
  // never going to, after a sign-out or the device limit -- so they
  // still promise nothing and ask for the press.
  "dash.dropped": "VPN connection lost",
  "dash.droppedHint":
    "The VPN connection closed. Your traffic is now going out without Neoxify and is not protected. Connect again to protect it.",
  // The automatic reconnect after a drop, while it runs. Fail-open is
  // unchanged -- nothing is blocked while the tunnel is down -- so the
  // hint has to say what that means for the customer's traffic in the
  // meantime, in the same plain words as the line above. Never a
  // reassurance: "protected" only comes back once the new tunnel has
  // been proven exactly as a manual connect is.
  "dash.reconnecting": "Reconnecting...",
  "dash.reconnectingHint":
    "The VPN connection closed. Until it's back, your traffic goes out without Neoxify and is not protected.",
  // No network at all: nothing is tried until one comes back, and the
  // customer is told that rather than watching attempts fail.
  "dash.reconnectingOfflineHint":
    "The VPN connection closed and there's no network. Neoxify will connect again when the network is back. Until then, your traffic is not protected.",
  // The service found no network to dial over, before dialling anything
  // (network-wait.ts): the pass waits for one on the same server instead of
  // walking the list, and says so. Nothing about a server -- none was
  // dialled -- and, fail open being unchanged, nothing protected until the
  // tunnel is up. Also the headline of a reconnect waiting for a network.
  "dash.waitingForNetwork": "Waiting for a network connection",
  "dash.waitingForNetworkHint":
    "This computer isn't connected to a network. Neoxify will connect as soon as it is. Until then, your traffic is not protected.",
  // The orb between attempts: the customer's own connect, now, instead of
  // waiting for the next attempt.
  "dash.reconnectNow": "Reconnect now",
  "dash.reconnectStop": "Stop reconnecting",
  "dash.degraded": "Not carrying traffic",
  "dash.degradedHint": "The VPN connection is up, but the server isn't answering. Your traffic is not protected. Connect again or choose another server.",
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
    "The VPN connection is up and nothing shows a problem, but Neoxify couldn't confirm that your traffic is going through it. Connect again if you need to be sure.",
  // Custom mode is a narrower claim and gets a narrower sentence: the
  // question there is not whether this machine is tunnelled but whether
  // the apps you chose are, and those are genuinely different facts.
  "dash.unverifiedCustomHint":
    "Custom mode is on and the VPN connection is up, but Neoxify couldn't confirm that the apps you chose are reaching the server. Connect again if you need to be sure.",
  "dash.verifying": "Checking connection...",
  "dash.verifyingHint": "Setting up your connection. Neoxify tries each protocol until one works. Click to stop.",
  // The phone's words for the two sentences that speak of a computer and
  // a click (design-system.md 3.3).
  "dash.verifyingHintPhone": "Setting up your connection. Neoxify tries each protocol until one works. Tap to stop.",
  "dash.waitingForNetworkHintPhone":
    "This device isn't connected to a network. Neoxify will connect as soon as it is. Until then, your traffic is not protected.",
  // The phone's VPN consent dialog was declined. Said rather than
  // swallowed: a refusal looks exactly like a failed connect.
  "dash.vpnPermissionDenied": "Android needs your permission to create a VPN connection. Tap Connect again and choose OK.",
  // The same on an iPhone or iPad, whose prompt adds a VPN configuration
  // and whose button is "Allow".
  "dash.vpnPermissionDeniedIos": "iOS needs your permission to add a VPN configuration. Tap Connect again and choose Allow.",
  // Said when the helper service cannot be reached, which is a different
  // thing from the tunnel being down and must not borrow its words. The
  // screen used to answer this case with "You're not protected", over a
  // tunnel that was live -- someone who believes that goes and does
  // something they would not have done otherwise.
  "dash.unknown": "Can't tell right now",
  "dash.unknownHint":
    "The Neoxify service isn't answering, so the app can't tell whether you're protected. It keeps checking. Until the service answers, don't assume either way.",
  "dash.recheck": "Check status",
  "dash.switchedTo": "Your usual protocol didn't get through. Now using {protocol}",
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
  // The pass started with no network at all -- the service found no
  // connection with a gateway to dial over -- and landed once one came
  // back. The server on screen was never dialled, so it is not blamed; and
  // "your usual protocol didn't get through" would be the same claim about
  // a protocol. Seen on the VM with the network adapter switched off
  // mid-connect: "Couldn't reach fi-finland" about a server nothing had
  // asked (failover-notice.ts).
  "dash.switchedNoNetwork": "No network connection at first, so {from} wasn't tried. Now on {to} over {protocol}",
  "dash.switchedToNoNetwork": "No network connection at first. Now using {protocol}",
  // The pass stayed in the country and nothing it tried was dialled and
  // failed -- it landed at once on a route other than the one on screen,
  // or every failure came before anything was dialled. Only where the
  // connection is: "didn't get through" would be a claim nothing made
  // true (failover-notice.ts).
  "dash.nowUsing": "Now using {protocol}",
  "dash.yourIp": "Your IP:",
  "err.serviceUnavailable": "The Neoxify background service isn't running. Restarting the app usually fixes this. If it doesn't, reinstall Neoxify.",
  "err.engineMissing": "Part of the installation is missing. Reinstall Neoxify.",
  "err.serverUnreachable": "Couldn't reach this server. Your network may be blocking it. Try another location.",
  "err.notCarryingTraffic": "Connected, but no traffic got through.",
  "err.allProtocolsFailed": "Neoxify tried every available protocol, and none of them carried traffic.",
  // The phone's automatic reconnect passes over a protocol it may not dial
  // without the customer -- iOS's IKEv2, whose configuration asks before it
  // is installed -- so "every available protocol" would not be true.
  "err.someProtocolsNotTried":
    "None of the protocols tried carried traffic. Some are tried only when you press Connect.",
  // An iPhone's automatic reconnect that stops before its last protocol
  // because the VPN configuration could not be read: the rest were not
  // dialled, and the next attempt, or Connect, will dial them.
  "err.notEveryProtocolTried": "None of the protocols tried carried traffic. The others were not tried this time.",
  "err.concurrentLimit": "Your plan's device limit is already in use. Disconnect another device and try again.",
  "err.quotaExhausted": "You've used all the data on your plan. Upgrade or wait for it to renew.",
  "err.subscriptionInactive": "Your plan isn't active right now. Check it on the main page.",
  "err.teardownStuck":
    "The VPN connection is still closing. If your internet stays down, close the app and open it again.",
  // Said out loud rather than left as a dead button. This press started
  // nothing, and it deliberately names no server -- nothing was dialled,
  // so there is nothing to report about one.
  "err.connectBusy": "Neoxify is already trying to connect. Wait a moment, then try again.",
  // The service found no network connection with a gateway to dial over:
  // nothing was dialled, so no server is named and none is blamed.
  "err.noNetwork": "No network connection. Check that this device is online, then try again.",
  "err.unknown": "Couldn't connect.",
  "err.showDetail": "Technical details",

  // Device slots: the plan's device limit is how many devices may use
  // the VPN at the same time (docs/device-slots.md). Worded from the
  // limit and the devices, never from the server's English `message`.
  // Plain and factual: a refusal is the plan working as sold, not an
  // error, and the customer has a one-press way through it.
  "slots.limitOne": "Your plan allows 1 device at a time.",
  "slots.limitMany": "Your plan allows {limit} devices at a time.",
  "slots.inUseOn": "Neoxify has been in use on {device} since {time}.",
  "slots.inUseOnNoTime": "Neoxify is in use on {device}.",
  "slots.inUseOnMany": "Neoxify is in use on {devices}.",
  "slots.deviceSince": "{device} (since {time})",
  "slots.anotherDevice": "another device",
  "slots.useHere": "Use on this device instead",
  "slots.cancel": "Cancel",
  "slots.dismiss": "Dismiss",
  // "Disconnected:" only once the service has confirmed the tunnel is
  // down; until then the second form, which claims nothing about it.
  "slots.displaced": "Disconnected: Neoxify is now in use on {device}.",
  "slots.nowInUseOn": "Neoxify is now in use on {device}.",
  "slots.takeoverLimit": "You've switched devices too many times in the last hour. Try again in {minutes} min.",
  // The device limit ended this device's session, and the teardown that
  // followed has not been confirmed: the tunnel was still up, or the
  // service could not say. Worded for both -- it claims only that the
  // closing is unconfirmed -- and true while the app keeps trying, which
  // it does on every poll until the tunnel is confirmed down.
  "slots.teardownStuck":
    "Your plan can't be used on this device right now. Still disconnecting, and it isn't confirmed yet that the VPN connection has closed.",
  // A degraded tunnel on a device whose slot was never confirmed, when
  // the check got no verdict. Both name the limit as a possibility,
  // never as the cause. The first only when nothing came back at all (no
  // answer in time, or no answer anywhere); the second when Neoxify did
  // answer -- an error, a throttle, something this app cannot read --
  // and so was reached, and only did not confirm anything.
  "slots.unchecked":
    "Couldn't reach Neoxify to check. If you're using Neoxify on another device, your plan's limit of {limit} at a time may be the reason.",
  "slots.unconfirmed":
    "Neoxify couldn't confirm this device's place on your plan right now. If you're using Neoxify on another device, your plan's limit of {limit} at a time may be the reason.",
  // A device the server names by its kind alone (its `platform`, with no
  // model or name of its own), as {device} in the sentences above. The
  // kind is named here, in the reader's language, never by the device
  // that is being named -- it may be in another one.
  "slots.platformWindows": "a Windows PC",
  "slots.platformMac": "a Mac",
  "slots.platformLinux": "a Linux PC",
  "slots.platformAndroid": "an Android phone",
  "slots.platformIos": "an iPhone",

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
  "repair.title": "Repair network",
  "repair.subtitle": "Remove anything Neoxify has left behind on Windows.",
  "repair.explain":
    "Neoxify finds and removes VPN engines left running, the DNS rule it sets while you're connected, routes on its own network adapters, its firewall rule, a leftover WireGuard tunnel service and its entry in Windows' VPN list. Then it clears the DNS cache.",
  "repair.disconnects": "If you're connected, this disconnects you first.",
  // The fail-open promise, said out loud. Somebody in Iran deciding
  // whether to press a button labelled "repair" on the machine they use
  // to get online deserves to know it cannot lock anything down.
  "repair.safety":
    "It only removes things. It never blocks traffic, and it doesn't touch your normal internet settings.",
  "repair.run": "Repair now",
  "repair.running": "Repairing...",
  "repair.runAgain": "Repair again",
  "repair.resultClean": "Nothing was left behind. Your network settings are as Windows set them.",
  "repair.resultFixed": "Repaired. Try connecting again.",
  // Good news with a caveat, not bad news. Every check that finished
  // succeeded; one could not finish, which says nothing either way.
  // Worded so it never claims the repair failed -- that is a state
  // nothing here verified. See `indeterminateSteps` in lib/repair.ts.
  "repair.resultUnverified":
    "Repaired, but one check couldn't finish, so the result can't be confirmed. This usually just means the computer was slow. Try connecting again. If it still doesn't work, run the command below as an administrator and send us what it prints.",
  "repair.resultProblems":
    "Some of it couldn't be repaired. Restarting Windows usually clears the rest. If it doesn't, run the command below as an administrator and send us what it prints.",
  "repair.failed": "The repair couldn't run.",
  "repair.stepClean": "Nothing found",
  "repair.stepFixed": "Removed",
  "repair.stepFailed": "Still there",
  "repair.stepUnknown": "Couldn't check",
  "repair.step.tunnel": "VPN connection and Custom mode",
  "repair.step.engines": "Leftover VPN engines",
  "repair.step.dns": "VPN DNS rule",
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
  "repair.inlineCta": "If you still can't connect, repair your network",

  // The diagnostics snapshot, in Support.
  "diag.title": "Details for support",
  "diag.subtitle":
    "A short summary of Neoxify's state on this computer. Paste it into your message so we can see what you see.",
  "diag.collect": "Collect details",
  "diag.collecting": "Collecting...",
  "diag.copy": "Copy",
  "diag.copied": "Copied",
  // Said plainly, because a customer in Iran being asked to paste
  // something about their machine into a chat is right to want to know
  // what is in it.
  "diag.privacy":
    "It has no passwords, keys or server details, and nothing about the sites you visit. You can read all of it before sending.",
  "diag.failed": "The Neoxify service isn't answering, so there's nothing to collect.",

  "plans.back": "Back",
  "plans.perDays": "for {days} days",
  "plans.data": "Data",
  "plans.speed": "Speed",
  "plans.devices": "Devices",
  "plans.unlimited": "Unlimited",
  "plans.buyWithAppStore": "Buy with App Store",
  // Not an error, and worded so it does not read as one: this is what a
  // customer sees while the products are still pending review in App
  // Store Connect.
  "plans.noneAvailable": "No plans are available to buy here right now. Check again later.",
  "plans.upTo": "Up to {n} Mbps",
  "plans.devicesAtOnce": "{n} at once",
  "plans.bestValue": "Best value",
  "plans.payWith": "Pay with",
  "plans.amount": "Amount",
  "plans.toAddress": "To this address",
  "plans.openCheckout": "Open payment page",
  "plans.copied": "Copied",
  "plans.browserFailed": "Couldn't open your browser. Use the button below to try again.",
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
  // The same mode's line while the tunnel is up and its IPv4 is not
  // confined to it (`warnsUnconfined`): what the mode is for, and that it
  // does not hold right now -- beside the warning that says why, rather
  // than contradicting it.
  "dash.modeVpnHintNotConfined": "This mode sends everything on this computer through Neoxify, but right now some connections may go around it.",
  // The line above is false in Custom mode, and was shown there anyway.
  "dash.modeCustomHint": "Custom mode: only the apps you chose go through Neoxify.",
  "dash.modeCustomExceptHint": "Custom mode: everything goes through Neoxify except the apps you chose.",
  // "on the shortest path" was a speed claim, and this app has never
  // measured one. From Tehran the direct path to a Blizzard EU game
  // server was 72.0 ms and the best route through our fleet 72.8 ms --
  // a dead heat before encryption. Nothing here may imply otherwise.
  "dash.modeGamingHint":
    "Only the launcher, sign-in and updates of the games you choose go through Neoxify. The game's own connection doesn't, and this mode doesn't make it faster.",

  "gaming.off": "Gaming mode is off",
  "gaming.offHint":
    "Nothing is being redirected right now. Turn it on to send the launcher, sign-in and updates for the games you chose through Neoxify.",
  "gaming.arming": "Setting up...",
  "gaming.armingHint": "Setting up the rules for the games you chose.",
  "gaming.active": "Gaming mode is on",
  "gaming.activeHint":
    "The launcher, sign-in and updates for the games you chose go through Neoxify, and those services see Neoxify's address. The game's own connection doesn't go through Neoxify.",
  "gaming.partial": "Gaming mode is on, but not confirmed",
  // The exact sentence from the design, and it is not to be softened.
  // Rules present with a failed canary means the redirection may not be
  // happening at all, and a customer who is told it is "on" and nothing
  // else has been given a false pass.
  "gaming.partialHint":
    "Gaming mode is on, but Neoxify could not confirm your game traffic is reaching it.",
  "gaming.unknown": "Can't tell right now",
  "gaming.unknownHint":
    "Neoxify couldn't ask its background service what is set up, so it can't tell whether Gaming mode is on.",
  // Replaces the exit-IP pill, which must not render in this mode:
  // there is no single exit address to show, so showing one would be a
  // plain lie.
  "gaming.pathDirect": "Game connection: not through Neoxify",
  // The old wording here was "Your computer's IP address does not
  // change in this mode." That was written when this was meant as a
  // latency feature, and it is not true as stated: the whole mechanism
  // is that the redirected services are reached from Neoxify's server,
  // so those services do see a different address. What is unchanged is
  // everything else.
  "gaming.ipUnchanged":
    "The services being redirected are reached from Neoxify's server and see its address. Everything else on this computer, the game included, keeps your normal connection and your own address.",
  // Said outright rather than left to be inferred. Ping is the thing
  // customers assume a "gaming mode" sells, and it is the one thing
  // this cannot claim.
  "gaming.noSpeedClaim":
    "Neoxify does not measure ping and does not promise a faster connection. This mode helps you reach a service and does not change speed.",
  "gaming.turnOn": "Turn on",
  "gaming.turnOff": "Turn off",
  // On with nothing chosen is a reachable state and it does nothing at
  // all, so it says so in the warning chrome rather than sitting there
  // looking enabled -- the same defect class as the Custom-mode empty
  // state.
  // The card used to render NOTHING in this state: no button, no empty
  // state, no explanation, because `canAdd` was false and nothing was
  // chosen. An app that goes quiet rather than saying what happened is the
  // failure this project keeps finding, and it is worse here than a bad
  // sentence would be.
  "gaming.noneRedirectable":
    "None of the games on the list can have its launcher redirected, so there's nothing to add here. Custom mode sends a game's own programs through the VPN and doesn't need this.",
  "gaming.noGames": "No games chosen, so Gaming mode does nothing. Add one below.",
  "gaming.noGamesDash": "No games chosen, so Gaming mode does nothing. Choose one in Settings first.",
  "gaming.armFailed": "Gaming mode couldn't be turned on.",
  // The server's reasons, stated as the server gave them. Nothing here
  // claims a server was unreachable -- that would be a claim about a
  // dial that never happened.
  "gaming.needsPlan": "Gaming mode needs an active plan.",
  "gaming.notInPlan": "Your plan does not include gaming mode.",
  // "yet" was removed on 2026-08-25 and must not come back. It promised a
  // thing that is not being built: no Neoxify server offers this
  // redirection and none is planned, so "yet" was the app telling a paying
  // customer to wait for something nobody intends to ship. The second
  // sentence says plainly that this is not an outage, because a customer
  // who reads "not available" as "down right now" will keep retrying.
  "gaming.noResolver": "Gaming mode is not available on your server.",
  "gaming.noResolverBody":
    "This isn't a temporary outage. No Neoxify server offers this redirection, so nothing on this computer is redirected, and turning it on won't change that. Custom mode doesn't need it and works now.",
  "gaming.profileFailed": "Couldn't load the game list.",
  "gaming.retry": "Try again",
  "gaming.loading": "Loading games...",

  "settings.gaming": "Gaming",
  "gaming.title": "Gaming mode",
  "gaming.hint":
    "Send a game's launcher, sign-in and updates through Neoxify. The game's own connection stays on your normal internet.",
  "gaming.chosen": "Games you've chosen",
  "gaming.addGame": "Add a game",
  "gaming.remove": "Remove",
  // What one row buys, said on the row. One row is one game: the
  // launcher and the game are not two things for the customer to find.
  "gaming.redirects": "Launcher, sign-in and updates",
  "gaming.applies": "While Gaming mode is on, changes apply right away.",
  "gaming.pickerTitle": "Choose a game",
  "gaming.search": "Search games",
  // What a catalogue row is, said once, at the moment somebody is about to
  // choose one. The list runs to 1,480 entries and a long list reads as a
  // compatibility list -- as though somebody tested these. Nobody has: an
  // entry is a claim about which programs would be routed, and nothing
  // more. Not one of them has been checked against a running install.
  "gaming.pickerMeaning":
    "Each entry lists the programs Neoxify would send through the VPN while they run. None has been tested against a running game.",
  "gaming.searchEmpty": "No game matches that.",
  // Two different facts, because one string could not tell the truth about
  // both. With 1,480 entries and 60 mounted, the overflow line renders on
  // first open before anything is typed -- and "1420 more match, keep
  // typing" was wrong twice over there: nothing had been typed, and those
  // rows had not matched anything. `{count}` is pre-formatted by the
  // caller so the digits are the reader's own.
  "gaming.searchMore": "{count} more games match. Keep typing to narrow it down.",
  "gaming.listMore": "Showing the first {shown} of {count} games. Type to find yours.",
  "gaming.listEmpty": "No games are on the list.",
  "gaming.cancel": "Cancel",
  "pick.added": "Added",
  "gaming.tooMany": "You can choose up to {max} games.",
  "gaming.games": "Games",
  "gaming.resolver": "DNS server",
  // The risk that actually costs people accounts, which this product
  // had nowhere on screen. It is not detection: publishers rarely act
  // on a VPN they merely see. It is disclosure -- a player lost seven
  // years of Riot progress after describing where he was in a support
  // ticket. Short, and useful enough to act on.
  "gaming.accountRisk": "Keep your account safe",
  "gaming.accountRiskBody":
    "Accounts are rarely lost because a game detects a VPN. They are usually lost after the player tells support where they are. One player lost seven years of progress after mentioning his location in a support ticket. If you contact a game's support, answer only what they ask, and don't mention your location or that you use a VPN.",

  "common.loading": "Loading...",
  // Under a wait that has passed eight seconds (still-trying.ts). Says
  // only that the wait is long and not over -- never that Neoxify could
  // not be reached, which is for when nothing answered at all.
  "common.stillTrying": "This is taking longer than usual. Still trying...",

  // What a screen says about a request that failed (failure-text.ts). The
  // API layer's own sentences stay English for the reports; these are
  // what the customer reads.
  //
  // Nothing answered: every address was asked and none gave any answer at
  // all. The only failure allowed to say Neoxify could not be reached.
  "api.unreachable": "Couldn't reach Neoxify. Check your internet connection.",
  // Neoxify answered this sign-in's challenge, or this write's health
  // check, moments before, and then nothing answered the request itself.
  // It was reached, so this does not say it could not be.
  "api.stoppedAnswering": "Neoxify answered, then stopped responding. Try again.",
  // Something answered, with an error status and no message of its own:
  // a proxy's failure page, a CDN's check. Not "could not reach", because
  // something replied; and not said to be Neoxify's own answer, because
  // it may not have been.
  "api.serverError": "The server answered with an error ({status}). Try again in a moment.",
  // Nothing answered because every one of Neoxify's addresses resolved to
  // the network's DNS block page (10.10.34.x) and nowhere else. The
  // connection works; the network is keeping Neoxify's names from it, so
  // this does not send the customer to check their connection.
  "api.blockedByNetwork": "Your network is blocking Neoxify. Its addresses lead to a block page.",
  // Neoxify answered the request with "your access has expired", and
  // renewing the session then got no answer. Not a sign-out: the session
  // may be fine, and the next request tries again.
  "api.renewalUnanswered": "Neoxify answered, but renewing your sign-in got no answer. Try again.",
  // Renewing the session was answered, but not with a renewal: a page in
  // front of Neoxify, its throttle, a server error.
  "api.renewalFailed": "Couldn't renew your sign-in just now. Try again in a moment.",

  // The prominent disclosure shown once, before sign-in, on store
  // builds. Google Play requires an in-app explanation of why the app
  // needs VpnService and what data is collected, accepted by a
  // deliberate tap -- a privacy policy link alone does not satisfy it.
  // Worded as plainly as the policy it summarises: someone deciding
  // whether to trust a VPN in Iran is the reader.
  "disclosure.title": "Before you connect",
  "disclosure.subtitle": "What this app does and what we collect. Please read this once.",
  "disclosure.vpnHeading": "Why Neoxify needs VPN permission",
  "disclosure.vpnBody":
    "Neoxify is a VPN. Your phone asks for your permission to create a VPN connection, and the app cannot work without it.",
  "disclosure.vpnBody2":
    "While you're connected, the app creates an encrypted connection and sends your device's internet traffic through the server you choose. This keeps your connection private and lets you open sites your network blocks. In Custom mode, you choose which apps use the VPN, and the rest connect normally. When you're disconnected, nothing goes through the VPN.",
  "disclosure.dataHeading": "What we collect, and why",
  "disclosure.dataEmail":
    "Your email address and account ID, to create your account, sign you in and contact you about your account.",
  "disclosure.dataSupport":
    "Support messages you send from the app, so we can answer them.",
  "disclosure.dataDiagnostics":
    "Connection diagnostics, so we can find and fix problems. This includes whether a connection worked, which server and protocol it used, the app version and any error message.",
  "disclosure.dataServerLogs":
    "Our VPN servers keep operating logs, which can include connection records, so we can run the service and find problems.",
  "disclosure.dataNotSold":
    "We do not sell your data and we do not share it for advertising. In Custom mode, the list of apps you choose never leaves this device.",
  "disclosure.privacyLink": "Read the full privacy policy",
  "disclosure.accept": "Accept and continue",
  // The relay of last resort (docs/relay-last-resort.md, section 8).
  "relay.chip": "App data: backup route",
  "relay.blocked": "Neoxify's usual routes are blocked on this network.",
  "relay.intranet": "International internet is cut off in your country and only the national intranet works. Neoxify can only be reached through its backup route.",
  "relay.intranetLimits": "While only the national intranet works, signing in with Google, Apple or Facebook and codes sent by email may not work. Sign in with your password. If you forget it, use your recovery code.",
  "relay.region": "The backup route only works for connections from inside the country its server is in.",
  "relay.regionUnknown": "We couldn't confirm that this connection comes from inside the backup server's country, so you can't sign up through the backup route on it right now.",
  "relay.disconnect": "Disconnect to use the backup route.",
  "relay.unavailable": "The backup route can't be used right now.",
  "relay.signupOff": "You can't sign up through the backup route right now.",
  "relay.signupLimit": "Too many people are signing up through the backup route right now. Try again later.",
  "relay.signupTitle": "Sign up through the backup route",
  "relay.signupNote": "You're signing up through the backup route, so you don't need to confirm your email for now. Use an email address you can open later. You'll need it to confirm and recover your account.",
  "relay.offerSignup": "Sign up through the backup route instead",
  "relay.confirmEmail": "Repeat email",
  "relay.emailMismatch": "The two email addresses don't match.",
  "relay.disposableEmail": "Use an email address you can open later. Temporary addresses aren't accepted.",
  "relay.created": "Account created. Until you confirm your email, this account can use only the Ultimate plan. Enter an Ultimate voucher code.",
  "relay.continue": "Continue",
  "relay.checkoutUnavailable": "Card and crypto payments aren't available through the backup route. Use an Ultimate voucher code instead.",
  "relay.otherPlansAbroad": "Plans other than Ultimate use servers abroad, which can't be reached while only the national intranet works.",
  "voucher.notAllowed": "On the backup route, or until you confirm your email, you can only use a single-use Ultimate voucher code.",
  "recovery.title": "Your recovery code",
  "recovery.save": "Save this recovery code somewhere safe. If you can't open your email, it is the only way to reset your password. It is shown only once.",
  "recovery.copy": "Copy",
  "recovery.copied": "Copied",
  "recovery.saved": "I've saved it",
  "recovery.settingsTitle": "Recovery code",
  "recovery.settingsHint": "If you can't open your email, a recovery code is the only way to reset your password. Recommended if you live in a country where the internet is restricted.",
  "recovery.none": "You don't have a recovery code yet.",
  "recovery.has": "You have a recovery code.",
  "recovery.create": "Create a recovery code",
  "recovery.replace": "Replace the recovery code",
  "recovery.replaceWarning": "The old recovery code stops working.",
  "recovery.creating": "Creating...",
  "recovery.reauth": "Sign in again, then do this within 15 minutes.",
  "forgot.relayHint": "The reset code is sent by email. If you can't open your email, use your recovery code.",
  "forgot.useRecovery": "Use my recovery code",
  "forgot.useEmail": "Use an emailed reset code",
  "forgot.recoveryCode": "Recovery code",
  "forgot.recoveryDone": "Password changed. This is your new recovery code; the old one no longer works.",
  "verify.reminder": "Confirm your email to unlock all plans and payments. Your current plan is not affected.",
  "verify.reminderAction": "Confirm email",
  "verify.sendCode": "Email me a code",
  "verify.confirmed": "Your email is confirmed.",
  "verify.required": "Confirm your email to use this.",
  "unverified.change": "Change email",
  "unverified.newEmail": "New email",
  "unverified.limit": "You can change your email three times a day.",
  "unverified.changed": "Email changed. Confirm it when you can.",
  "setpw.title": "Set a password",
  "setpw.hint": "You sign in with Google, Apple or Facebook, and these can't be reached when only the national intranet works. With a password, you can still sign in.",
  "setpw.submit": "Set password",
  "setpw.done": "Password set.",
  "settings.backupRoute": "Backup route",
  "settings.backupRouteHint": "When Neoxify can't be reached the usual way, the app automatically sends its own requests (sign-in, your account, the server list and vouchers) through Neoxify's backup server inside your country, until you turn this off here. If our servers find that this device is outside that country, the backup route is turned off on that network for a day. Your data stays encrypted. The server's host can see that this device connected, but not what it sent.",
  "settings.backupRouteToggle": "Use the backup route",
  "settings.backupRouteInUse": "In use now.",
  "api.unreachableWithBackup": "Couldn't reach Neoxify, even through the backup server. Try again later.",
  // Pearl Glass redesign, phase 1: the main page (design-system.md, section 10).
  "tagline.line1": "Your internet.",
  "tagline.line2": "Without limits.",
  "tagline.mobile1": "A little more",
  "tagline.mobile2": "freedom.",
  "chip.idle": "Not connected",
  "chip.connecting": "Connecting",
  "chip.verifying": "Checking",
  "chip.connected": "Connected",
  "chip.unconfined": "Partly protected",
  "chip.unverified": "Not confirmed",
  "chip.degraded": "No traffic",
  "chip.reconnecting": "Reconnecting",
  "chip.disconnecting": "Disconnecting",
  "chip.unknown": "Status unknown",
  "chip.dropped": "Connection lost",
  "chip.noNetwork": "No network",
  "chip.gamingOff": "Gaming mode off",
  "chip.gamingOn": "Gaming mode on",
  "chip.gamingArming": "Setting up",
  "chip.gamingPartial": "Not confirmed",
  "chip.gamingUnknown": "Status unknown",
  "btn.connect": "Connect",
  "btn.disconnect": "Disconnect",
  "btn.connecting": "Connecting…",
  "btn.checking": "Checking…",
  "btn.waiting": "Waiting for network…",
  "btn.disconnecting": "Disconnecting…",
  "btn.stop": "Stop connecting",
  "btn.tryAnother": "Try another location",
  // A phone, where the way out shares the button's row: the short words.
  // The accessible name stays the full words above.
  "btn.stopShort": "Stop",
  "btn.tryAnotherShort": "Other location",
  "btn.recheck": "Check again",
  "btn.tryAgain": "Try again",
  "btn.cancel": "Cancel",
  "nav.main": "Main",
  "nav.overview": "Overview",
  "nav.locations": "Locations",
  "nav.home": "Home",
  "nav.plans": "Plan & billing",
  "nav.plansStore": "Plans",
  "nav.support": "Support",
  "nav.account": "Account menu",
  "menu.signedIn": "Signed in as {email}",
  "menu.version": "Neoxify {version}",
  "tb.minimize": "Minimize",
  "tb.maximize": "Maximize",
  "tb.restore": "Restore",
  "tb.close": "Close",
  "mode.label": "Mode",
  "mode.vpnHintIdle": "When connected, everything on this computer goes through Neoxify.",
  "mode.gamingHintShort": "Only the game services you choose go through Neoxify.",
  "mode.locked": "Disconnect to change mode",
  "more.below": "More below",
  "tr.location": "Location",
  "tr.change": "Change location",
  "tr.plan": "Plan",
  "tr.planUnl": "Unlimited plan",
  "tr.used": "{size} used",
  "tr.ofCap": "of {cap}",
  "notes.details": "Connection details",
  "tr.daysLeft": "{n} days left",
  "tr.dayLeft": "{n} day left",
  "tr.renew": "Renew",
  "tr.ip": "Your IP",
  "tr.ipPending": "Shown once the connection is confirmed",
  "tr.ipOff": "Not connected",
  "tr.ipGaming": "Unchanged for the game itself",
  "tr.gamesChosen": "{n} chosen",
  "tr.noPlan": "No plan",
  "loc.panelTitle": "Locations",
  "loc.measure": "Measure latency",
  "loc.pausedNote": "Latency is measured while you're disconnected.",
  "loc.notLoaded": "The list of locations hasn't loaded.",
  "loc.noLocations": "No locations available on your current plan.",
  "loc.relayPill": "Backup route",
  "loc.fAll": "All",
  "loc.fWorked": "Worked here",
  "loc.connectedHere": "Connected here",
  "loc.inUse": "In use",
  "sw.title": "Switch to {place}?",
  "sw.titleAuto": "Switch to Automatic?",
  "sw.body": "Neoxify disconnects and connects again. Until the new connection is checked, your traffic is not protected.",
  // While the service holds the internet ("Block the internet while
  // reconnecting"): never "not protected" over a machine it is blocking.
  // A connection it covers may let go while it switches (a pass dialling is
  // stopped by a plain teardown); one it does not cover lets go before it
  // is made (switchBody in lib/reconnect-hold.ts).
  "sw.bodyHeld": "Neoxify connects again to the new location. Other connections on this computer are blocked now, as you set. While it switches, they may go out without Neoxify until the new connection is checked.",
  "sw.bodyHeldNotCovered": "Other connections on this computer are blocked now, as you set. The block doesn't cover Built-in (IKEv2) or Custom mode, so Neoxify lifts it before making this connection. Until the new connection is checked, your traffic goes out without Neoxify.",
  // A gap the service has not yet said it holds: neither blocked nor
  // "not protected" (switchBody in lib/reconnect-hold.ts).
  "sw.bodyHoldUnconfirmed": "Neoxify connects again to the new location. It hasn't confirmed yet that other connections on this computer are blocked, as you set. Until the new connection is checked, they may go out without Neoxify.",
  "sw.go": "Switch",
  "sw.stay": "Stay connected",
  "dash.noProvision": "Your plan has no connection set up.",
  "decor.browse": "Browse",
  "decor.stream": "Stream",
  "decor.work": "Work",
  "decor.anywhere": "Anywhere",
  "map.legend": "Map lights for the network you're on now",
  "map.live": "Worked here",
  "map.idle": "Not confirmed yet",
  "map.down": "Offline or failing",
  "map.liveTip": "Carried traffic on this network recently, on this device or for most people on this network.",
  "map.idleTip": "Listed, but there's no sign yet whether it works on this network. A latency number doesn't count.",
  "map.downTip": "Neoxify reports it offline, or it has been failing for most people on this network lately.",
  "map.hereTip": "The location your confirmed connection uses.",
  "loc.ispWorksShort": "Works for others here",
  "loc.ispFailingShort": "Failing for others here",
  "loc.automaticHintShort": "Tries what works here first",
  "loc.ownWorked": "Worked on this device",
  "loc.ownWorkedTip": "Carried traffic from this device lately, on this network.",
  "sw.notSwitched": "Couldn't confirm the old connection had closed, so the location wasn't switched.",
  "tr.ipChecked": "Checked through the VPN",
  "tr.speed": "Speed",
  "tr.down": "Download",
  "tr.up": "Upload",
  "tr.perSec": "{size}/s",
  "tr.perSecSpoken": "{size} per second",
  "dash.autoConnecting": "Connecting because “Connect when Neoxify starts” is on in Settings.",
  "dash.autoConnectingRung": "“Connect when Neoxify starts” is on · {rung}",
  "lad.trying": "Trying {route} · {n} of {total}",
  "rc.next": "Attempt {n} of {max} · next try in {s} s",
  "rc.now": "Attempt {n} of {max} · trying now",
  "rc.attempt": "Attempt {n} of {max}",
  "hold.holding": "As you set, other connections on this computer are blocked until Neoxify connects again. Your local network still works, and DNS lookups still go out.",
  "hold.dnsAnywhere": "Neoxify couldn't read this computer's DNS servers. So while other connections are blocked, anything sent to port 53 still goes out, not only DNS lookups.",
  "hold.heldAfterDrop": "Other connections on this computer are still blocked, as you set, until Neoxify lifts the block. Connect again to get back online.",
  // WireGuard's block could not stand in force while connected, so it went
  // in on the report of the drop, after wireguard.exe's own had gone: true
  // from then, not of that moment (the service's `standing_refused`).
  "hold.heldLate": "On WireGuard, the block couldn't be kept ready while you were connected, so it started a moment after the VPN connection closed. In that moment, traffic may have gone out without Neoxify.",
  // In the gap before the service has said whether the block is in: no
  // claim either way -- not "going out without Neoxify", which is false the
  // moment it is in, nor "blocked", which nothing has confirmed yet.
  "hold.unconfirmed": "The VPN connection closed. Neoxify is checking whether other connections on this computer are blocked, as you set.",
  // The service did not answer -- restarting, or not running -- so the
  // block is neither claimed nor denied: after a restart it is gone. Not
  // "still blocked" either, which says they were.
  "hold.unanswered": "Neoxify's service isn't answering right now, so Neoxify is checking whether other connections on this computer are blocked, as you set.",
  "hold.filtersRefused": "Neoxify couldn't block the internet while reconnecting because Windows refused the filters. Your traffic goes out without Neoxify until the VPN is back.",
  "hold.tunnelNotPermitted": "Stopped blocking the internet so the new connection could carry traffic.",
  "hold.timedOut": "After 40 minutes of trying to reconnect, Neoxify stopped blocking the internet so this computer isn't left offline. Your traffic goes out without Neoxify until the VPN is back.",
  "hold.notCovered": "The internet isn't blocked, because the block doesn't cover Built-in (IKEv2) or Custom mode. Your traffic goes out without Neoxify until the VPN is back.",
  "hold.other": "The internet isn't blocked while reconnecting. Your traffic goes out without Neoxify until the VPN is back.",
  "notif.connectedTitle": "Neoxify is connected",
  "notif.connectedBody": "Neoxify checked that your traffic goes through the VPN.",
  "notif.connectedPartialBody": "Connected, but not every connection on this computer is kept inside the VPN. Open Neoxify for details.",
  "notif.lostTitle": "VPN connection lost",
  "notif.lostBody": "Neoxify is reconnecting. Your traffic is not protected until it's back.",
  "notif.lostHeldBody": "Neoxify is reconnecting. Other connections on this computer are blocked until it's back, as you set.",
  "notif.lostHeldLateBody": "Neoxify is reconnecting. Other connections on this computer are blocked until it's back, as you set. Some traffic may have gone out at the moment the connection dropped.",
  "notif.lostUnconfirmedBody": "Neoxify is reconnecting. It hasn't yet confirmed that other connections on this computer are blocked, as you set.",
  "notif.backTitle": "VPN connected again",
  "notif.backBody": "Neoxify checked that your traffic goes through the VPN again.",
  "notif.backPartialBody": "Connected again, but not every connection on this computer is kept inside the VPN. Open Neoxify for details.",
  "notif.backUnconfirmedBody": "The connection is back, but Neoxify couldn't confirm that your traffic goes through the VPN. Open Neoxify for details.",
  "notif.droppedTitle": "VPN connection lost",
  "notif.droppedBody": "Your traffic is not protected. Open Neoxify to connect again.",
  "notif.statusChannel": "VPN status",
  "notif.changesChannel": "Connection changes",
  "notif.starting": "Starting the VPN…",
  "notif.on": "The VPN service is running. Open Neoxify to check the connection.",
  "notif.offTitle": "VPN turned off",
  "notif.offBodyAndroid": "Android or another VPN app turned off Neoxify's VPN. Open Neoxify to connect again.",
  "notif.offBodyIos": "Another VPN, or a change in Settings, turned off Neoxify's VPN. Open Neoxify to connect again.",
  "notif.stoppedTitle": "VPN stopped",
  "notif.stoppedBody": "Neoxify's VPN stopped by itself. Open Neoxify to connect again.",
  "sum.open": "Plan, IP address and connection details",
  "sum.title": "Plan and connection",
  "sum.close": "Close",
  // The redesign's sign-in, Settings, Activity and the other pages (design-system.md, phase 2).
  "nav.activity": "Activity",
  "auth.showPassword": "Show password",
  "verify.lead": "We sent a 6-digit code to {email}. Enter it below to activate your account.",
  "verify.resent": "Sent. Check your inbox, and your spam folder too.",
  "so.title": "Sign out of Neoxify?",
  "so.body": "Signing out disconnects the VPN first, so your traffic stops going through Neoxify. On a blocked network, signing back in may need the backup route.",
  "so.go": "Sign out",
  "dlg.close": "Close",
  "set.lede": "Neoxify's options on this device.",
  "set.connection": "Connection",
  "set.leak": "Leak protection",
  "set.leakVal": "What's covered",
  "set.autoStart": "Open Neoxify when I sign in to Windows",
  "set.autoConnect": "Connect when Neoxify starts",
  "set.blockRecon": "Block the internet while reconnecting",
  "set.killHint": "Off by default. If the VPN drops, other connections on this computer are blocked until Neoxify connects again or you disconnect. This doesn't work with Built-in (IKEv2) or in Custom mode. Your local network still works, and DNS lookups still go out.",
  "set.modes": "Modes",
  "set.gaming": "Gaming mode",
  "set.gamingHint": "Only the game services you choose go through Neoxify.",
  "set.beta": "Beta",
  "set.custom": "Custom mode",
  "set.perApp": "Per-app routing",
  "set.customHint": "Choose which apps go through Neoxify.",
  "set.perAppIos": "iPhone doesn't let VPN apps choose which apps use the VPN, so this isn't available here.",
  "set.appearance": "Appearance",
  "set.languageHint": "Changes right away.",
  "set.system": "System",
  "set.light": "Pearl",
  "set.dark": "Smoked",
  "set.effects": "Visual effects",
  "set.effectsHint": "Glass and blur. Lite or Off is easier on older devices.",
  "set.full": "Full",
  "set.lite": "Lite",
  "set.off": "Off",
  "set.on": "On",
  "set.osSet": "{v} · set by {os}",
  "set.osWin": "Windows",
  "set.osAndroid": "Android",
  "set.osIos": "iOS",
  "set.motion": "Reduce motion",
  "set.motionHint": "Short fades instead of movement. Also follows your system setting.",
  "set.notifs": "Notifications",
  "set.notifications": "Notify me when the connection changes",
  "set.password": "Password",
  "set.change": "Change",
  "set.recovery": "Recovery code",
  "set.create": "Create",
  "set.signOutHint": "Disconnects first",
  "set.troubleshoot": "Troubleshoot",
  "set.repair": "Repair network",
  "set.repairHint": "Resets network settings on this computer that can stop Neoxify from connecting. Disconnects first.",
  "set.supportHint": "Messages, and the details that help us see what went wrong.",
  "set.about": "About",
  "set.version": "Version",
  "set.community": "Community",
  "set.website": "Website",
  "set.history": "Keep a session log on this device",
  "set.historyHint": "Off by default. Records when each connection started and ended, which location it used and how much data it carried. The log stays on this device for 7 days and isn't sent anywhere. Connection results are still reported, as described above. Older records are deleted while Neoxify runs or the next time it opens. Anyone who can open this device can read it. Turning it off, signing out or uninstalling Neoxify deletes it.",
  "set.autoStartHint": "Opens Neoxify in a window when you sign in to Windows. It only connects if “Connect when Neoxify starts” is also on.",
  "set.autoStartFailed": "Windows didn't accept the change. Try again, or check Startup apps in Task Manager.",
  "set.autoConnectHint": "When Neoxify opens and isn't connected, it connects to the location on the main page, the same as pressing Connect. It doesn't do this in Gaming mode, and it never takes your plan's device slot from another device.",
  "set.notificationsHint": "Only for changes that last, when the connection is lost or comes back, not for gaps of a few seconds. Only while Neoxify isn't the window in front.",
  "set.notifsOffApp": "Windows is set not to show Neoxify's notifications. Turn them on in Windows Settings › System › Notifications.",
  "set.notifsOffAll": "Notifications are off for every app in Windows Settings › System › Notifications.",
  "set.notifsOffPolicy": "This PC's administrator has turned notifications off.",
  "set.notificationsHintAndroid": "Tells you when Android or another VPN app turns off Neoxify's VPN while Neoxify isn't open.",
  "set.notificationsHintIos": "Tells you when Neoxify's VPN stops, or another VPN or Settings turns it off, while Neoxify isn't open.",
  "set.notifsCanAsk": "Neoxify hasn't asked {os} for permission to show notifications yet, so they don't appear.",
  "set.notifsAllow": "Allow notifications",
  "set.notifsOffPhone": "{os} is set not to show Neoxify's notifications, so they don't appear.",
  "set.notifsOpen": "Open {os} settings",
  "leak.reconHeld": "other connections on this computer are blocked until the VPN is back, as you set (not with Built-in or in Custom mode). Your local network still works, and DNS lookups still go out.",
  "leak.lede": "What Neoxify keeps inside the VPN. You can't change it here.",
  "leak.heldLead": "While you're connected",
  "leak.held": "on any protocol except Built-in, other connections on this computer are kept inside the VPN and IPv6 is blocked. If that can't be set up, the main page says so.",
  "leak.notHeldLead": "Built-in (IKEv2) and Custom mode",
  "leak.notHeld": "don't keep other connections inside the VPN. The main page says so while they're in use.",
  "leak.reconLead": "While reconnecting,",
  "leak.recon": "traffic goes out without Neoxify until the VPN is back.",
  "plans.finishInBrowser": "Finish paying in your browser. This screen updates by itself when the payment goes through.",
  "plans.reopen": "Reopen payment page",
  "plans.sendExactly": "Send exactly this amount. Your plan starts by itself once the network confirms the payment.",
  "plans.checking": "Checking for confirmation...",
  "plans.current": "Current plan",
  "plans.expires": "Expires",
  "plans.choose": "All plans",
  "plans.cur": "Current",
  "plans.storeLede": "Prices come from the App Store.",
  // An App Store purchase that did not finish, by its code (iap.ts,
  // failure-text.ts). These were English-only sentences in iap.ts.
  "iap.unknownProduct": "This plan isn't available on the App Store right now.",
  "iap.unverified": "The App Store couldn't confirm this purchase.",
  "iap.failed": "The purchase didn't complete. If money left your account, reopen the app and the plan will be added. You won't be charged twice.",
  "support.conversations": "Your conversations",
  "referrals.paidMonth": "{count} paid month",
  "referrals.monthToGo": "{count} paid month to go",
  "act.title": "Activity",
  "act.lede": "What works on this network and the session log come from this device's own records. Your devices and daily usage come from your account. Connection results are also reported to Neoxify, without your traffic, so others on your network can see what works.",
  "act.network": "What works on this network",
  "act.networkNote": "From this device's own attempts on its current network, over the last day.",
  "act.noNetwork": "Neoxify can't tell which network this is right now, so nothing is shown for it.",
  "act.nothingYet": "Nothing has been tried on this network in the last day.",
  "act.summary": "{ok} of the {n} tried here lately carried traffic on their last try.",
  "act.unlisted": "A location no longer listed",
  "act.tries": "{ok} of {n} worked",
  "act.worked": "Carried traffic",
  "act.failed": "Didn't carry traffic",
  "act.plan": "Your plan",
  "act.noPlan": "This device has no plan on record.",
  "act.asOf": "As this device last saw it, {when}.",
  "act.devices": "Devices on your plan",
  "act.devicesNote": "Signed in to your account. “In use now” means connected through Neoxify in the last minute and a half.",
  "act.deviceLimit": "Your plan allows {n} at once.",
  "act.usage": "Daily usage",
  "act.usageNote": "All your devices together, as Neoxify's servers recorded it. The days don't add up to your plan's total, because some traffic isn't tied to a day here.",
  "act.history": "Session log",
  "act.retry": "Try again",
  "act.devicesNoAnswer": "Couldn't reach Neoxify to list your devices.",
  "act.devicesFailed": "Neoxify couldn't list your devices right now.",
  "act.thisDevice": "This device",
  "act.inUse": "In use now",
  "act.signOutDevice": "Sign out {device}",
  "act.signOutTitle": "Sign out {device}?",
  "act.signOutBody":
    "It's signed out of your account and has to sign in again to connect. Any connection it has open ends too. On an older version of Neoxify, that connection can stay up until the device disconnects.",
  "act.signOutGo": "Sign out",
  "act.signOutFailed": "That device wasn't signed out. Try again.",
  "act.signOutUnreached": "Couldn't reach Neoxify, so that device wasn't signed out. Try again.",
  "act.inUseUnknown": "Your plan doesn't keep track of which devices are connected, so none is marked “In use now”.",
  "act.signedInSeen": "Signed in {signedIn} · seen {seen}",
  "act.signedIn": "Signed in {signedIn}",
  "act.devWindows": "Windows PC",
  "act.devMac": "Mac",
  "act.devLinux": "Linux PC",
  "act.devAndroid": "Android phone",
  "act.devIos": "iPhone",
  "act.devUnknown": "Another device",
  "act.usageNoAnswer": "Couldn't reach Neoxify for your daily usage.",
  "act.usageFailed": "Neoxify couldn't load your daily usage right now.",
  "act.usagePeriod": "in the last {n} days",
  "act.usageDay": "{date}: {down} down, {up} up",
  "act.today": "Today so far",
  "act.usageAsOf": "Recorded up to {when}.",
  "act.usageUtc": "Days are counted in UTC.",
  "act.logEmpty": "Nothing recorded yet. Connections are recorded from now on.",
  "act.logClear": "Clear the session log",
  "act.logClearTitle": "Clear the session log?",
  "act.logClearBody": "Every connection recorded on this device is deleted. This can't be undone.",
  "act.logClearGo": "Clear",
  "act.logRange": "{day}, {from}–{to}",
  "act.logNow": "now",
  "act.logNoEnd": "end not recorded",
  "act.logLost": "Lost",
  "act.logBytes": "{down} down, {up} up",
  // The server list (design-system.md 4.8, phase 3).
  "loc.search": "Search locations",
  "loc.clear": "Clear search",
  "loc.more": "Location options",
  "loc.close": "Close locations",
  "loc.filters": "Filter locations",
  "loc.fWorkedLong": "Only what worked on my network",
  "loc.fRelay": "Backup routes",
  "loc.fRelayLong": "Backup routes only",
  "loc.recommended": "Recommended",
  "loc.countries": "Countries",
  "loc.backup": "Backup routes",
  "loc.backupHint": "Enters through a server inside your country. For when international internet is cut off.",
  "loc.protocols": "{n} protocols",
  "loc.protocolsOne": "{n} protocol",
  "loc.cant": "Can't measure",
  "loc.cantTipUdp": "Only a ping can time this protocol, and the ping got no answer. Many networks block pings, so it may still connect.",
  "loc.cantTipTcp": "The timing test got no answer. That doesn't mean this protocol won't connect.",
  "loc.cantWhyUdp": "No answer to the ping. Many networks block pings; it may still connect.",
  "loc.cantWhyTcp": "No answer to the timing test. It may still connect.",
  "loc.notMeasured": "Not measured",
  "loc.measuring": "Measuring…",
  "loc.toIran": "to entry",
  "loc.toIranTip": "Timed to the entry server only, not all the way to the exit.",
  "loc.measuredAt": "Latency measured {when}.",
  "loc.notMeasuredNote": "Latency hasn't been measured yet.",
  "loc.measureAgain": "Measure again",
  "loc.measureOff": "Disconnect to measure latency.",
  "loc.empty": "No locations match “{q}”",
  "loc.emptyHint": "Try a country or a protocol name.",
  "loc.emptyWorked": "No recent reports from your network yet.",
  "loc.emptyRelay": "Your plan has no backup routes.",
  "loc.showAll": "Show all",
  "loc.explain": "How the protocols differ",
  "loc.explainLede": "Automatic tries them in the order most likely to work on your network. Pick one only if you need to.",
  "loc.pageLede": "Pick a country, then a protocol. Automatic is usually the best choice.",
  "loc.openFull": "Open the full list",
  "loc.worked": "Worked on my network",
  "loc.ispNote": "A location shows as worked when this device's connection there was checked on this network lately, or when it worked for most Neoxify users on the same internet provider.",
  "loc.evOwnTip": "{p} carried traffic from this device {when}, on this network.",
  "loc.evIspFail": "Failing for others",
  "loc.evOffline": "Offline",
  "loc.evOfflineTip": "Neoxify reports this location offline right now.",
  "loc.protoOfflineTip": "Neoxify reports this server offline right now.",
  "proto.hint.reality": "Hardest to block. Best on restricted networks.",
  "proto.hint.tls": "Looks like a normal HTTPS website.",
  "proto.hint.ws": "Looks like ordinary web traffic. Best when everything else is blocked.",
  "proto.hint.vmess": "Older stealth option, kept for compatibility.",
  "proto.hint.trojan": "Also looks like a website. An older method than Stealth HTTPS.",
  "proto.hint.ss": "No handshake to detect. Good when stealth ports are blocked.",
  "proto.hint.wg": "Fastest. Best when nothing is blocking you.",
  "proto.hint.ovpn": "Slower, but works almost everywhere.",
  "proto.hint.ikev2": "Uses your device's own VPN. Fast, but easy to block.",
} as const;

export type TranslationKey = keyof typeof en;

/** Persian. Kept as a full record so TypeScript refuses to build when a
 * key is added to English and not translated -- a half-translated screen
 * is worse than an untranslated one, because it looks broken rather than
 * unfinished. */
const fa: Record<TranslationKey, string> = {
  "app.tagline": "اتصال خصوصی شما.",
  "auth.continueWithGoogle": "ادامه با گوگل",
  "auth.continueWithApple": "ادامه با اپل",
  "auth.continueWithFacebook": "ادامه با فیس‌بوک",
  "auth.orUseEmail": "یا با ایمیل",
  "auth.socialFailed": "ورود انجام نشد. دوباره امتحان کنید.",
  "auth.socialUnavailable": "این روش ورود الان در دسترس نیست. با روش دیگری وارد شوید.",
  "auth.appleNoAccount": "اول در تنظیمات دستگاه وارد حساب اپل خود شوید، بعد دوباره امتحان کنید.",
  "auth.socialNeedsCloudflare":
    "ورود با گوگل و فیس‌بوک برای برگشتن به برنامه به کلادفلر نیاز دارد و بعضی شبکه‌ها کلادفلر را بسته‌اند. اگر صفحهٔ ورود باز نشد، آن را ببندید و با ایمیل و رمز عبور خود در فرم پایین وارد شوید.",
  "auth.socialCancel": "انصراف",
  "auth.signInToConnect": "برای اتصال وارد شوید.",
  "auth.noCardRequired": "برای ثبت‌نام کارت بانکی لازم نیست.",
  "verify.noCode": "ارسال دوبارهٔ کد",
  "loc.title": "انتخاب کشور",
  "loc.disconnectFirst": "برای عوض کردن سرور، اول اتصال را قطع کنید",
  "loc.pickHint": "یک سرور و پروتکل انتخاب کنید",
  "loc.serverN": "سرور {n}",
  "loc.retry": "تلاش دوباره",
  "loc.automatic": "خودکار (پیشنهادی)",
  "loc.automaticHint": "اول گزینه‌ای را امتحان می‌کند که روی شبکهٔ شما بیشتر احتمال دارد کار کند و اگر وصل نشد، خودش سراغ گزینهٔ بعدی می‌رود",
  "loc.automaticShort": "خودکار",
  "loc.ispWorks": "اخیراً برای بیشتر کاربران شبکهٔ شما کار کرده",
  "loc.ispFailing": "اخیراً برای بیشتر کاربران شبکهٔ شما کار نکرده",
  "loc.ispCount": "{customers} نفر از {outOf} نفر در {hours} ساعت گذشته",
  "loc.recommendedOnly": "فقط گزینه‌هایی که روی شبکهٔ من کار کرده‌اند",
  "dash.serverAuto": "سرور (خودکار)",

  "nav.settings": "تنظیمات",
  "nav.signOut": "خروج از حساب",
  "nav.signingOut": "در حال خروج...",
  "nav.back": "بازگشت",
  "signout.tunnelUnconfirmed":
    "از حساب خارج شدید، ولی برنامه نتوانست مطمئن شود که وی‌پی‌ان خاموش شده است. برای اطمینان، نئوکسیفای یا این دستگاه را دوباره راه‌اندازی کنید.",
  "signout.sessionEnded": "از حسابتان خارج شده‌اید. برای ادامه دوباره وارد شوید.",
  "auth.emailVerifiedNotice": "ایمیل شما تأیید شد. برای ادامه وارد شوید.",
  "auth.verifyLinkFailed": "ایمیل شما تأیید نشد: {reason}",

  "auth.welcomeBack": "خوش آمدید",
  "auth.signIn": "ورود",
  "auth.signingIn": "در حال ورود...",
  "auth.email": "ایمیل",
  "auth.password": "رمز عبور",
  "auth.createAccount": "ساخت حساب",
  "auth.noAccount": "حساب ندارید؟",
  "auth.haveAccount": "حساب دارید؟",
  "auth.register": "ثبت‌نام",
  "auth.registering": "در حال ساخت حساب...",

  "forgot.link": "رمز عبور را فراموش کرده‌اید؟",
  "forgot.title": "بازنشانی رمز عبور",
  "forgot.subtitle": "یک کد برایتان ایمیل می‌کنیم تا رمز جدید بگذارید.",
  "forgot.sendCode": "ارسال کد",
  "forgot.sending": "در حال ارسال...",
  "forgot.sent": "اگر با این ایمیل حسابی ساخته شده باشد، کد برایش فرستاده شد. کد تا ۳۰ دقیقه اعتبار دارد.",
  "forgot.code": "کد داخل ایمیل",
  "forgot.newPassword": "رمز عبور جدید",
  "forgot.confirmPassword": "تکرار رمز عبور جدید",
  "forgot.submit": "ذخیرهٔ رمز جدید",
  "forgot.submitting": "در حال ذخیره...",
  "forgot.done": "رمز عبور عوض شد. حالا می‌توانید وارد شوید.",
  "forgot.backToSignIn": "برگشت به صفحهٔ ورود",
  "forgot.tooShort": "حداقل ۸ کاراکتر.",
  "forgot.mismatch": "رمزها با هم یکی نیستند.",

  "verify.title": "ایمیل خود را ببینید",
  "verify.sentTo": "یک کد به {email} فرستادیم",
  "verify.code": "کد تأیید",
  "verify.confirm": "تأیید",
  "verify.confirming": "در حال تأیید...",
  "verify.resend": "ارسال دوبارهٔ کد",
  "verify.sending": "در حال ارسال...",

  "dash.connect": "اتصال",
  "dash.connecting": "در حال اتصال...",
  "dash.disconnect": "قطع اتصال",
  "dash.disconnecting": "در حال قطع اتصال...",
  "dash.connected": "متصل",
  "dash.disconnected": "وصل نیستید",
  "dash.dataUsed": "حجم مصرف‌شده",
  "dash.expires": "انقضا",
  "dash.location": "کشور",
  "dash.viewPlans": "دیدن پلن‌ها",
  "dash.noSubscription": "پلن فعالی ندارید",
  "dash.noPlanHint": "برای استفاده از نئوکسیفای یک پلن انتخاب کنید.",
  "dash.outOfData": "حجم پلن شما تمام شده است",
  "dash.planExpired": "مهلت پلن شما تمام شده است",
  "dash.renewHint": "برای وصل شدن، پلن خود را تمدید یا عوض کنید.",
  "dash.renewStore":
    "این پلن را همان‌جایی که خریده‌اید مدیریت می‌کنید. برای تمدید، همان‌جا وارد حساب خود شوید. بعد از تمدید، پلن دوباره اینجا نمایش داده می‌شود.",
  "dash.renewCta": "تمدید پلن",
  "dash.noPlanStore": "حساب شما آماده است. وقتی پلنی به حساب اضافه شود، اینجا نمایش داده می‌شود و می‌توانید وصل شوید.",

  "plans.title": "انتخاب پلن",
  "plans.subtitle": "برای وصل شدن یک پلن انتخاب کنید.",
  "plans.subtitleActive": "پلن دیگری بخرید یا کد هدیه وارد کنید.",
  "plans.crypto": "رمزارز",
  "plans.card": "کارت بانکی",
  "plans.loading": "در حال بارگذاری پلن‌ها...",
  "plans.none": "الان پلنی برای خرید نیست. کمی بعد دوباره سر بزنید.",
  "plans.waiting": "در انتظار پرداخت",

  "auth.referralCode": "کد معرف (اختیاری)",
  "auth.referralCodeHint": "از دوستی که شما را دعوت کرده",
  "update.downloading": "در حال دانلود نئوکسیفای {version}...",
  "update.downloadingPercent": "در حال دانلود نئوکسیفای {version} ({percent}٪)",
  "update.ready": "نئوکسیفای {version} آمادهٔ نصب است.",
  "update.restart": "راه‌اندازی دوباره",
  "update.androidAvailable": "نسخهٔ {version} نئوکسیفای آمده است",
  "update.androidHint": "در مرورگر دانلود می‌شود. اندروید پیش از نصب از شما اجازه می‌گیرد. تنظیمات و ورود شما حفظ می‌شود.",
  "update.androidDownload": "دانلود",
  "update.androidOpenFailed": "دانلود شروع نشد. دوباره امتحان کنید.",
  "update.restarting": "در حال راه‌اندازی دوباره...",
  "update.connectedFirst": "برای به‌روزرسانی، اول اتصال را قطع کنید.",
  "dash.customModeDetached": "وصل شد، ولی حالت سفارشی فعال نشد. برنامه‌هایی که انتخاب کرده‌اید بدون محافظت به اینترنت می‌روند.",
  "dash.unlimited": "نامحدود",
  "support.title": "پشتیبانی",
  "support.subtitle": "پیام بدهید. در اولین فرصت جواب می‌دهیم.",
  "support.new": "پیام جدید",
  "support.newTitle": "در چه موردی کمک می‌خواهید؟",
  "support.subject": "موضوع",
  "support.subjectHint": "در چند کلمه، مثلاً «با Stealth وصل نمی‌شوم»",
  "support.message": "پیام",
  "support.messageHint": "بنویسید چه اتفاقی افتاده و چه کارهایی را امتحان کرده‌اید.",
  "support.send": "ارسال",
  "support.sending": "در حال ارسال...",
  "support.reply": "پاسخ خود را بنویسید",
  "support.replyWithin": "معمولاً تا {hours} ساعت جواب می‌دهیم.",
  "support.replyWithinDay": "معمولاً تا یک روز جواب می‌دهیم.",
  "support.closed": "پشتیبانی الان پیام جدید نمی‌گیرد. بعداً دوباره سر بزنید.",
  "support.closedTitle": "پیام جدید گرفته نمی‌شود",
  "support.empty": "هنوز گفت‌وگویی ندارید.",
  "support.emptyHint": "پیام‌هایی که بفرستید اینجا نمایش داده می‌شوند.",
  "support.you": "شما",
  "support.team": "پشتیبانی",
  "support.statusOpen": "در انتظار پاسخ",
  "support.statusAnswered": "پاسخ داده شد",
  "support.statusResolved": "حل شد",
  "support.unread": "پاسخ جدید",
  "support.notLive": "این گفت‌وگو زنده نیست و می‌توانید برنامه را ببندید. جواب ما اینجا و در ایمیلتان می‌آید.",
  "referrals.title": "دعوت از دوستان",
  "referrals.subtitle": "کدتان را برای دوستانتان بفرستید و روز رایگان بگیرید.",
  "referrals.off": "دعوت از دوستان الان فعال نیست.",
  "referrals.yourCode": "کد معرف شما",
  "referrals.rule": "وقتی یک دوست {months} ماه پلن بخرد، یا {friends} دوست هر کدام {each} ماه پلن بخرند، {days} روز رایگان می‌گیرید.",
  "referrals.copy": "کپی",
  "referrals.copied": "کپی شد",
  "referrals.progress": "ماه رایگان بعدی",
  "referrals.monthsToGo": "{count} ماه خرید دیگر مانده",
  "referrals.almost": "در بررسی بعدی آماده می‌شود",
  "referrals.progressHint": "بیشترین خرید یک دوست تا الان: {best} ماه. دوستانی که شرط را دارند: {qualifying}.",
  "referrals.friends": "دوستانی که دعوت کرده‌اید",
  "referrals.friendsHint": "برای حفظ حریم خصوصی، بخشی از ایمیل‌ها پنهان است.",
  "referrals.noFriends": "هنوز کسی نیست. کدتان را برای دوستانتان بفرستید.",
  "referrals.joined": "ثبت‌نام کرد",
  "referrals.pending": "فعال نشده",
  "referrals.paidMonths": "{count} ماه خرید",
  "referrals.earned": "زمان رایگانی که گرفته‌اید",
  "referrals.freeDays": "{days} روز رایگان",
  "nav.referrals": "دعوت از دوستان",
  "settings.title": "تنظیمات",
  "settings.subtitle": "مدیریت حساب.",
  "settings.language": "زبان",
  "settings.languageHint": "تغییر زبان فوراً اعمال می‌شود.",
  "settings.deleteAccount": "حذف حساب",
  "settings.deleteAccountHint": "حساب شما و همهٔ اطلاعاتش برای همیشه پاک می‌شود.",
  "settings.deleteWarning": "این کار برگشت ندارد. حساب شما، اطلاعات اتصال شما روی همهٔ سرورها و زمان باقی‌ماندهٔ پلنتان فوراً پاک می‌شود. فاکتورها به دلایل مالیاتی و بدون اطلاعات شخصی شما نگه داشته می‌شوند.",
  "settings.deleteTypeToConfirm": "برای تأیید، {word} را بنویسید",
  "settings.deleteConfirmWord": "DELETE",
  "settings.deleteConfirm": "حذف دائمی",
  "settings.deleteCancel": "حذف نشود",
  "settings.deleting": "در حال حذف...",
  "settings.changePassword": "تغییر رمز عبور",
  "settings.changePasswordHint": "روی این دستگاه از حساب خارج نمی‌شوید.",
  "settings.currentPassword": "رمز عبور فعلی",
  "settings.newPassword": "رمز عبور جدید",
  "settings.confirmPassword": "تکرار رمز عبور جدید",
  "settings.passwordChanged": "رمز عبور عوض شد. دستگاه‌های دیگر شما از حساب خارج شدند.",
  "settings.changing": "در حال تغییر...",
  "settings.tooShort": "حداقل ۸ کاراکتر.",
  "dash.customActive":
    "حالت سفارشی: فقط برنامه‌هایی که انتخاب کرده‌اید از وی‌پی‌ان می‌گذرند. IPv6 این برنامه‌ها مسدود می‌شود تا بیرون از وی‌پی‌ان نرود، برای همین سایت‌هایی که فقط IPv6 دارند برایشان باز نمی‌شوند. پینگ هم برای همهٔ برنامه‌های این کامپیوتر مسدود است، چون وی‌پی‌ان نمی‌تواند پینگ را منتقل کند و اگر مسدود نشود، آدرس واقعی شما را به هر سروری که بازی‌تان پینگ می‌کند نشان می‌دهد. تا وقتی این حالت روشن است، عدد پینگ و تأخیر داخل بازی کار نمی‌کند.",
  "dash.fullTunnelIpv6Blocked":
    "تا وقتی وصل هستید، IPv6 مسدود است. سرورهای نئوکسیفای فقط IPv4 را منتقل می‌کنند، برای همین IPv6 روی همین دستگاه متوقف می‌شود تا بیرون از وی‌پی‌ان نرود. سایت‌هایی که فقط IPv6 دارند تا وقتی اتصال را قطع نکنید باز نمی‌شوند.",
  "dash.ipv6Escaping":
    "بخشی از ترافیک شما از راه IPv6 و بیرون از وی‌پی‌ان می‌رود و شبکهٔ شما آدرس IPv6 شما را می‌بیند. اتصال را قطع کنید و دوباره وصل شوید. اگر باز تکرار شد، به پشتیبانی خبر بدهید.",
  "dash.tunnelDnsUnforced":
    "ترافیک شما از وی‌پی‌ان می‌گذرد، اما نئوکسیفای نتوانست درخواست‌های DNS این دستگاه را هم از وی‌پی‌ان بفرستد. سرویس‌دهندهٔ اینترنت شما هنوز می‌تواند به این درخواست‌ها جواب بدهد و روی شبکهٔ فیلترشده این جواب‌ها اغلب اشتباه است، برای همین ممکن است بعضی سایت‌ها باز نشوند. اتصال را قطع کنید و دوباره وصل شوید. اگر باز تکرار شد، از «رفع مشکل شبکه» استفاده کنید.",
  "dash.ipv4NotConfined":
    "نئوکسیفای نتوانست جلوی اتصال‌های دیگر این کامپیوتر را بگیرد که بیرون از وی‌پی‌ان می‌روند. برنامه‌هایی که مستقیم از شبکه استفاده می‌کنند، و اتصال‌هایی که پیش از وصل شدن شما باز شده بودند، ممکن است هنوز برای شبکهٔ شما دیده شوند. اتصال را قطع کنید و دوباره وصل شوید. اگر باز تکرار شد، به پشتیبانی خبر بدهید.",
  "dash.ipv4NotConfinedIkev2":
    "پروتکل Built-in از وی‌پی‌ان خود دستگاه استفاده می‌کند و نئوکسیفای هنوز نمی‌تواند جلوی اتصال‌های دیگر این کامپیوتر را بگیرد که بیرون از آن می‌روند. برنامه‌هایی که مستقیم از شبکه استفاده می‌کنند، و اتصال‌هایی که پیش از وصل شدن شما باز شده بودند، ممکن است هنوز برای شبکهٔ شما دیده شوند. برای محافظت کامل، پروتکل دیگری انتخاب کنید.",
  "dash.customProblemInjectionRefused":
    "ویندوز بسته‌های هدایت‌شده را نمی‌پذیرد، برای همین برنامه‌هایی که انتخاب کرده‌اید به وی‌پی‌ان نمی‌رسند. معمولاً بستن و باز کردن دوبارهٔ نئوکسیفای مشکل را حل می‌کند.",
  "dash.customProblemNoReplies":
    "برنامه‌هایی که انتخاب کرده‌اید به وی‌پی‌ان فرستاده می‌شوند، ولی جوابی برنمی‌گردد و اتصالشان معطل می‌ماند. وی‌پی‌ان ترافیک آن‌ها را منتقل نمی‌کند.",
  "dash.customProblemNoAppTraffic":
    "هیچ‌کدام از برنامه‌هایی که انتخاب کرده‌اید ترافیکی نفرستاده است. اگر یکی از آن‌ها باز است، شاید برنامهٔ اشتباهی انتخاب شده باشد. بعضی برنامه‌ها با فایل اجرایی دیگری اجرا می‌شوند.",
  "dash.customProblemAdapterGone":
    "کارت شبکهٔ وی‌پی‌ان که حالت سفارشی از آن استفاده می‌کرد از بین رفت. برای همین حالت سفارشی متوقف شد و برنامه‌هایی که انتخاب کرده‌اید از اینترنت معمولی شما استفاده می‌کنند. برای محافظت دوباره، دوباره وصل شوید.",
  "dash.splitTunnelRestartNeeded":
    "‏{apps} پیش از اینکه انتخابش کنید باز بود. اتصال‌های تازه‌اش از وی‌پی‌ان می‌گذرند، ولی اتصال‌هایی که از قبل داشت نه، چون جابه‌جا کردنشان آن‌ها را قطع می‌کند. برای اینکه همهٔ ترافیکش از وی‌پی‌ان بگذرد، برنامه را ببندید و دوباره باز کنید.",
  "voucher.title": "کد هدیه دارید؟",
  "voucher.subtitle": "با وارد کردن کد، بدون پرداخت پلن بگیرید.",
  "voucher.placeholder": "کد خود را وارد کنید",
  "voucher.check": "بررسی",
  "voucher.valid": "این کد معتبر است",
  "voucher.days": "روز",
  "voucher.confirm": "فعال کردن این پلن",
  "voucher.cancel": "انصراف",
  "settings.general": "عمومی",
  "settings.account": "حساب کاربری",
  "settings.sections": "بخش‌ها",
  "settings.custom": "حالت سفارشی",
  "settings.customBeta": "آزمایشی",
  "settings.customHint": "انتخاب کنید کدام برنامه‌ها از وی‌پی‌ان استفاده کنند و کدام با اینترنت معمولی بمانند. این بخش تازه است؛ اگر چیزی درست کار نکرد به ما خبر بدهید.",
  "settings.customOn": "روشن",
  "settings.customOff": "خاموش",
  "settings.customAddApp": "افزودن برنامه",
  "settings.customNoApps": "هنوز برنامه‌ای انتخاب نکرده‌اید، پس چیزی از وی‌پی‌ان نمی‌گذرد. برای شروع یک برنامه اضافه کنید.",
  "settings.customRemove": "حذف",
  "settings.customApplies": "از اتصال بعدی اعمال می‌شود.",
  "settings.customFailOpen": "وقتی برنامه سرور را عوض می‌کند، برنامه‌های انتخابی شما برای چند لحظه از اینترنت معمولی استفاده می‌کنند تا قطع نشوند.",
  "settings.customIcmpTitle": "تا وقتی حالت سفارشی روشن است، پینگ کار نمی‌کند",
  "settings.customIcmpBody":
    "وی‌پی‌ان نمی‌تواند پینگ را منتقل کند، برای همین نئوکسیفای پینگ را برای همهٔ برنامه‌های این کامپیوتر مسدود می‌کند تا بیرون از وی‌پی‌ان نرود. اگر مسدود نشود، آدرس واقعی شما را به هر سروری که به آن برسد نشان می‌دهد و هر عدد تأخیری که نشان دهد مال اینترنت معمولی شماست، نه نئوکسیفای. بازی‌هایی که عدد پینگ نشان می‌دهند، تا وقتی این حالت روشن است چیزی نشان نمی‌دهند یا خطا می‌دهند.",
  "settings.customTooMany": "حداکثر {max} برنامه می‌توانید انتخاب کنید.",
  "settings.customAlready": "این برنامه از قبل در فهرست هست.",
  "settings.customModeOnly": "فقط این برنامه‌ها",
  "settings.customModeExcept": "همه به‌جز این‌ها",
  "settings.customModeOnlyHint": "فقط برنامه‌هایی که انتخاب می‌کنید از وی‌پی‌ان می‌گذرند. بقیه از اینترنت معمولی شما استفاده می‌کنند.",
  "settings.customModeExceptHint": "همه‌چیز از وی‌پی‌ان می‌گذرد، به‌جز برنامه‌هایی که انتخاب می‌کنید.",
  "settings.customNoAppsExcept": "هنوز برنامه‌ای انتخاب نکرده‌اید، پس همه‌چیز از وی‌پی‌ان می‌گذرد. برنامه‌ای را که نمی‌خواهید از وی‌پی‌ان بگذرد اضافه کنید.",
  "settings.customPickRunning": "انتخاب از برنامه‌های باز",
  "settings.customFileFilter": "برنامه‌ها",
  "settings.customPickFile": "پیدا کردن فایل برنامه",
  "settings.customRunningTitle": "برنامه‌های باز",
  "settings.customRunningEmpty": "چیزی برای نمایش نیست. فایل برنامه را خودتان پیدا کنید.",
  "settings.customSearchEmpty": "برنامه‌ای با این نام پیدا نشد.",
  "settings.customAppParts": "{count} برنامه که با هم از وی‌پی‌ان می‌گذرند",
  "settings.customRunningRefresh": "تازه‌سازی",
  "settings.customCancel": "انصراف",
  "settings.customAppUsesVpn": "با وی‌پی‌ان",
  "settings.customAppBypasses": "بدون وی‌پی‌ان",
  "settings.customPickGame": "افزودن بازی",
  "settings.customGameTitle": "افزودن برنامه‌های یک بازی",
  "settings.customGameHint":
    "نئوکسیفای فهرستی از برنامه‌هایی دارد که هر بازی احتمالاً از آن‌ها استفاده می‌کند. اول بازی یا لانچرش را باز کنید. نئوکسیفای برنامه‌هایی را که باز ببیند، با مسیر کاملشان اضافه می‌کند.",
  "settings.customGameParts": "{count} برنامه",
  "settings.customGameAdded": "{count} برنامه از {total} برنامهٔ {game} اضافه شد.",
  "settings.customGameMissing":
    "این‌ها باز نبودند و اضافه نشدند: {names}. بازشان کنید و بازی را دوباره اضافه کنید، یا از «پیدا کردن فایل برنامه» استفاده کنید.",
  "settings.customGameCompleted":
    "{game} حالا کامل است. نئوکسیفای {names} را باز دید و اضافه کرد، پس همهٔ بازی با هم از وی‌پی‌ان می‌گذرد.",
  "settings.customGameCompletedExit": "خروجی‌ای که برای {game} انتخاب کرده‌اید از اتصال بعدی اعمال می‌شود.",
  "settings.customGameRescanTooMany":
    "{game} هنوز کامل نیست. با اضافه کردن {names} از سقف {max} برنامه بیشتر می‌شد، برای همین چیزی برایش اضافه نشد، چون اضافه کردن فقط بخشی از یک بازی فایده‌ای ندارد. برای باز شدن جا، یک برنامه را حذف کنید.",
  "settings.customGameNone": "چیزی برای {game} اضافه نشد",
  "settings.customGameNoneBody":
    "نئوکسیفای دنبال این برنامه‌ها گشت و هیچ‌کدام باز نبود: {names}. اگر {game} همین الان باز است، این فهرست با نسخه‌ای که نصب کرده‌اید جور نیست. نام‌هایی که نئوکسیفای دارد از نسخهٔ استیم است و نصب‌کننده‌های دیگر نام‌های دیگری دارند. از «انتخاب از برنامه‌های در حال اجرا» استفاده کنید و خودتان آن را انتخاب کنید. این‌طوری درست اضافه می‌شود.",
  "settings.customGameNoneAction": "انتخاب از برنامه‌های در حال اجرا",
  "settings.customGameEmpty": "نئوکسیفای برای هیچ بازی‌ای فهرست برنامه ندارد.",
  "settings.customGameSplit": "فقط بخشی از {game} اضافه شده است",
  "settings.customGameSplitBody":
    "اضافه نشده: {names}. این‌ها با اینترنت معمولی شما می‌مانند. پس اگر یکی از آن‌ها باز شود در حالی که بقیهٔ {game} از نئوکسیفای می‌گذرد، بازی هم‌زمان از دو آدرس به سرورهایش وصل می‌شود. ناشران بازی این را نشانهٔ استفادهٔ چند نفر از یک حساب می‌دانند. همهٔ بخش‌های بازی را باز کنید و بعد بازی را دوباره اضافه کنید.",
  "settings.customGameExitPartial":
    "{game} از همان خروجی استفاده می‌کند که بقیهٔ ترافیک شما. همهٔ برنامه‌هایش اضافه نشده‌اند ({names}) و نئوکسیفای بخشی از یک بازی را روی خروجی جداگانه نمی‌گذارد.",
  "settings.customGameExitConflict":
    "{game} و {others} یک برنامهٔ مشترک دارند، پس نمی‌توانند دو خروجی متفاوت داشته باشند. تا وقتی خروجی هر دو را یکی نکنید، هر دو از همان خروجی استفاده می‌کنند که بقیهٔ ترافیک شما.",
  "settings.customGameExitOverCeiling":
    "{game} از همان خروجی استفاده می‌کند که بقیهٔ ترافیک شما. شما {chosen} خروجی متفاوت انتخاب کرده‌اید و نئوکسیفای هم‌زمان فقط {limit} خروجی را می‌تواند استفاده کند. چند بازی را روی یک خروجی مشترک بگذارید تا همه به خروجی‌هایی که انتخاب کرده‌اید بروند.",
  "settings.customExitTitle": "هر بازی از کجا وصل شود",
  "settings.customExitHint":
    "انتخاب کنید هر بازی از کدام کشور وصل به نظر برسد. بعضی سرورهای فهرست شما خروجی مشترک دارند، برای همین اینجا یک بار نشان داده می‌شوند.",
  "settings.customExitFor": "خروجی {game}",
  "settings.customExitNone": "مثل بقیهٔ ترافیک شما",
  "settings.customExitHidden": "خروجی‌ای که از {via} به آن می‌رسید",
  "settings.customExitDown": "(الان در دسترس نیست)",
  "settings.customExitGone": "خروجی‌ای که انتخاب کرده بودید و الان در دسترس نیست",
  "settings.customExitAtLimit": "{label} (حداکثر {limit} خروجی هم‌زمان)",
  "settings.customExitOnPreferred": "روی خروجی انتخابی شما",
  "settings.customExitFallback": "روی خروجی دیگری",
  "settings.customExitUnknown": "معلوم نیست",
  "settings.customExitNoPreference": "بدون ترجیح",
  "settings.customExitUnknownHint":
    "نئوکسیفای فقط وقتی می‌گوید یک بازی از کجا وصل است که واقعاً ترافیک آن بازی را منتقل کند. وصل شوید، بازی را باز کنید و دوباره به اینجا برگردید.",
  "settings.customExitFallbackHint":
    "{game} از خروجی همین اتصال می‌گذرد، نه خروجی‌ای که انتخاب کرده‌اید. بازی کار می‌کند. برای عوض کردنش، در صفحهٔ اصلی سرور را عوض کنید و دوباره وصل شوید.",
  "settings.customExitConcurrent":
    "حداکثر {limit} بازی می‌توانند هم‌زمان از {limit} خروجی متفاوت وصل شوند. بازی‌ای که خروجی برایش انتخاب نشده، و بقیهٔ چیزهایی که از وی‌پی‌ان می‌فرستید، از خروجی خود اتصال استفاده می‌کنند.",
  "settings.customExitXrayOnly":
    "این قابلیت به یکی از پروتکل‌های Xray نیاز دارد. با WireGuard، OpenVPN یا IKEv2 هر اتصال فقط یک خروجی دارد، پس همهٔ بازی‌ها از همان خروجی وصل می‌شوند. نئوکسیفای این را روی ردیف همان بازی نشان می‌دهد.",
  "settings.customAppScoped": "فقط سرورهای بازی",
  "settings.customAppScopedHint":
    "فقط ترافیک این برنامه به سرورهای خود بازی از وی‌پی‌ان می‌گذرد. بقیهٔ کارهایش با اینترنت معمولی شما انجام می‌شود.",
  "settings.customGameScoped":
    "فقط ترافیک {game} به سرورهای خود بازی از وی‌پی‌ان می‌گذرد. بقیهٔ کارهایش با اینترنت معمولی شما انجام می‌شود.",
  "settings.customGameWholeApp":
    "همهٔ ترافیک این برنامه‌ها از وی‌پی‌ان می‌گذرد. نئوکسیفای فهرست کامل آدرس سرورهای این بازی را ندارد و فرستادن فقط بخشی از آن‌ها از وی‌پی‌ان، از نفرستادن بدتر است.",
  "dash.offlineTitle": "الان به نئوکسیفای دسترسی نداریم. باز هم می‌توانید وصل شوید.",
  "dash.offlineTrying": "هنوز در تلاش برای دسترسی به نئوکسیفای هستیم. تا آن موقع می‌توانید با سرورهای ذخیره‌شده وصل شوید.",
  "dash.offlineAnswered": "نئوکسیفای الان نتوانست اطلاعات حساب شما را بیاورد. باز هم می‌توانید وصل شوید.",
  "dash.offlineHint":
    "از سرورهای ذخیره‌شده استفاده می‌شود. حجم مصرفی و تاریخ انقضا آخرین بار {when} به‌روز شده و ممکن است قدیمی باشد.",
  "dash.androidWireguardOnly":
    "{protocol} در برنامهٔ موبایل نیست، برای همین با Fast وصل می‌شود.",
  "settings.customAllApps":
    "هنوز برنامه‌ای انتخاب نکرده‌اید، پس همهٔ برنامه‌ها از وی‌پی‌ان استفاده می‌کنند. اگر می‌خواهید فقط یک برنامه از وی‌پی‌ان بگذرد، آن را انتخاب کنید.",
  "settings.customHintNative":
    "فقط برنامه‌هایی که انتخاب می‌کنید از وی‌پی‌ان می‌گذرند. بقیه از اینترنت معمولی شما استفاده می‌کنند.",
  "settings.customSearch": "جست‌وجوی برنامه‌ها",
  "settings.customNoMatches": "برنامه‌ای با این نام پیدا نشد.",
  "settings.customClear": "پاک کردن انتخاب‌ها",
  "settings.mismatch": "رمزها با هم یکی نیستند.",

  "dash.subscription": "پلن",
  "dash.retry": "تلاش دوباره",
  "dash.loadFailed": "اطلاعات حساب شما بارگذاری نشد.",
  "dash.changeLocation": "تغییر کشور",
  "dash.status.active": "فعال",
  "dash.server": "سرور",
  "dash.protocol": "پروتکل",
  "dash.session": "مدت اتصال",
  "dash.daysLeft": "روز مانده",
  "dash.change": "تغییر",
  "dash.disconnectToChange": "برای عوض کردن سرور یا پروتکل، اول اتصال را قطع کنید",
  "dash.protected": "ترافیک شما محافظت می‌شود",
  "dash.protectedHint": "اطلاعات شما رمزگذاری می‌شود و از نئوکسیفای می‌گذرد.",
  "dash.connectedNotConfined": "وصل است، ولی محافظت کامل نیست",
  "dash.connectedNotConfinedHint": "ترافیک شما از نئوکسیفای می‌گذرد، ولی ممکن است بعضی اتصال‌های این کامپیوتر هنوز بیرون از آن بروند.",
  "dash.notProtected": "ترافیک شما محافظت نمی‌شود",
  "dash.notProtectedHint": "وصل شوید تا ترافیکتان رمزگذاری و آی‌پی شما پنهان شود.",
  "dash.dropped": "اتصال وی‌پی‌ان قطع شد",
  "dash.droppedHint":
    "اتصال وی‌پی‌ان بسته شد. ترافیک شما الان بدون نئوکسیفای به اینترنت می‌رود و محافظت نمی‌شود. برای محافظت، دوباره وصل شوید.",
  "dash.reconnecting": "در حال اتصال دوباره...",
  "dash.reconnectingHint":
    "اتصال وی‌پی‌ان بسته شد. تا وقتی دوباره وصل شود، ترافیک شما بدون نئوکسیفای به اینترنت می‌رود و محافظت نمی‌شود.",
  "dash.reconnectingOfflineHint":
    "اتصال وی‌پی‌ان بسته شد و شبکه‌ای در دسترس نیست. نئوکسیفای وقتی شبکه برگردد دوباره وصل می‌شود. تا آن موقع ترافیک شما محافظت نمی‌شود.",
  "dash.waitingForNetwork": "منتظر اتصال به شبکه",
  "dash.waitingForNetworkHint":
    "این کامپیوتر به شبکه وصل نیست. نئوکسیفای به‌محض وصل شدن شبکه وصل می‌شود. تا آن موقع ترافیک شما محافظت نمی‌شود.",
  "dash.reconnectNow": "اتصال فوری",
  "dash.reconnectStop": "توقف تلاش برای اتصال",
  "dash.degraded": "ترافیکی منتقل نمی‌شود",
  "dash.degradedHint": "اتصال وی‌پی‌ان برقرار است، ولی سرور جواب نمی‌دهد. ترافیک شما محافظت نمی‌شود. دوباره وصل شوید یا سرور دیگری انتخاب کنید.",
  "dash.unverified": "وصل است، ولی تأیید نشده",
  "dash.unverifiedShort": "تأیید نشده",
  "dash.unverifiedHint":
    "اتصال وی‌پی‌ان برقرار است و نشانه‌ای از مشکل نیست، ولی نئوکسیفای نتوانست تأیید کند که ترافیک شما از آن می‌گذرد. اگر می‌خواهید مطمئن شوید، دوباره وصل شوید.",
  "dash.unverifiedCustomHint":
    "حالت سفارشی روشن است و اتصال وی‌پی‌ان برقرار است، ولی نئوکسیفای نتوانست تأیید کند که ترافیک برنامه‌های انتخابی شما به سرور می‌رسد. اگر می‌خواهید مطمئن شوید، دوباره وصل شوید.",
  "dash.verifying": "در حال بررسی اتصال...",
  "dash.verifyingHint": "در حال برقراری اتصال. نئوکسیفای پروتکل‌ها را یکی‌یکی امتحان می‌کند تا یکی کار کند. برای توقف کلیک کنید.",
  "dash.verifyingHintPhone": "در حال برقراری اتصال. نئوکسیفای پروتکل‌ها را یکی‌یکی امتحان می‌کند تا یکی کار کند. برای توقف لمس کنید.",
  "dash.waitingForNetworkHintPhone":
    "این دستگاه به شبکه وصل نیست. نئوکسیفای به‌محض وصل شدن شبکه وصل می‌شود. تا آن موقع ترافیک شما محافظت نمی‌شود.",
  "dash.vpnPermissionDenied":
    "اندروید برای ساختن اتصال وی‌پی‌ان به اجازهٔ شما نیاز دارد. دوباره «اتصال» را بزنید و در پنجره‌ای که باز می‌شود اجازه بدهید.",
  "dash.vpnPermissionDeniedIos":
    "iOS برای افزودن تنظیمات وی‌پی‌ان به اجازهٔ شما نیاز دارد. دوباره «اتصال» را بزنید و در پنجره‌ای که باز می‌شود «Allow» را انتخاب کنید.",
  "dash.unknown": "فعلاً معلوم نیست",
  "dash.unknownHint":
    "سرویس نئوکسیفای جواب نمی‌دهد، برای همین برنامه نمی‌تواند بگوید محافظت می‌شوید یا نه. برنامه مدام می‌پرسد. تا وقتی جواب نیامده، هیچ‌کدام را فرض نکنید.",
  "dash.recheck": "بررسی وضعیت",
  "dash.switchedTo": "پروتکل همیشگی شما وصل نشد. الان از {protocol} استفاده می‌شود",
  "dash.switchedServer": "به {from} وصل نشد. الان روی {to} با {protocol}",
  "dash.usedInstead": "به‌جای {from} از {to} با {protocol} استفاده شد. برای ماندن روی یک سرور، آن را انتخاب کنید.",
  "dash.switchedNoNetwork": "اول شبکه وصل نبود، برای همین {from} امتحان نشد. الان روی {to} با {protocol}",
  "dash.switchedToNoNetwork": "اول شبکه وصل نبود. الان از {protocol} استفاده می‌شود",
  "dash.nowUsing": "الان از {protocol} استفاده می‌شود",
  "dash.yourIp": "آی‌پی شما:",
  "err.serviceUnavailable": "سرویس پس‌زمینهٔ نئوکسیفای اجرا نمی‌شود. معمولاً بستن و باز کردن دوبارهٔ برنامه مشکل را حل می‌کند. اگر نشد، نئوکسیفای را دوباره نصب کنید.",
  "err.engineMissing": "بخشی از برنامه نصب نشده است. نئوکسیفای را دوباره نصب کنید.",
  "err.teardownStuck":
    "اتصال وی‌پی‌ان هنوز در حال بسته شدن است. اگر اینترنت شما وصل نشد، برنامه را ببندید و دوباره باز کنید.",
  "err.serverUnreachable": "به این سرور وصل نشد. شاید شبکهٔ شما آن را بسته باشد. کشور دیگری را امتحان کنید.",
  "err.notCarryingTraffic": "وصل شد، ولی ترافیکی منتقل نشد.",
  "err.allProtocolsFailed": "همهٔ پروتکل‌های موجود امتحان شد و هیچ‌کدام ترافیک را منتقل نکرد.",
  "err.someProtocolsNotTried":
    "هیچ‌کدام از پروتکل‌هایی که امتحان شد ترافیک را منتقل نکرد. بعضی پروتکل‌ها فقط وقتی «اتصال» را بزنید امتحان می‌شوند.",
  "err.notEveryProtocolTried":
    "هیچ‌کدام از پروتکل‌هایی که امتحان شد ترافیک را منتقل نکرد. بقیه این بار امتحان نشدند.",
  "err.concurrentLimit": "سقف دستگاه‌های پلن شما پر است. اتصال یکی از دستگاه‌های دیگر را قطع کنید و دوباره امتحان کنید.",
  "err.quotaExhausted": "حجم پلن شما تمام شده است. پلن را ارتقا دهید یا صبر کنید تا تمدید شود.",
  "err.subscriptionInactive": "پلن شما الان فعال نیست. وضعیتش را در صفحهٔ اصلی ببینید.",
  "err.connectBusy": "نئوکسیفای در حال وصل شدن است. کمی صبر کنید و دوباره امتحان کنید.",
  "err.noNetwork": "شبکه وصل نیست. مطمئن شوید این دستگاه به اینترنت وصل است و دوباره امتحان کنید.",
  "err.unknown": "وصل نشد.",
  "err.showDetail": "جزئیات فنی",

  "slots.limitOne": "پلن شما هم‌زمان فقط روی یک دستگاه کار می‌کند.",
  "slots.limitMany": "پلن شما هم‌زمان روی {limit} دستگاه کار می‌کند.",
  "slots.inUseOn": "نئوکسیفای از {time} روی {device} در حال استفاده است.",
  "slots.inUseOnNoTime": "نئوکسیفای روی {device} در حال استفاده است.",
  "slots.inUseOnMany": "نئوکسیفای روی این دستگاه‌ها در حال استفاده است: {devices}.",
  "slots.deviceSince": "{device} (از {time})",
  "slots.anotherDevice": "دستگاهی دیگر",
  "slots.useHere": "استفاده روی همین دستگاه",
  "slots.cancel": "انصراف",
  "slots.dismiss": "بستن",
  "slots.displaced": "اتصال قطع شد: نئوکسیفای الان روی {device} در حال استفاده است.",
  "slots.nowInUseOn": "نئوکسیفای الان روی {device} در حال استفاده است.",
  "slots.takeoverLimit": "در یک ساعت گذشته بیش از حد دستگاه عوض کرده‌اید. {minutes} دقیقهٔ دیگر دوباره امتحان کنید.",
  "slots.teardownStuck":
    "پلن شما الان روی این دستگاه قابل استفاده نیست. هنوز در حال قطع اتصال است و بسته شدن اتصال وی‌پی‌ان هنوز تأیید نشده.",
  "slots.unchecked":
    "برای بررسی به نئوکسیفای دسترسی پیدا نکردیم. اگر روی دستگاه دیگری از نئوکسیفای استفاده می‌کنید، ممکن است دلیلش سقف {limit} دستگاه هم‌زمان در پلن شما باشد.",
  "slots.unconfirmed":
    "نئوکسیفای الان نتوانست جای این دستگاه را در پلن شما تأیید کند. اگر روی دستگاه دیگری از نئوکسیفای استفاده می‌کنید، ممکن است دلیلش سقف {limit} دستگاه هم‌زمان در پلن شما باشد.",
  "slots.platformWindows": "یک کامپیوتر ویندوزی",
  "slots.platformMac": "یک مک",
  "slots.platformLinux": "یک کامپیوتر لینوکسی",
  "slots.platformAndroid": "یک گوشی اندروید",
  "slots.platformIos": "یک آیفون",

  "settings.repair": "رفع مشکل شبکه",
  "repair.title": "رفع مشکل شبکه",
  "repair.subtitle": "هرچه نئوکسیفای در ویندوز جا گذاشته پاک می‌شود.",
  "repair.explain":
    "نئوکسیفای این‌ها را پیدا و پاک می‌کند: موتورهای وی‌پی‌ان که هنوز باز مانده‌اند، قانون DNS که موقع اتصال می‌گذارد، مسیرهای روی کارت‌های شبکهٔ خودش، قانون فایروالش، سرویس تونل WireGuard جامانده و نامش در فهرست وی‌پی‌ان ویندوز. بعد هم کش DNS را پاک می‌کند.",
  "repair.disconnects": "اگر وصل باشید، اول اتصال قطع می‌شود.",
  "repair.safety":
    "این کار فقط چیزهایی را پاک می‌کند. هیچ ترافیکی را مسدود نمی‌کند و به تنظیمات معمولی اینترنت شما دست نمی‌زند.",
  "repair.run": "شروع رفع مشکل",
  "repair.running": "در حال رفع مشکل...",
  "repair.runAgain": "انجام دوباره",
  "repair.resultClean": "چیزی جا نمانده بود. تنظیمات شبکهٔ شما همان تنظیمات خود ویندوز است.",
  "repair.resultFixed": "مشکل رفع شد. دوباره وصل شوید.",
  "repair.resultUnverified":
    "کار انجام شد، ولی یکی از بررسی‌ها تمام نشد، برای همین نتیجه قابل تأیید نیست. معمولاً فقط یعنی کامپیوتر کند بوده. دوباره وصل شوید. اگر باز وصل نشد، دستور زیر را با دسترسی Administrator اجرا کنید و خروجی‌اش را برای ما بفرستید.",
  "repair.resultProblems":
    "بخشی از مشکل رفع نشد. معمولاً با راه‌اندازی دوبارهٔ ویندوز بقیه هم پاک می‌شود. اگر نشد، دستور زیر را با دسترسی Administrator اجرا کنید و خروجی‌اش را برای ما بفرستید.",
  "repair.failed": "رفع مشکل انجام نشد.",
  "repair.stepClean": "چیزی پیدا نشد",
  "repair.stepFixed": "پاک شد",
  "repair.stepFailed": "هنوز هست",
  "repair.stepUnknown": "بررسی نشد",
  "repair.step.tunnel": "اتصال وی‌پی‌ان و حالت سفارشی",
  "repair.step.engines": "موتورهای وی‌پی‌ان جامانده",
  "repair.step.dns": "قانون DNS وی‌پی‌ان",
  "repair.step.routes": "مسیرهای روی کارت‌های شبکهٔ نئوکسیفای",
  "repair.step.firewall": "قانون فایروال حالت سفارشی",
  "repair.step.wfp": "فیلترهای ترافیک ویندوز",
  "repair.step.wireguardService": "سرویس تونل WireGuard جامانده",
  "repair.step.ras": "نئوکسیفای در فهرست وی‌پی‌ان ویندوز",
  "repair.step.dnsCache": "کش DNS",
  "repair.noService": "سرویس نئوکسیفای جواب نمی‌دهد، برای همین برنامه نمی‌تواند این کار را برایتان انجام دهد.",
  "repair.noServiceHint":
    "منوی Start را باز کنید، cmd را بنویسید، روی Command Prompt راست‌کلیک کنید و «Run as administrator» را بزنید. بعد این دستور را اجرا کنید:",
  "repair.copyCommand": "کپی دستور",
  "repair.copied": "کپی شد",
  "repair.inlineCta": "اگر هنوز وصل نمی‌شوید، مشکل شبکه را رفع کنید",

  "diag.title": "اطلاعات برای پشتیبانی",
  "diag.subtitle":
    "خلاصهٔ کوتاهی از وضعیت نئوکسیفای روی این کامپیوتر. آن را در پیامتان بگذارید تا ما هم همان چیزی را ببینیم که شما می‌بینید.",
  "diag.collect": "جمع کردن اطلاعات",
  "diag.collecting": "در حال جمع کردن...",
  "diag.copy": "کپی",
  "diag.copied": "کپی شد",
  "diag.privacy":
    "رمز عبور، کلید، مشخصات سرور و هیچ اطلاعاتی دربارهٔ سایت‌هایی که باز می‌کنید در آن نیست. پیش از ارسال می‌توانید همه‌اش را بخوانید.",
  "diag.failed": "سرویس نئوکسیفای جواب نمی‌دهد، برای همین چیزی برای جمع کردن نیست.",

  "plans.back": "بازگشت",
  "plans.perDays": "برای {days} روز",
  "plans.data": "حجم",
  "plans.speed": "سرعت",
  "plans.devices": "دستگاه",
  "plans.unlimited": "نامحدود",
  "plans.buyWithAppStore": "خرید از اپ‌استور",
  "plans.noneAvailable": "الان پلنی برای خرید در اینجا نیست. کمی بعد دوباره سر بزنید.",
  "plans.upTo": "تا {n} مگابیت",
  "plans.devicesAtOnce": "{n} هم‌زمان",
  "plans.bestValue": "به‌صرفه‌ترین",
  "plans.payWith": "پرداخت با",
  "plans.amount": "مبلغ",
  "plans.toAddress": "به این آدرس",
  "plans.openCheckout": "باز کردن صفحهٔ پرداخت",
  "plans.copied": "کپی شد",
  "plans.browserFailed": "مرورگر باز نشد. با دکمهٔ زیر دوباره امتحان کنید.",
  "plans.copyAddress": "کپی آدرس",

  // Gaming mode. The Persian carries the honest wording too, not a
  // softened translation -- «شما محافظت می‌شوید» must never appear on a
  // screen where nothing is tunnelled, and nothing here says it.
  "dash.modeVpn": "وی‌پی‌ان",
  "dash.modeGaming": "بازی",
  "dash.modeVpnHint": "همهٔ ترافیک این کامپیوتر از نئوکسیفای می‌گذرد.",
  "dash.modeVpnHintNotConfined": "قرار است همهٔ ترافیک این کامپیوتر از نئوکسیفای بگذرد، ولی الان ممکن است بعضی اتصال‌ها بیرون از آن بروند.",
  "dash.modeCustomHint": "حالت سفارشی: فقط برنامه‌هایی که انتخاب کرده‌اید از نئوکسیفای می‌گذرند.",
  "dash.modeCustomExceptHint": "حالت سفارشی: همه‌چیز به‌جز برنامه‌هایی که انتخاب کرده‌اید از نئوکسیفای می‌گذرد.",
  "dash.modeGamingHint":
    "فقط لانچر، ورود و به‌روزرسانی بازی‌هایی که انتخاب می‌کنید از نئوکسیفای می‌گذرد. اتصال خود بازی از نئوکسیفای نمی‌گذرد و این حالت آن را سریع‌تر نمی‌کند.",

  "gaming.off": "حالت بازی خاموش است",
  "gaming.offHint":
    "الان چیزی هدایت نمی‌شود. روشنش کنید تا لانچر، ورود و به‌روزرسانی بازی‌هایی که انتخاب کرده‌اید از نئوکسیفای بگذرد.",
  "gaming.arming": "در حال آماده‌سازی...",
  "gaming.armingHint": "در حال تنظیم قانون‌ها برای بازی‌هایی که انتخاب کرده‌اید.",
  "gaming.active": "حالت بازی روشن است",
  "gaming.activeHint":
    "لانچر، ورود و به‌روزرسانی بازی‌هایی که انتخاب کرده‌اید از نئوکسیفای می‌گذرد و این سرویس‌ها آدرس نئوکسیفای را می‌بینند. اتصال خود بازی از نئوکسیفای نمی‌گذرد.",
  "gaming.partial": "حالت بازی روشن است، ولی تأیید نشده",
  "gaming.partialHint":
    "حالت بازی روشن است، اما نئوکسیفای نتوانست تأیید کند که ترافیک بازی شما به آن می‌رسد.",
  "gaming.unknown": "فعلاً معلوم نیست",
  "gaming.unknownHint":
    "نئوکسیفای نتوانست از سرویس پس‌زمینه بپرسد چه چیزی تنظیم شده، برای همین نمی‌تواند بگوید حالت بازی روشن است یا نه.",
  "gaming.pathDirect": "اتصال بازی: بدون نئوکسیفای",
  "gaming.ipUnchanged":
    "سرویس‌هایی که هدایت می‌شوند از سرور نئوکسیفای باز می‌شوند و آدرس آن را می‌بینند. بقیهٔ ترافیک این کامپیوتر، از جمله خود بازی، با اینترنت معمولی و آدرس خود شما می‌ماند.",
  "gaming.noSpeedClaim":
    "نئوکسیفای پینگ را اندازه نمی‌گیرد و قول اتصال سریع‌تر نمی‌دهد. این حالت برای دسترسی به یک سرویس است و سرعت را عوض نمی‌کند.",
  "gaming.turnOn": "روشن کردن",
  "gaming.turnOff": "خاموش کردن",
  "gaming.noneRedirectable":
    "برای هیچ‌کدام از بازی‌های فهرست نمی‌شود لانچر را هدایت کرد، پس چیزی برای اضافه کردن نیست. «حالت سفارشی» برنامه‌های خود بازی را از وی‌پی‌ان می‌فرستد و به این نیاز ندارد.",
  "gaming.noGames": "هیچ بازی‌ای انتخاب نشده، پس حالت بازی کاری نمی‌کند. از پایین یک بازی اضافه کنید.",
  "gaming.noGamesDash":
    "هیچ بازی‌ای انتخاب نشده، پس حالت بازی کاری نمی‌کند. اول در تنظیمات یک بازی انتخاب کنید.",
  "gaming.armFailed": "حالت بازی روشن نشد.",
  "gaming.needsPlan": "حالت بازی به پلن فعال نیاز دارد.",
  "gaming.notInPlan": "پلن شما حالت بازی ندارد.",
  // «هنوز» حذف شد — به en توضیح داده شده است.
  "gaming.noResolver": "حالت بازی روی سرور شما در دسترس نیست.",
  "gaming.noResolverBody":
    "این قطعی موقت نیست. هیچ سرور نئوکسیفای این هدایت را ارائه نمی‌دهد، پس روی این کامپیوتر چیزی هدایت نمی‌شود و روشن کردن این گزینه هم چیزی را عوض نمی‌کند. «حالت سفارشی» به این نیاز ندارد و همین الان کار می‌کند.",
  "gaming.profileFailed": "فهرست بازی‌ها بارگذاری نشد.",
  "gaming.retry": "تلاش دوباره",
  "gaming.loading": "در حال بارگذاری بازی‌ها...",

  "settings.gaming": "بازی",
  "gaming.title": "حالت بازی",
  "gaming.hint":
    "لانچر، ورود و به‌روزرسانی یک بازی را از نئوکسیفای بفرستید. اتصال خود بازی با اینترنت معمولی شما می‌ماند.",
  "gaming.chosen": "بازی‌هایی که انتخاب کرده‌اید",
  "gaming.addGame": "افزودن بازی",
  "gaming.remove": "حذف",
  "gaming.redirects": "لانچر، ورود و به‌روزرسانی‌ها",
  "gaming.applies": "تا وقتی حالت بازی روشن است، تغییرات فوراً اعمال می‌شود.",
  "gaming.pickerTitle": "انتخاب بازی",
  "gaming.search": "جست‌وجوی بازی",
  "gaming.pickerMeaning":
    "هر مورد برنامه‌هایی را نشان می‌دهد که نئوکسیفای، وقتی باز باشند، از وی‌پی‌ان می‌فرستد. هیچ‌کدام روی بازیِ در حال اجرا آزمایش نشده است.",
  "gaming.searchEmpty": "بازی‌ای با این نام پیدا نشد.",
  "gaming.searchMore": "{count} بازی دیگر هم پیدا شد. برای محدود کردن نتیجه‌ها بیشتر بنویسید.",
  "gaming.listMore": "{shown} بازی از {count} بازی نمایش داده شده. برای پیدا کردن بازی خود اسمش را بنویسید.",
  "gaming.listEmpty": "هیچ بازی‌ای در فهرست نیست.",
  "gaming.cancel": "انصراف",
  "pick.added": "اضافه شد",
  "gaming.tooMany": "حداکثر {max} بازی می‌توانید انتخاب کنید.",
  "gaming.games": "بازی‌ها",
  "gaming.resolver": "سرور DNS",
  "gaming.accountRisk": "مراقب حساب بازی‌تان باشید",
  "gaming.accountRiskBody":
    "حساب‌ها معمولاً به خاطر تشخیص وی‌پی‌ان از دست نمی‌روند. بیشتر وقتی از دست می‌روند که خود بازیکن به پشتیبانی بگوید کجاست. یک بازیکن بعد از اینکه در تیکت پشتیبانی به محل زندگی‌اش اشاره کرد، هفت سال پیشرفتش را از دست داد. اگر با پشتیبانی یک بازی تماس گرفتید، فقط به سؤال‌هایشان جواب بدهید و دربارهٔ محل خود یا استفاده از وی‌پی‌ان چیزی نگویید.",

  "common.loading": "در حال بارگذاری...",
  "common.stillTrying": "بیشتر از معمول طول کشیده. هنوز در حال تلاش...",

  "api.unreachable": "به نئوکسیفای دسترسی پیدا نکردیم. اینترنت خود را بررسی کنید.",
  "api.stoppedAnswering": "نئوکسیفای جواب داد ولی بعد دیگر جوابی نداد. دوباره امتحان کنید.",
  "api.serverError": "سرور با خطا جواب داد ({status}). کمی بعد دوباره امتحان کنید.",
  "api.blockedByNetwork": "شبکهٔ شما نئوکسیفای را مسدود کرده است و آدرس‌هایش به صفحهٔ مسدودسازی می‌رسد.",
  "api.renewalUnanswered": "نئوکسیفای جواب داد، ولی برای تمدید ورود شما جوابی نیامد. دوباره امتحان کنید.",
  "api.renewalFailed": "تمدید ورود شما الان انجام نشد. کمی بعد دوباره امتحان کنید.",

  "disclosure.title": "پیش از اتصال",
  "disclosure.subtitle": "این برنامه چه کار می‌کند و چه اطلاعاتی جمع می‌کنیم. لطفاً یک بار بخوانید.",
  "disclosure.vpnHeading": "چرا نئوکسیفای به اجازهٔ وی‌پی‌ان نیاز دارد",
  "disclosure.vpnBody":
    "نئوکسیفای یک وی‌پی‌ان است. گوشی شما برای ساختن اتصال وی‌پی‌ان از شما اجازه می‌گیرد و برنامه بدون این اجازه کار نمی‌کند.",
  "disclosure.vpnBody2":
    "وقتی وصل هستید، برنامه یک اتصال رمزگذاری‌شده می‌سازد و ترافیک اینترنت دستگاه شما را از سروری که انتخاب می‌کنید می‌فرستد. این‌طوری اتصال شما خصوصی می‌ماند و سایت‌هایی را که شبکه‌تان بسته باز می‌کنید. در حالت سفارشی خودتان انتخاب می‌کنید کدام برنامه‌ها از وی‌پی‌ان استفاده کنند و بقیه عادی وصل می‌شوند. وقتی وصل نیستید، هیچ ترافیکی از وی‌پی‌ان نمی‌گذرد.",
  "disclosure.dataHeading": "چه اطلاعاتی جمع می‌کنیم و چرا",
  "disclosure.dataEmail":
    "آدرس ایمیل و شناسهٔ حساب شما، برای ساختن حساب، ورود شما و تماس با شما دربارهٔ حسابتان.",
  "disclosure.dataSupport":
    "پیام‌هایی که از داخل برنامه به پشتیبانی می‌فرستید، تا بتوانیم جواب بدهیم.",
  "disclosure.dataDiagnostics":
    "اطلاعات عیب‌یابی اتصال، تا بتوانیم مشکل‌ها را پیدا و رفع کنیم. این شامل موفق بودن یا نبودن اتصال، سرور و پروتکلی که استفاده شد، نسخهٔ برنامه و پیام خطاست.",
  "disclosure.dataServerLogs":
    "سرورهای وی‌پی‌ان ما برای اداره کردن سرویس و پیدا کردن مشکل‌ها گزارش کار نگه می‌دارند که ممکن است سابقهٔ اتصال‌ها هم در آن باشد.",
  "disclosure.dataNotSold":
    "ما اطلاعات شما را نمی‌فروشیم و برای تبلیغات به کسی نمی‌دهیم. در حالت سفارشی، فهرست برنامه‌هایی که انتخاب می‌کنید هیچ‌وقت از این دستگاه بیرون نمی‌رود.",
  "disclosure.privacyLink": "متن کامل سیاست حریم خصوصی",
  "disclosure.accept": "می‌پذیرم و ادامه می‌دهم",
  "relay.chip": "داده‌های برنامه: مسیر پشتیبان",
  "relay.blocked": "راه‌های معمول نئوکسیفای در این شبکه مسدود است.",
  "relay.intranet": "اینترنت بین‌الملل قطع است و فقط شبکهٔ ملی کار می‌کند. نئوکسیفای فقط از مسیر پشتیبان در دسترس است.",
  "relay.intranetLimits": "تا وقتی فقط شبکهٔ ملی کار می‌کند، ورود با گوگل، اپل یا فیس‌بوک و کدهایی که با ایمیل فرستاده می‌شوند ممکن است کار نکنند. با رمز عبور وارد شوید و اگر آن را فراموش کردید، از کد بازیابی استفاده کنید.",
  "relay.region": "مسیر پشتیبان فقط برای اتصال از داخل همان کشوری است که سرورش آنجاست.",
  "relay.regionUnknown": "تأیید نشد که این اتصال از داخل کشور سرور پشتیبان است، برای همین فعلاً نمی‌توانید با این اتصال از مسیر پشتیبان ثبت‌نام کنید.",
  "relay.disconnect": "برای استفاده از مسیر پشتیبان، اتصال را قطع کنید.",
  "relay.unavailable": "مسیر پشتیبان الان در دسترس نیست.",
  "relay.signupOff": "الان نمی‌توانید از مسیر پشتیبان ثبت‌نام کنید.",
  "relay.signupLimit": "الان تعداد ثبت‌نام‌ها از مسیر پشتیبان زیاد است. بعداً دوباره امتحان کنید.",
  "relay.signupTitle": "ثبت‌نام از مسیر پشتیبان",
  "relay.signupNote": "چون از مسیر پشتیبان ثبت‌نام می‌کنید، فعلاً لازم نیست ایمیلتان را تأیید کنید. ایمیلی وارد کنید که بعداً بتوانید بازش کنید؛ برای تأیید و بازیابی حساب به آن نیاز دارید.",
  "relay.offerSignup": "ثبت‌نام از مسیر پشتیبان",
  "relay.confirmEmail": "تکرار ایمیل",
  "relay.emailMismatch": "دو ایمیل با هم یکی نیستند.",
  "relay.disposableEmail": "ایمیلی وارد کنید که بعداً بتوانید بازش کنید. ایمیل موقت قبول نمی‌شود.",
  "relay.created": "حساب ساخته شد. تا وقتی ایمیلتان را تأیید نکنید، این حساب فقط می‌تواند از پلن Ultimate استفاده کند. یک کد هدیهٔ Ultimate وارد کنید.",
  "relay.continue": "ادامه",
  "relay.checkoutUnavailable": "پرداخت با کارت و رمزارز از مسیر پشتیبان ممکن نیست. به‌جای آن از کد هدیهٔ Ultimate استفاده کنید.",
  "relay.otherPlansAbroad": "پلن‌های دیگر به‌جز Ultimate از سرورهای خارج از کشور استفاده می‌کنند که وقتی فقط شبکهٔ ملی کار می‌کند در دسترس نیستند.",
  "voucher.notAllowed": "از مسیر پشتیبان، یا تا وقتی ایمیلتان را تأیید نکرده‌اید، فقط می‌توانید از کد هدیهٔ یک‌بارمصرف Ultimate استفاده کنید.",
  "recovery.title": "کد بازیابی شما",
  "recovery.save": "این کد بازیابی را جای امنی نگه دارید. اگر نتوانید ایمیلتان را باز کنید، فقط با همین کد می‌توانید رمز عبور را عوض کنید. این کد فقط یک بار نمایش داده می‌شود.",
  "recovery.copy": "کپی",
  "recovery.copied": "کپی شد",
  "recovery.saved": "ذخیره‌اش کردم",
  "recovery.settingsTitle": "کد بازیابی",
  "recovery.settingsHint": "اگر نتوانید ایمیلتان را باز کنید، کد بازیابی تنها راه عوض کردن رمز عبور است. اگر در کشوری هستید که اینترنت در آن محدود است، حتماً یکی بسازید.",
  "recovery.none": "هنوز کد بازیابی ندارید.",
  "recovery.has": "کد بازیابی دارید.",
  "recovery.create": "ساختن کد بازیابی",
  "recovery.replace": "عوض کردن کد بازیابی",
  "recovery.replaceWarning": "کد بازیابی قبلی دیگر کار نمی‌کند.",
  "recovery.creating": "در حال ساخت...",
  "recovery.reauth": "دوباره وارد شوید و تا ۱۵ دقیقه این کار را انجام دهید.",
  "forgot.relayHint": "کد بازنشانی با ایمیل فرستاده می‌شود. اگر به ایمیل خود دسترسی ندارید، از کد بازیابی خود استفاده کنید.",
  "forgot.useRecovery": "استفاده از کد بازیابی",
  "forgot.useEmail": "دریافت کد بازنشانی با ایمیل",
  "forgot.recoveryCode": "کد بازیابی",
  "forgot.recoveryDone": "رمز عبور عوض شد. این کد بازیابی جدید شماست و کد قبلی دیگر کار نمی‌کند.",
  "verify.reminder": "برای استفاده از همهٔ پلن‌ها و روش‌های پرداخت، ایمیلتان را تأیید کنید. پلن فعلی شما تغییری نمی‌کند.",
  "verify.reminderAction": "تأیید ایمیل",
  "verify.sendCode": "ارسال کد به ایمیل",
  "verify.confirmed": "ایمیل شما تأیید شد.",
  "verify.required": "برای استفاده از این بخش، ایمیلتان را تأیید کنید.",
  "unverified.change": "تغییر ایمیل",
  "unverified.newEmail": "ایمیل جدید",
  "unverified.limit": "ایمیل را روزی سه بار می‌توانید عوض کنید.",
  "unverified.changed": "ایمیل عوض شد. هر وقت توانستید تأییدش کنید.",
  "setpw.title": "تعیین رمز عبور",
  "setpw.hint": "شما با گوگل، اپل یا فیس‌بوک وارد می‌شوید و وقتی فقط شبکهٔ ملی کار می‌کند، به این‌ها دسترسی نیست. با داشتن رمز عبور باز هم می‌توانید وارد شوید.",
  "setpw.submit": "ثبت رمز عبور",
  "setpw.done": "رمز عبور ثبت شد.",
  "settings.backupRoute": "مسیر پشتیبان",
  "settings.backupRouteHint": "وقتی نئوکسیفای از راه معمول در دسترس نیست، برنامه درخواست‌های خودش (ورود، حساب کاربری، فهرست سرورها و کدهای هدیه) را به‌طور خودکار از سرور پشتیبان نئوکسیفای در داخل کشور شما می‌فرستد، مگر اینکه این گزینه را همین‌جا خاموش کنید. اگر سرورهای ما ببینند این دستگاه بیرون از آن کشور است، مسیر پشتیبان روی آن شبکه یک روز خاموش می‌شود. اطلاعات شما رمزگذاری‌شده می‌ماند و میزبان سرور فقط می‌بیند که این دستگاه وصل شده، نه اینکه چه فرستاده.",
  "settings.backupRouteToggle": "استفاده از مسیر پشتیبان",
  "settings.backupRouteInUse": "الان در حال استفاده است.",
  "api.unreachableWithBackup": "به نئوکسیفای دسترسی پیدا نکردیم، حتی از سرور پشتیبان. بعداً دوباره امتحان کنید.",
  // Pearl Glass redesign, phase 1: the main page (design-system.md, section 10).
  "tagline.line1": "اینترنت شما.",
  "tagline.line2": "بدون محدودیت.",
  "tagline.mobile1": "کمی آزادیِ",
  "tagline.mobile2": "بیشتر.",
  "chip.idle": "وصل نیست",
  "chip.connecting": "در حال اتصال",
  "chip.verifying": "در حال بررسی",
  "chip.connected": "متصل",
  "chip.unconfined": "محافظت ناقص",
  "chip.unverified": "تأیید نشده",
  "chip.degraded": "بدون ترافیک",
  "chip.reconnecting": "اتصال دوباره",
  "chip.disconnecting": "در حال قطع",
  "chip.unknown": "وضعیت نامشخص",
  "chip.dropped": "اتصال قطع شد",
  "chip.noNetwork": "بدون شبکه",
  "chip.gamingOff": "حالت بازی خاموش",
  "chip.gamingOn": "حالت بازی روشن",
  "chip.gamingArming": "در حال آماده‌سازی",
  "chip.gamingPartial": "تأیید نشده",
  "chip.gamingUnknown": "وضعیت نامشخص",
  "btn.connect": "اتصال",
  "btn.disconnect": "قطع اتصال",
  "btn.connecting": "در حال اتصال...",
  "btn.checking": "در حال بررسی...",
  "btn.waiting": "منتظر شبکه...",
  "btn.disconnecting": "در حال قطع...",
  "btn.stop": "توقف اتصال",
  "btn.tryAnother": "امتحان کشور دیگر",
  "btn.stopShort": "توقف",
  "btn.tryAnotherShort": "کشور دیگر",
  "btn.recheck": "بررسی دوباره",
  "btn.tryAgain": "تلاش دوباره",
  "btn.cancel": "انصراف",
  "nav.main": "اصلی",
  "nav.overview": "نمای کلی",
  "nav.locations": "سرورها",
  "nav.home": "خانه",
  "nav.plans": "پلن و پرداخت",
  "nav.plansStore": "پلن‌ها",
  "nav.support": "پشتیبانی",
  "nav.account": "منوی حساب",
  "menu.signedIn": "وارد شده با {email}",
  "menu.version": "نئوکسیفای {version}",
  "tb.minimize": "کوچک کردن",
  "tb.maximize": "بزرگ کردن",
  "tb.restore": "اندازهٔ قبلی",
  "tb.close": "بستن",
  "mode.label": "حالت",
  "mode.vpnHintIdle": "وقتی وصل باشید، همهٔ ترافیک این کامپیوتر از نئوکسیفای می‌گذرد.",
  "mode.gamingHintShort": "فقط سرویس‌های بازی‌هایی که انتخاب می‌کنید از نئوکسیفای می‌گذرند.",
  "mode.locked": "برای تغییر حالت، اتصال را قطع کنید",
  "more.below": "ادامه در پایین",
  "tr.location": "کشور",
  "tr.change": "تغییر کشور",
  "tr.plan": "پلن",
  "tr.planUnl": "پلن نامحدود",
  "tr.used": "{size} مصرف‌شده",
  "tr.ofCap": "از {cap}",
  "notes.details": "جزئیات اتصال",
  "tr.daysLeft": "{n} روز مانده",
  "tr.dayLeft": "{n} روز مانده",
  "tr.renew": "تمدید",
  "tr.ip": "آی‌پی شما",
  "tr.ipPending": "بعد از تأیید اتصال نمایش داده می‌شود",
  "tr.ipOff": "وصل نیست",
  "tr.ipGaming": "برای خود بازی عوض نمی‌شود",
  "tr.gamesChosen": "{n} انتخاب‌شده",
  "tr.noPlan": "بدون پلن",
  "loc.panelTitle": "سرورها",
  "loc.measure": "اندازه‌گیری تأخیر",
  "loc.pausedNote": "تأخیر فقط وقتی وصل نیستید اندازه‌گیری می‌شود.",
  "loc.notLoaded": "فهرست سرورها بارگذاری نشد.",
  "loc.noLocations": "پلن فعلی شما سروری ندارد.",
  "loc.relayPill": "مسیر پشتیبان",
  "loc.fAll": "همه",
  "loc.fWorked": "کار کرده",
  "loc.connectedHere": "الان وصل",
  "loc.inUse": "در حال استفاده",
  "sw.title": "تغییر به {place}؟",
  "sw.titleAuto": "تغییر به خودکار؟",
  "sw.body": "نئوکسیفای اتصال را قطع می‌کند و دوباره وصل می‌شود. تا وقتی اتصال جدید بررسی نشده، ترافیک شما محافظت نمی‌شود.",
  "sw.bodyHeld": "نئوکسیفای دوباره به کشور جدید وصل می‌شود. طبق تنظیم شما، اتصال‌های دیگر این کامپیوتر الان مسدود هستند. ولی هنگام عوض شدن سرور، ممکن است تا بررسی اتصال جدید بدون نئوکسیفای به اینترنت بروند.",
  "sw.bodyHeldNotCovered": "طبق تنظیم شما، اتصال‌های دیگر این کامپیوتر الان مسدود هستند. این مسدودسازی شامل Built-in (IKEv2) و حالت سفارشی نمی‌شود، برای همین نئوکسیفای پیش از این اتصال آن را برمی‌دارد. تا وقتی اتصال جدید بررسی نشده، ترافیک شما بدون نئوکسیفای به اینترنت می‌رود.",
  "sw.bodyHoldUnconfirmed": "نئوکسیفای دوباره به کشور جدید وصل می‌شود. هنوز تأیید نشده که اتصال‌های دیگر این کامپیوتر، طبق تنظیم شما، مسدود هستند. تا وقتی اتصال جدید بررسی نشده، ممکن است بدون نئوکسیفای به اینترنت بروند.",
  "sw.go": "تغییر",
  "sw.stay": "همین اتصال بماند",
  "dash.noProvision": "روی پلن شما اتصالی تنظیم نشده است.",
  "decor.browse": "وب‌گردی",
  "decor.stream": "تماشا",
  "decor.work": "کار",
  "decor.anywhere": "هر جا",
  "map.legend": "چراغ‌های نقشه برای شبکه‌ای که الان به آن وصل هستید",
  "map.live": "اینجا کار کرده",
  "map.idle": "هنوز تأیید نشده",
  "map.down": "خاموش یا کار نمی‌کند",
  "map.liveTip": "اخیراً روی این شبکه ترافیک را منتقل کرده، روی همین دستگاه یا برای بیشتر کاربران این شبکه.",
  "map.idleTip": "در فهرست هست، ولی هنوز معلوم نیست روی این شبکه کار می‌کند یا نه. عدد تأخیر حساب نمی‌شود.",
  "map.downTip": "نئوکسیفای آن را خاموش اعلام کرده، یا اخیراً برای بیشتر کاربران این شبکه کار نکرده است.",
  "map.hereTip": "کشوری که اتصال تأییدشدهٔ شما از آن استفاده می‌کند.",
  "loc.ispWorksShort": "برای دیگران اینجا کار می‌کند",
  "loc.ispFailingShort": "برای دیگران اینجا کار نمی‌کند",
  "loc.automaticHintShort": "اول آنچه اینجا کار می‌کند",
  "loc.ownWorked": "روی این دستگاه کار کرده",
  "loc.ownWorkedTip": "اخیراً روی همین شبکه از این دستگاه ترافیک منتقل کرده.",
  "sw.notSwitched": "بسته شدن اتصال قبلی تأیید نشد، برای همین کشور عوض نشد.",
  "tr.ipChecked": "از داخل وی‌پی‌ان بررسی شد",
  "tr.speed": "سرعت (بر ثانیه)",
  "tr.down": "دریافت",
  "tr.up": "ارسال",
  "tr.perSec": "{size}",
  "tr.perSecSpoken": "{size} بر ثانیه",
  "dash.autoConnecting": "در حال وصل شدن، چون «اتصال هنگام باز شدن نئوکسیفای» در تنظیمات روشن است.",
  "dash.autoConnectingRung": "«اتصال هنگام باز شدن نئوکسیفای» روشن است · {rung}",
  "lad.trying": "در حال امتحان {route} · {n} از {total}",
  "rc.next": "تلاش {n} از {max} · تلاش بعدی تا {s} ثانیهٔ دیگر",
  "rc.now": "تلاش {n} از {max} · در حال تلاش",
  "rc.attempt": "تلاش {n} از {max}",
  "hold.holding": "طبق تنظیم شما، تا وقتی نئوکسیفای دوباره وصل شود، اتصال‌های دیگر این کامپیوتر مسدود هستند. شبکهٔ محلی شما کار می‌کند و درخواست‌های DNS همچنان بیرون می‌روند.",
  "hold.dnsAnywhere": "نئوکسیفای نتوانست سرورهای DNS این کامپیوتر را بخواند. برای همین تا وقتی اتصال‌های دیگر مسدود هستند، هرچه به پورت ۵۳ فرستاده شود بیرون می‌رود، نه فقط درخواست‌های DNS.",
  "hold.heldAfterDrop": "طبق تنظیم شما، اتصال‌های دیگر این کامپیوتر هنوز مسدود هستند تا نئوکسیفای مسدودسازی را بردارد. برای برگشتن به اینترنت، دوباره وصل شوید.",
  "hold.heldLate": "با WireGuard، مسدودسازی موقع اتصال آماده نمی‌ماند، برای همین کمی بعد از بسته شدن اتصال وی‌پی‌ان شروع شد. ممکن است در همان لحظه ترافیکی بدون نئوکسیفای بیرون رفته باشد.",
  "hold.unconfirmed": "اتصال وی‌پی‌ان بسته شد. نئوکسیفای در حال بررسی این است که اتصال‌های دیگر این کامپیوتر، طبق تنظیم شما، مسدود شده‌اند یا نه.",
  "hold.unanswered": "سرویس نئوکسیفای الان جواب نمی‌دهد، برای همین نئوکسیفای در حال بررسی این است که اتصال‌های دیگر این کامپیوتر، طبق تنظیم شما، مسدود شده‌اند یا نه.",
  "hold.filtersRefused": "نئوکسیفای نتوانست هنگام اتصال دوباره اینترنت را مسدود کند، چون ویندوز فیلترها را نپذیرفت. تا وقتی وی‌پی‌ان برگردد، ترافیک شما بدون نئوکسیفای به اینترنت می‌رود.",
  "hold.tunnelNotPermitted": "مسدودسازی اینترنت برداشته شد تا اتصال جدید بتواند ترافیک را منتقل کند.",
  "hold.timedOut": "بعد از ۴۰ دقیقه تلاش برای اتصال دوباره، نئوکسیفای مسدودسازی اینترنت را برداشت تا این کامپیوتر بی‌اینترنت نماند. تا وقتی وی‌پی‌ان برگردد، ترافیک شما بدون نئوکسیفای به اینترنت می‌رود.",
  "hold.notCovered": "اینترنت مسدود نمی‌شود، چون این مسدودسازی شامل Built-in (IKEv2) و حالت سفارشی نمی‌شود. تا وقتی وی‌پی‌ان برگردد، ترافیک شما بدون نئوکسیفای به اینترنت می‌رود.",
  "hold.other": "هنگام اتصال دوباره، اینترنت مسدود نمی‌شود. تا وقتی وی‌پی‌ان برگردد، ترافیک شما بدون نئوکسیفای به اینترنت می‌رود.",
  "notif.connectedTitle": "نئوکسیفای وصل است",
  "notif.connectedBody": "نئوکسیفای بررسی کرد و ترافیک شما از وی‌پی‌ان می‌گذرد.",
  "notif.connectedPartialBody": "وصل است، ولی همهٔ اتصال‌های این کامپیوتر داخل وی‌پی‌ان نگه داشته نمی‌شوند. برای جزئیات نئوکسیفای را باز کنید.",
  "notif.lostTitle": "اتصال وی‌پی‌ان قطع شد",
  "notif.lostBody": "نئوکسیفای در حال اتصال دوباره است. تا وقتی وصل شود، ترافیک شما محافظت نمی‌شود.",
  "notif.lostHeldBody": "نئوکسیفای در حال اتصال دوباره است. طبق تنظیم شما، تا وقتی وصل شود اتصال‌های دیگر این کامپیوتر مسدود هستند.",
  "notif.lostHeldLateBody": "نئوکسیفای در حال اتصال دوباره است. طبق تنظیم شما، تا وقتی وصل شود اتصال‌های دیگر این کامپیوتر مسدود هستند. ممکن است در لحظهٔ قطع شدن اتصال، کمی ترافیک بیرون رفته باشد.",
  "notif.lostUnconfirmedBody": "نئوکسیفای در حال اتصال دوباره است. هنوز تأیید نشده که اتصال‌های دیگر این کامپیوتر، طبق تنظیم شما، مسدود هستند.",
  "notif.backTitle": "وی‌پی‌ان دوباره وصل شد",
  "notif.backBody": "نئوکسیفای بررسی کرد و ترافیک شما دوباره از وی‌پی‌ان می‌گذرد.",
  "notif.backPartialBody": "دوباره وصل شد، ولی همهٔ اتصال‌های این کامپیوتر داخل وی‌پی‌ان نگه داشته نمی‌شوند. برای جزئیات نئوکسیفای را باز کنید.",
  "notif.backUnconfirmedBody": "اتصال برگشت، ولی نئوکسیفای نتوانست تأیید کند که ترافیک شما از وی‌پی‌ان می‌گذرد. برای جزئیات نئوکسیفای را باز کنید.",
  "notif.droppedTitle": "اتصال وی‌پی‌ان قطع شد",
  "notif.droppedBody": "ترافیک شما محافظت نمی‌شود. برای اتصال دوباره نئوکسیفای را باز کنید.",
  "notif.statusChannel": "وضعیت وی‌پی‌ان",
  "notif.changesChannel": "تغییرات اتصال",
  "notif.starting": "در حال روشن کردن وی‌پی‌ان…",
  "notif.on": "سرویس وی‌پی‌ان در حال اجراست. برای بررسی اتصال نئوکسیفای را باز کنید.",
  "notif.offTitle": "وی‌پی‌ان خاموش شد",
  "notif.offBodyAndroid": "اندروید یا یک برنامهٔ وی‌پی‌ان دیگر، وی‌پی‌ان نئوکسیفای را خاموش کرد. برای اتصال دوباره نئوکسیفای را باز کنید.",
  "notif.offBodyIos": "یک وی‌پی‌ان دیگر یا تغییری در تنظیمات، وی‌پی‌ان نئوکسیفای را خاموش کرد. برای اتصال دوباره نئوکسیفای را باز کنید.",
  "notif.stoppedTitle": "وی‌پی‌ان متوقف شد",
  "notif.stoppedBody": "وی‌پی‌ان نئوکسیفای خودبه‌خود متوقف شد. برای اتصال دوباره نئوکسیفای را باز کنید.",
  "sum.open": "پلن، آی‌پی و جزئیات اتصال",
  "sum.title": "پلن و اتصال",
  "sum.close": "بستن",
  "nav.activity": "فعالیت",
  "auth.showPassword": "نمایش رمز عبور",
  "verify.lead": "یک کد ۶ رقمی به {email} فرستادیم. برای فعال شدن حساب، آن را این پایین وارد کنید.",
  "verify.resent": "فرستاده شد. صندوق ورودی و پوشهٔ اسپم را هم ببینید.",
  "so.title": "از نئوکسیفای خارج می‌شوید؟",
  "so.body": "خروج از حساب، اول وی‌پی‌ان را قطع می‌کند و ترافیک شما دیگر از نئوکسیفای نمی‌گذرد. روی شبکه‌ای که نئوکسیفای را بسته، ممکن است برای ورود دوباره به مسیر پشتیبان نیاز داشته باشید.",
  "so.go": "خروج",
  "dlg.close": "بستن",
  "set.lede": "تنظیمات نئوکسیفای روی این دستگاه.",
  "set.connection": "اتصال",
  "set.leak": "محافظت در برابر نشت",
  "set.leakVal": "چه چیزهایی پوشش داده می‌شود",
  "set.autoStart": "باز شدن نئوکسیفای هنگام ورود به ویندوز",
  "set.autoConnect": "اتصال هنگام باز شدن نئوکسیفای",
  "set.blockRecon": "مسدود کردن اینترنت هنگام اتصال دوباره",
  "set.killHint": "به‌طور پیش‌فرض خاموش است. اگر وی‌پی‌ان قطع شود، اتصال‌های دیگر این کامپیوتر مسدود می‌شوند تا نئوکسیفای دوباره وصل شود یا خودتان اتصال را قطع کنید. با Built-in (IKEv2) و در حالت سفارشی کار نمی‌کند. شبکهٔ محلی شما کار می‌کند و درخواست‌های DNS همچنان بیرون می‌روند.",
  "set.modes": "حالت‌ها",
  "set.gaming": "حالت بازی",
  "set.gamingHint": "فقط سرویس‌های بازی‌هایی که انتخاب می‌کنید از نئوکسیفای می‌گذرند.",
  "set.beta": "آزمایشی",
  "set.custom": "حالت سفارشی",
  "set.perApp": "انتخاب برنامه‌ها",
  "set.customHint": "انتخاب کنید کدام برنامه‌ها از نئوکسیفای بگذرند.",
  "set.perAppIos": "آیفون به برنامه‌های وی‌پی‌ان اجازه نمی‌دهد انتخاب کنند کدام برنامه‌ها از وی‌پی‌ان استفاده کنند، برای همین این گزینه اینجا نیست.",
  "set.appearance": "ظاهر",
  "set.languageHint": "فوراً اعمال می‌شود.",
  "set.system": "سیستم",
  "set.light": "روشن",
  "set.dark": "تیره",
  "set.effects": "جلوه‌های تصویری",
  "set.effectsHint": "شیشه و محوشدگی. حالت سبک یا خاموش برای دستگاه‌های قدیمی بهتر است.",
  "set.full": "کامل",
  "set.lite": "سبک",
  "set.off": "خاموش",
  "set.on": "روشن",
  "set.osSet": "{v} · طبق تنظیم {os}",
  "set.osWin": "ویندوز",
  "set.osAndroid": "اندروید",
  "set.osIos": "iOS",
  "set.motion": "کاهش حرکت",
  "set.motionHint": "به‌جای حرکت، محو شدن کوتاه. از تنظیم سیستم هم پیروی می‌کند.",
  "set.notifs": "اعلان‌ها",
  "set.notifications": "خبر دادن هنگام تغییر اتصال",
  "set.password": "رمز عبور",
  "set.change": "تغییر",
  "set.recovery": "کد بازیابی",
  "set.create": "ساختن",
  "set.signOutHint": "اول اتصال قطع می‌شود",
  "set.troubleshoot": "عیب‌یابی",
  "set.repair": "رفع مشکل شبکه",
  "set.repairHint": "تنظیماتی از شبکهٔ این کامپیوتر را که ممکن است جلوی اتصال نئوکسیفای را بگیرند به حالت اول برمی‌گرداند. اول اتصال قطع می‌شود.",
  "set.supportHint": "پیام‌ها و اطلاعاتی که به ما کمک می‌کند مشکل را پیدا کنیم.",
  "set.about": "درباره",
  "set.version": "نسخه",
  "set.community": "شبکه‌های اجتماعی",
  "set.website": "وب‌سایت",
  "set.history": "نگه‌داشتن سابقهٔ اتصال‌ها روی این دستگاه",
  "set.historyHint": "به‌طور پیش‌فرض خاموش است. زمان شروع و پایان هر اتصال، کشوری که استفاده شد و حجمی که منتقل شد را ثبت می‌کند. این سابقه ۷ روز روی همین دستگاه می‌ماند و جایی فرستاده نمی‌شود. نتیجهٔ اتصال‌ها همچنان، همان‌طور که بالا گفته شد، گزارش می‌شود. سابقه‌های قدیمی‌تر وقتی نئوکسیفای باز است یا دفعهٔ بعد که باز شود پاک می‌شوند. هر کسی که بتواند این دستگاه را باز کند می‌تواند آن را بخواند. خاموش کردن این گزینه، خروج از حساب یا حذف نئوکسیفای آن را پاک می‌کند.",
  "set.autoStartHint": "وقتی وارد ویندوز می‌شوید، نئوکسیفای در یک پنجره باز می‌شود. فقط اگر «اتصال هنگام باز شدن نئوکسیفای» هم روشن باشد، وصل هم می‌شود.",
  "set.autoStartFailed": "ویندوز این تغییر را نپذیرفت. دوباره امتحان کنید یا بخش Startup apps را در Task Manager ببینید.",
  "set.autoConnectHint": "وقتی نئوکسیفای باز می‌شود و وصل نیست، به کشوری که در صفحهٔ اصلی است وصل می‌شود، درست مثل زدن دکمهٔ «اتصال». در حالت بازی این کار را نمی‌کند و هیچ‌وقت جای دستگاه دیگری را در پلن شما نمی‌گیرد.",
  "set.notificationsHint": "فقط برای تغییرهایی که ادامه دارند، یعنی قطع شدن یا برگشتن اتصال، نه برای قطعی چندثانیه‌ای. فقط وقتی پنجرهٔ نئوکسیفای جلوی بقیه نیست.",
  "set.notifsOffApp": "ویندوز طوری تنظیم شده که اعلان‌های نئوکسیفای را نشان ندهد. آن‌ها را در Windows Settings › System › Notifications روشن کنید.",
  "set.notifsOffAll": "اعلان‌ها برای همهٔ برنامه‌ها در Windows Settings › System › Notifications خاموش است.",
  "set.notifsOffPolicy": "مدیر این کامپیوتر اعلان‌ها را خاموش کرده است.",
  "set.notificationsHintAndroid": "وقتی نئوکسیفای باز نیست و اندروید یا یک برنامهٔ وی‌پی‌ان دیگر وی‌پی‌ان نئوکسیفای را خاموش کند، به شما خبر می‌دهد.",
  "set.notificationsHintIos": "وقتی نئوکسیفای باز نیست و وی‌پی‌ان آن متوقف شود، یا یک وی‌پی‌ان دیگر یا تنظیمات آن را خاموش کند، به شما خبر می‌دهد.",
  "set.notifsCanAsk": "نئوکسیفای هنوز از {os} اجازهٔ نمایش اعلان نگرفته، برای همین اعلان‌ها نمایش داده نمی‌شوند.",
  "set.notifsAllow": "اجازه دادن به اعلان‌ها",
  "set.notifsOffPhone": "{os} طوری تنظیم شده که اعلان‌های نئوکسیفای را نشان ندهد، برای همین نمایش داده نمی‌شوند.",
  "set.notifsOpen": "باز کردن تنظیمات {os}",
  "leak.reconHeld": "طبق تنظیم شما، اتصال‌های دیگر این کامپیوتر تا برگشتن وی‌پی‌ان مسدود می‌شوند (به‌جز با Built-in و در حالت سفارشی). شبکهٔ محلی شما کار می‌کند و درخواست‌های DNS همچنان بیرون می‌روند.",
  "leak.lede": "آنچه نئوکسیفای داخل وی‌پی‌ان نگه می‌دارد. این بخش فقط توضیح است و تنظیمی ندارد.",
  "leak.heldLead": "تا وقتی وصل هستید،",
  "leak.held": "با هر پروتکلی به‌جز Built-in، اتصال‌های دیگر این کامپیوتر داخل وی‌پی‌ان نگه داشته می‌شوند و IPv6 مسدود است. اگر این کار انجام نشود، صفحهٔ اصلی خبر می‌دهد.",
  "leak.notHeldLead": "Built-in (IKEv2) و حالت سفارشی",
  "leak.notHeld": "اتصال‌های دیگر را داخل وی‌پی‌ان نگه نمی‌دارند. تا وقتی از آن‌ها استفاده می‌کنید، صفحهٔ اصلی این را می‌گوید.",
  "leak.reconLead": "هنگام اتصال دوباره،",
  "leak.recon": "تا برگشتن وی‌پی‌ان، ترافیک بدون نئوکسیفای به اینترنت می‌رود.",
  "plans.finishInBrowser": "پرداخت را در مرورگر تمام کنید. بعد از تأیید پرداخت، این صفحه خودش به‌روز می‌شود.",
  "plans.reopen": "باز کردن دوبارهٔ صفحهٔ پرداخت",
  "plans.sendExactly": "دقیقاً همین مبلغ را بفرستید. وقتی شبکه پرداخت را تأیید کند، پلن شما خودش فعال می‌شود.",
  "plans.checking": "در انتظار تأیید پرداخت...",
  "plans.current": "پلن فعلی",
  "plans.expires": "انقضا",
  "plans.choose": "همهٔ پلن‌ها",
  "plans.cur": "فعلی",
  "plans.storeLede": "قیمت‌ها را اپ‌استور تعیین می‌کند.",
  "iap.unknownProduct": "این پلن الان در اپ‌استور در دسترس نیست.",
  "iap.unverified": "اپ‌استور نتوانست این خرید را تأیید کند.",
  "iap.failed": "خرید کامل نشد. اگر پولی از حسابتان کم شده، برنامه را دوباره باز کنید تا پلن اضافه شود. دو بار از شما پول کم نمی‌شود.",
  "support.conversations": "گفت‌وگوهای شما",
  "referrals.paidMonth": "{count} ماه خرید",
  "referrals.monthToGo": "{count} ماه خرید دیگر مانده",
  "act.title": "فعالیت",
  "act.lede": "«آنچه روی این شبکه کار می‌کند» و سابقهٔ اتصال‌ها از سوابق خود این دستگاه است. دستگاه‌ها و مصرف روزانه از حساب شما می‌آید. نتیجهٔ اتصال‌ها، بدون ترافیک شما، به نئوکسیفای هم گزارش می‌شود تا دیگران روی همین شبکه ببینند چه چیزی کار می‌کند.",
  "act.network": "آنچه روی این شبکه کار می‌کند",
  "act.networkNote": "از تلاش‌های خود این دستگاه روی شبکهٔ فعلی، در یک روز گذشته.",
  "act.noNetwork": "نئوکسیفای الان نمی‌تواند تشخیص دهد این کدام شبکه است، برای همین چیزی نشان داده نمی‌شود.",
  "act.nothingYet": "در یک روز گذشته چیزی روی این شبکه امتحان نشده است.",
  "act.summary": "از {n} موردی که اخیراً اینجا امتحان شد، {ok} مورد در آخرین تلاش ترافیک را منتقل کرد.",
  "act.unlisted": "سروری که دیگر در فهرست نیست",
  "act.tries": "{ok} از {n} موفق",
  "act.worked": "ترافیک منتقل شد",
  "act.failed": "ترافیکی منتقل نشد",
  "act.plan": "پلن شما",
  "act.noPlan": "این دستگاه پلن ثبت‌شده‌ای ندارد.",
  "act.asOf": "آخرین اطلاعات این دستگاه، {when}.",
  "act.devices": "دستگاه‌های پلن شما",
  "act.devicesNote": "دستگاه‌هایی که وارد حساب شما شده‌اند. «الان در حال استفاده» یعنی در یک و نیم دقیقهٔ گذشته با نئوکسیفای وصل بوده است.",
  "act.deviceLimit": "پلن شما هم‌زمان روی {n} دستگاه کار می‌کند.",
  "act.usage": "مصرف روزانه",
  "act.usageNote": "همهٔ دستگاه‌ها با هم، طبق ثبت سرورهای نئوکسیفای. جمع روزها با مصرف کل پلن شما برابر نیست، چون بخشی از ترافیک اینجا به روز خاصی نسبت داده نمی‌شود.",
  "act.history": "سابقهٔ اتصال‌ها",
  "act.retry": "تلاش دوباره",
  "act.devicesNoAnswer": "برای دیدن دستگاه‌هایتان به نئوکسیفای دسترسی پیدا نکردیم.",
  "act.devicesFailed": "نئوکسیفای الان نتوانست دستگاه‌های شما را نشان دهد.",
  "act.thisDevice": "همین دستگاه",
  "act.inUse": "الان در حال استفاده",
  "act.signOutDevice": "خروج {device} از حساب",
  "act.signOutTitle": "{device} از حساب خارج شود؟",
  "act.signOutBody":
    "آن دستگاه از حساب شما خارج می‌شود و برای اتصال باید دوباره وارد شود. اتصالی که الان باز دارد هم قطع می‌شود. اگر نسخهٔ قدیمی نئوکسیفای روی آن باشد، ممکن است آن اتصال تا وقتی خود دستگاه قطعش کند برقرار بماند.",
  "act.signOutGo": "خروج",
  "act.signOutFailed": "آن دستگاه از حساب خارج نشد. دوباره امتحان کنید.",
  "act.signOutUnreached": "به نئوکسیفای دسترسی پیدا نکردیم، برای همین آن دستگاه از حساب خارج نشد. دوباره امتحان کنید.",
  "act.inUseUnknown": "پلن شما ثبت نمی‌کند کدام دستگاه‌ها وصل هستند، برای همین هیچ‌کدام «الان در حال استفاده» نشان داده نمی‌شود.",
  "act.signedInSeen": "ورود: {signedIn} · آخرین بار: {seen}",
  "act.signedIn": "ورود: {signedIn}",
  "act.devWindows": "کامپیوتر ویندوزی",
  "act.devMac": "مک",
  "act.devLinux": "کامپیوتر لینوکسی",
  "act.devAndroid": "گوشی اندروید",
  "act.devIos": "آیفون",
  "act.devUnknown": "دستگاهی دیگر",
  "act.usageNoAnswer": "برای دیدن مصرف روزانه به نئوکسیفای دسترسی پیدا نکردیم.",
  "act.usageFailed": "نئوکسیفای الان نتوانست مصرف روزانهٔ شما را نشان دهد.",
  "act.usagePeriod": "در {n} روز گذشته",
  "act.usageDay": "{date}: {down} دریافت، {up} ارسال",
  "act.today": "امروز تا این لحظه",
  "act.usageAsOf": "ثبت‌شده تا {when}.",
  "act.usageUtc": "روزها به وقت UTC شمرده می‌شوند.",
  "act.logEmpty": "هنوز چیزی ثبت نشده است. اتصال‌ها از این پس ثبت می‌شوند.",
  "act.logClear": "پاک کردن سابقهٔ اتصال‌ها",
  "act.logClearTitle": "سابقهٔ اتصال‌ها پاک شود؟",
  "act.logClearBody": "همهٔ اتصال‌هایی که روی این دستگاه ثبت شده پاک می‌شود. این کار برگشت ندارد.",
  "act.logClearGo": "پاک کردن",
  "act.logRange": "{day}، {from} تا {to}",
  "act.logNow": "الان",
  "act.logNoEnd": "پایان ثبت نشده",
  "act.logLost": "قطع شد",
  "act.logBytes": "{down} دریافت، {up} ارسال",
  // The server list (design-system.md 4.8, phase 3).
  "loc.search": "جست‌وجوی کشور",
  "loc.clear": "پاک کردن جست‌وجو",
  "loc.more": "گزینه‌های فهرست",
  "loc.close": "بستن فهرست",
  "loc.filters": "فیلتر فهرست",
  "loc.fWorkedLong": "فقط آنچه روی شبکهٔ من کار کرده",
  "loc.fRelay": "مسیرهای پشتیبان",
  "loc.fRelayLong": "فقط مسیرهای پشتیبان",
  "loc.recommended": "پیشنهادی",
  "loc.countries": "کشورها",
  "loc.backup": "مسیرهای پشتیبان",
  "loc.backupHint": "از سروری در داخل کشور خودتان وارد می‌شود. برای وقتی که اینترنت بین‌الملل قطع است.",
  "loc.protocols": "{n} پروتکل",
  "loc.protocolsOne": "{n} پروتکل",
  "loc.cant": "قابل اندازه‌گیری نیست",
  "loc.cantTipUdp": "این پروتکل را فقط با پینگ می‌شود اندازه گرفت و پینگ جوابی نگرفت. خیلی از شبکه‌ها پینگ را می‌بندند، پس ممکن است باز هم وصل شود.",
  "loc.cantTipTcp": "آزمایش زمان‌سنجی جوابی نگرفت. این به این معنی نیست که این پروتکل وصل نمی‌شود.",
  "loc.cantWhyUdp": "پینگ جوابی نگرفت. خیلی از شبکه‌ها پینگ را می‌بندند؛ ممکن است باز هم وصل شود.",
  "loc.cantWhyTcp": "آزمایش زمان‌سنجی جوابی نگرفت. ممکن است باز هم وصل شود.",
  "loc.notMeasured": "اندازه‌گیری نشده",
  "loc.measuring": "در حال اندازه‌گیری…",
  "loc.toIran": "تا ورودی",
  "loc.toIranTip": "فقط تا سرور ورودی اندازه گرفته شده، نه کل مسیر تا خروجی.",
  "loc.measuredAt": "تأخیر {when} اندازه گرفته شد.",
  "loc.notMeasuredNote": "تأخیر هنوز اندازه گرفته نشده است.",
  "loc.measureAgain": "اندازه‌گیری دوباره",
  "loc.measureOff": "برای اندازه‌گیری تأخیر، اتصال را قطع کنید.",
  "loc.empty": "کشوری با «{q}» پیدا نشد",
  "loc.emptyHint": "نام یک کشور یا پروتکل را امتحان کنید.",
  "loc.emptyWorked": "هنوز گزارشی از شبکهٔ شما نرسیده است.",
  "loc.emptyRelay": "پلن شما مسیر پشتیبان ندارد.",
  "loc.showAll": "نمایش همه",
  "loc.explain": "تفاوت پروتکل‌ها",
  "loc.explainLede": "حالت خودکار پروتکل‌ها را به ترتیبی امتحان می‌کند که روی شبکهٔ شما بیشتر احتمال دارد کار کنند. فقط اگر لازم است یکی را خودتان انتخاب کنید.",
  "loc.pageLede": "یک کشور و بعد یک پروتکل انتخاب کنید. معمولاً حالت خودکار بهترین انتخاب است.",
  "loc.openFull": "باز کردن فهرست کامل",
  "loc.worked": "روی شبکهٔ من کار کرده",
  "loc.ispNote": "کشوری «کار کرده» نشان داده می‌شود که اتصال این دستگاه به آن اخیراً روی همین شبکه تأیید شده باشد، یا برای بیشتر کاربران نئوکسیفای که همین سرویس‌دهندهٔ اینترنت را دارند کار کرده باشد.",
  "loc.evOwnTip": "{p} {when} روی همین شبکه از این دستگاه ترافیک منتقل کرد.",
  "loc.evIspFail": "برای دیگران کار نکرده",
  "loc.evOffline": "خاموش",
  "loc.evOfflineTip": "نئوکسیفای این کشور را الان خاموش اعلام کرده است.",
  "loc.protoOfflineTip": "نئوکسیفای این سرور را الان خاموش اعلام کرده است.",
  "proto.hint.reality": "سخت‌تر از همه مسدود می‌شود. بهترین انتخاب برای شبکه‌های محدود.",
  "proto.hint.tls": "شبیه یک وب‌سایت معمولی HTTPS است.",
  "proto.hint.ws": "شبیه ترافیک معمولی وب است. وقتی بقیه مسدود است بهترین گزینه است.",
  "proto.hint.vmess": "روش مخفی قدیمی‌تر که برای سازگاری نگه داشته شده.",
  "proto.hint.trojan": "این هم شبیه یک وب‌سایت است. روشی قدیمی‌تر از Stealth HTTPS.",
  "proto.hint.ss": "دست‌دهی قابل تشخیصی ندارد. وقتی پورت‌های Stealth بسته است مناسب است.",
  "proto.hint.wg": "سریع‌ترین. وقتی چیزی مسدود نیست بهترین است.",
  "proto.hint.ovpn": "کندتر است، ولی تقریباً همه‌جا کار می‌کند.",
  "proto.hint.ikev2": "از وی‌پی‌ان خود دستگاه استفاده می‌کند. سریع است، ولی راحت مسدود می‌شود.",
};

/** Exported for the honesty tests in `i18n.test.ts`, which assert things
 * the type system cannot: that a Persian string is actually Persian, that
 * placeholders survived translation, and that no string in either language
 * makes a speed claim this product has measured to be false. */
export const DICTIONARIES: Record<Language, Record<TranslationKey, string>> = { en, fa };

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
 * request that took longer than `COUNTRY_BUDGET_MS` all mean "unknown",
 * which means English.
 */
export async function detectCountry(budgetMs = COUNTRY_BUDGET_MS): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), budgetMs);
  });
  const asked = publicRequest<{ ip: string; country?: string }>("/health/ip").then(
    (result) => (result.ok ? result.data.country : undefined),
    () => undefined,
  );
  try {
    return await Promise.race([asked, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** How long the country is waited for before English stands: eight
 * seconds, where every request used to give up.
 *
 * Reads now wait up to twenty seconds an address, and this one with them:
 * on a network where only the CDN answers, after fifteen seconds, the
 * answer used to arrive while the customer was typing on the sign-in
 * screen and turn the whole app Persian and right-to-left under their
 * hands. A default is worth having only before anything has been read. */
export const COUNTRY_BUDGET_MS = 8_000;

/** Whether the customer has chosen a language in this run. Set by
 * `setLanguage`; read by `detectedLanguage`, which must not overrule a
 * choice made while it waited. */
let chosenThisRun = false;

/** Records that the customer chose a language just now. */
export function noteLanguageChosen(): void {
  chosenThisRun = true;
}

/** The language the network suggests for a customer who has never chosen
 * one: Persian in Iran, otherwise nothing to change. Nothing, too, when
 * the customer has chosen one in this run while the question was out --
 * the answer can arrive seconds after the switch, and putting the app back
 * into Persian then reads as the app ignoring them. */
export async function detectedLanguage(): Promise<Language | undefined> {
  const country = await detectCountry();
  if (chosenThisRun) return undefined;
  return country === "IR" ? "fa" : undefined;
}

/** For tests: a fresh run, in which nothing has been chosen. */
export function resetLanguageChoiceForTests(): void {
  chosenThisRun = false;
}

/** The language the interface is showing, readable from outside React.
 *
 * Exists so the non-component code that talks to the server can say
 * which language this customer is reading -- `register()` in ./auth.ts
 * has to send it, and it is not a component and has no hook to call.
 * The alternative is threading the language down through every screen
 * that might eventually need it, which makes remembering to pass it the
 * screen's job and guarantees one that forgets.
 *
 * Kept in step by the provider below rather than being a second source
 * of truth: React state stays the one that renders. */
let current: Language = detectLanguage();

export function currentLanguage(): Language {
  return current;
}

/** Tells the server which language to write this customer's email in.
 *
 * Best-effort and deliberately silent. The language has already changed
 * on screen by the time this runs, and a customer who switched to
 * Persian on a blocked network must not be shown an error about it --
 * the worst case is that the next email is in the old language, which is
 * exactly what used to happen to everyone.
 *
 * Skipped without a session: registration carries the locale in its own
 * body, and before that there is no account to set it on. */
async function pushLocale(next: Language): Promise<void> {
  try {
    if (!(await getTokens())) return;
    await apiRequest("/customer/locale", {
      method: "PATCH",
      body: JSON.stringify({ locale: next }),
    });
  } catch {
    // See above: nothing on screen depends on this having worked.
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

      const detected = await detectedLanguage();
      if (detected) setLanguageState(detected);
    })();
  }, []);

  // Catches every route that changes the language without going through
  // setLanguage(): the saved choice being restored from disk, and the
  // country probe deciding on Persian. setLanguage writes the mirror
  // itself as well, synchronously, because a screen can call register()
  // in the same tick as the switch and this effect has not run yet.
  useEffect(() => {
    current = language;
  }, [language]);

  const dir = LANGUAGES[language].dir;

  // Set on the document rather than a wrapper element so it reaches
  // portalled content -- dialogs and dropdowns render outside the React
  // tree and would otherwise stay left-to-right.
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = dir;
  }, [language, dir]);

  const setLanguage = useCallback((next: Language) => {
    noteLanguageChosen();
    setLanguageState(next);
    current = next;
    void (async () => {
      try {
        await (await getStore()).set(STORE_KEY, next);
      } catch {
        // Persisting is best-effort: the change already applied, and
        // failing to remember it is better than refusing to switch.
      }
    })();
    // Only on an explicit switch, not on the detection paths above. The
    // detected language is a guess this app makes on every launch; the
    // switch is the customer saying which one is right, and that is the
    // one worth telling the server about.
    void pushLocale(next);
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
