package com.neoxify.vpn

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Ikev2VpnProfile
import android.net.NetworkCapabilities
import android.net.VpnManager
import android.os.Build
import android.util.Log
import androidx.annotation.RequiresApi

/**
 * IKEv2 through Android's own VPN client.
 *
 * The odd engine out, exactly as on Windows: nothing is bundled, no
 * `VpnService` of ours is involved, and no TUN descriptor is ours to
 * hold. Android has spoken IKEv2 natively since 11, so this hands the
 * platform a profile and asks it to dial -- the operating system owns
 * the tunnel from there.
 *
 * That is also why almost none of the rest of this plugin applies. There
 * is no handshake counter to read, no per-app allowlist to install (the
 * platform profile API simply has no equivalent of
 * `IncludedApplications`), and the tunnel outlives our process, because
 * it was never in it.
 */
object Ikev2Engine {
    private const val TAG = "NeoxifyVpn"

    /** Remembers that the live tunnel is ours.
     *
     * Needed because the platform VPN survives this process, so on a
     * fresh launch "a VPN network exists" is equally consistent with a
     * different VPN app being connected. Reporting someone else's tunnel
     * as ours would be a false "Connected" -- the exact dishonesty the
     * rest of this client was written to remove.
     */
    private const val PREFS = "neoxify-ikev2"
    private const val KEY_STARTED = "started"

    /** How long to wait for the platform to bring the tunnel up.
     *
     * IKEv2 establishes in about a second on a working network, so this
     * is almost entirely budget for the failure case: a filtered network
     * drops UDP 500 silently and the platform retries until it gives up.
     * Kept inside the ladder's per-attempt budget so a blocked IKEv2
     * does not stall the whole failover sweep.
     */
    private const val CONNECT_TIMEOUT_MS = 15_000L
    private const val POLL_MS = 250L

    /** The lowest Android that has this API at all. */
    const val MIN_SDK = Build.VERSION_CODES.R

    fun unsupportedReason(): String? =
        if (Build.VERSION.SDK_INT >= MIN_SDK) null
        else "Built-in (IKEv2) needs Android 11 or newer. Pick another protocol."

    /**
     * Installs the profile, returning the consent Intent when Android
     * wants the customer to approve it first.
     *
     * Null means consent already exists and [start] may be called
     * straight away. The profile itself is stored either way -- the
     * Intent gates activation, not provisioning -- which is why [start]
     * takes no profile argument.
     */
    @RequiresApi(MIN_SDK)
    fun provision(context: Context, server: String, username: String, password: String): Intent? {
        // Identity and server address are deliberately the same string.
        // Android's platform client offers no way to set the remote
        // identity separately, so it checks the server's certificate
        // against the address it dialled -- which is why the app must
        // pass the hostname here and never the node's IP.
        val profile = Ikev2VpnProfile.Builder(server, server)
            // Null root CA means the system trust store, which is right:
            // the node presents a Let's Encrypt certificate for its real
            // name. Pinning our own CA would mean shipping one and
            // rotating it in every installed app every ninety days.
            .setAuthUsernamePassword(username, password, null)
            // Not bypassable: an app that asks to skip the VPN should not
            // be able to, or "connected" stops meaning anything.
            .setBypassable(false)
            // Android otherwise assumes a VPN is metered and holds back
            // background sync and updates on it. Our nodes are not.
            .setMetered(false)
            .build()
        return manager(context).provisionVpnProfile(profile)
    }

    /**
     * Dials the provisioned profile and waits for it to actually come up.
     *
     * Waiting matters: every caller above treats a resolved connect as
     * "this protocol works", and `startProvisionedVpnProfile` returns
     * the instant the request is accepted, long before any packet has
     * been exchanged. Returning there would report success for a server
     * that never answered, and the failover ladder would stop walking on
     * the strength of it.
     */
    @RequiresApi(MIN_SDK)
    fun start(context: Context) {
        val vpn = manager(context)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            vpn.startProvisionedVpnProfileSession()
        } else {
            @Suppress("DEPRECATION")
            vpn.startProvisionedVpnProfile()
        }
        markStarted(context, true)

        val deadline = System.currentTimeMillis() + CONNECT_TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            when (liveState(context)) {
                LiveState.UP -> return
                LiveState.FAILED -> {
                    stop(context)
                    throw IllegalStateException(
                        "The server refused the connection. Check your account is active, " +
                            "or try a Stealth protocol."
                    )
                }
                LiveState.PENDING -> Thread.sleep(POLL_MS)
            }
        }

        // Left running would mean a tunnel the customer cannot see and
        // did not get told about, quietly holding the one VPN slot
        // Android allows -- so the next protocol the ladder tries would
        // fail for a reason that has nothing to do with that protocol.
        stop(context)
        throw IllegalStateException(
            "No response from the server. UDP is likely blocked on this network; " +
                "try a Stealth protocol instead."
        )
    }

    /** Tears the tunnel down.
     *
     * The profile itself is deliberately left provisioned. Deleting it
     * would take the customer's consent with it and raise the system
     * dialog again on every single connect; a VPN app appearing in
     * Android's VPN settings is expected, unlike the Windows phonebook
     * entry the desktop client removes.
     */
    fun stop(context: Context) {
        markStarted(context, false)
        if (Build.VERSION.SDK_INT < MIN_SDK) return
        runCatching { manager(context).stopProvisionedVpnProfile() }
            .onFailure { Log.w(TAG, "stopping the platform VPN failed", it) }
    }

    /** Whether *our* platform tunnel is currently carrying the device. */
    fun isUp(context: Context): Boolean =
        Build.VERSION.SDK_INT >= MIN_SDK && startedByUs(context) && liveState(context) == LiveState.UP

    private enum class LiveState { UP, PENDING, FAILED }

    /**
     * What the platform says about the tunnel.
     *
     * Two answers depending on the Android version, and the older one is
     * genuinely weaker. Android 13 added a real profile state, including
     * a distinct "failed"; before that the only evidence available is
     * whether a VPN-transport network exists, which cannot tell a
     * failure from a slow negotiation. So on 11 and 12 a bad password
     * looks exactly like a blocked port until the timeout expires --
     * worth knowing when reading a support report, and better than
     * inventing a distinction the platform did not give us.
     */
    @SuppressLint("NewApi")
    private fun liveState(context: Context): LiveState {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val state = runCatching { manager(context).getProvisionedVpnProfileState() }
                .getOrNull()
                ?: return LiveState.PENDING
            return when (state.state) {
                android.net.VpnProfileState.STATE_CONNECTED -> LiveState.UP
                android.net.VpnProfileState.STATE_FAILED -> LiveState.FAILED
                // STATE_DISCONNECTED included here rather than treated as
                // a failure: it is also what the platform reports in the
                // moment between accepting the request and starting to
                // negotiate, so failing on it would abort every connect
                // before it began.
                else -> LiveState.PENDING
            }
        }
        return if (hasVpnNetwork(context)) LiveState.UP else LiveState.PENDING
    }

    private fun hasVpnNetwork(context: Context): Boolean {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return false
        return cm.allNetworks.any { network ->
            cm.getNetworkCapabilities(network)
                ?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
        }
    }

    @RequiresApi(MIN_SDK)
    private fun manager(context: Context): VpnManager =
        context.getSystemService(VpnManager::class.java)
            ?: throw IllegalStateException("This device has no platform VPN support")

    private fun startedByUs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_STARTED, false)

    private fun markStarted(context: Context, started: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putBoolean(KEY_STARTED, started).apply()
    }
}
