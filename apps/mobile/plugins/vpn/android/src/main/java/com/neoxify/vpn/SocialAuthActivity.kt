package com.neoxify.vpn

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle

/**
 * Android's half of "sign in somewhere else and come back".
 *
 * iOS has ASWebAuthenticationSession, which hands the callback straight
 * back to the caller. Android has nothing equivalent, so this rebuilds
 * it out of the two pieces the platform does give:
 *
 *  1. A Custom Tab, which is a real Chrome tab rendered over the app. It
 *     carries the customer's existing provider cookies -- somebody
 *     already signed in to Google taps once instead of typing a
 *     password -- and it is not something this app can read. An embedded
 *     WebView would be both, which is exactly why Google refuses to
 *     serve its sign-in page in one.
 *  2. An intent filter on the callback scheme, so the redirect at the
 *     end of the flow comes back to this activity rather than opening a
 *     browser on a URL nothing handles.
 *
 * `singleTask` is what joins them. The tab is opened by this activity;
 * the redirect re-enters this same instance through onNewIntent instead
 * of stacking a second copy, so the result can be handed back to the
 * caller that is still waiting on it.
 */
class SocialAuthActivity : Activity() {
    companion object {
        const val EXTRA_URL = "com.neoxify.vpn.AUTH_URL"
        const val EXTRA_CALLBACK = "com.neoxify.vpn.AUTH_CALLBACK"
    }

    /**
     * Whether the tab has been opened yet.
     *
     * Survives the configuration changes this activity does not handle,
     * via onSaveInstanceState below. Without it, a rotation while the
     * tab is open recreates the activity, which reopens the tab, and the
     * customer watches their half-finished sign-in restart.
     */
    private var launched = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        launched = savedInstanceState?.getBoolean("launched") ?: false
        if (launched) return

        val url = intent.getStringExtra(EXTRA_URL)
        if (url == null) {
            setResult(RESULT_CANCELED)
            finish()
            return
        }

        launched = true
        try {
            // Built by hand rather than with androidx.browser's
            // CustomTabsIntent. The extra below is the whole of that
            // library's contract for "open this as a Custom Tab": a
            // browser that understands it renders a tab, and one that
            // does not ignores it and opens a normal browser window,
            // which still completes the flow. Adding a dependency to
            // set one boolean would be the only thing it bought.
            val tab = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                .putExtra("android.support.customtabs.extra.SESSION", null as Bundle?)
                .addFlags(Intent.FLAG_ACTIVITY_NO_HISTORY)
            startActivity(tab)
        } catch (e: ActivityNotFoundException) {
            // No browser at all. Rare, but a device with every browser
            // disabled is a real thing, and crashing is not the answer.
            setResult(RESULT_CANCELED)
            finish()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean("launched", launched)
    }

    /** The redirect at the end of the flow, routed here by the intent
     * filter and delivered to this instance because of singleTask. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val callback = intent.data?.toString()
        if (callback == null) {
            setResult(RESULT_CANCELED)
        } else {
            setResult(RESULT_OK, Intent().putExtra(EXTRA_CALLBACK, callback))
        }
        finish()
    }

    /**
     * Back from the tab without a redirect.
     *
     * The customer pressed Back or swiped the tab away. There is no
     * event for that -- the only evidence is this activity becoming
     * visible again with nothing having arrived -- so being resumed
     * after the tab was opened is what a cancellation looks like.
     *
     * Safe against the success path because that one calls finish() in
     * onNewIntent, which runs before onResume; isFinishing is then
     * already true and this does not overwrite the result.
     */
    override fun onResume() {
        super.onResume()
        if (launched && !isFinishing) {
            setResult(RESULT_CANCELED)
            finish()
        }
    }
}
