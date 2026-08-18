package com.neoxify.vpn

import android.app.Activity
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.net.VpnService
import android.os.Build
import android.util.Base64
import android.util.Log
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.wireguard.android.backend.Backend
import com.wireguard.android.backend.GoBackend
import com.wireguard.android.backend.Tunnel
import com.wireguard.config.Config
import java.io.BufferedReader
import java.io.ByteArrayOutputStream
import java.io.StringReader
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * The tunnel.
 *
 * Android allows exactly one active VpnService per app and hands it a
 * single TUN file descriptor, so none of the Windows client's machinery
 * appears here -- no per-protocol adapter, no routing-table edits, no
 * sockets pinned to an interface. Whichever protocol is active gets that
 * one descriptor.
 *
 * WireGuard itself is `com.wireguard.android:tunnel`, the maintainers'
 * own embeddable library, which wraps the same wireguard-go running on
 * every node. Managing a real engine rather than reimplementing the
 * protocol is the decision this project has made everywhere else, for
 * the same reason: an upstream fix is a version bump, not a rewrite.
 */
@TauriPlugin
class NeoxifyVpnPlugin(private val activity: Activity) : Plugin(activity) {
    private val backend: Backend by lazy { GoBackend(activity.applicationContext) }

    /**
     * Everything that touches the engine runs here, never on the caller's
     * thread.
     *
     * Tauri dispatches plugin commands on the main thread, and Android
     * throws NetworkOnMainThreadException for any network call made there
     * -- including the DNS lookup `Config.parse` performs when a peer's
     * endpoint is a hostname rather than a literal address.
     *
     * That asymmetry shipped and was reported: Finland's endpoint is
     * 204.168.161.100:51820 and connected fine, France's is
     * fr1.neoxify.com:51820 and failed every time, so the ladder walked
     * past France to Finland on every attempt. The node's own capture
     * showed the desktop client handshaking with France perfectly while
     * the tablet never sent it a single packet -- the connection died
     * inside the app, before the network was involved at all.
     *
     * Single-threaded on purpose: connect and disconnect must not
     * interleave, or a teardown can land between another attempt's
     * setState and its status read.
     */
    private val engine: ExecutorService = Executors.newSingleThreadExecutor { r ->
        Thread(r, "neoxify-vpn").apply { isDaemon = true }
    }

    /** Runs `work` off the main thread and resolves the call with whatever
     * it returns, or rejects with the engine's own words if it throws. */
    private fun offMainThread(invoke: Invoke, what: String, work: () -> JSObject) {
        engine.execute {
            try {
                invoke.resolve(work())
            } catch (e: Throwable) {
                // Throwable, not Exception. The engines here are native
                // libraries, and a failure to load one arrives as an
                // Error -- UnsatisfiedLinkError, ExceptionInInitializerError,
                // OutOfMemoryError -- none of which is an Exception. Those
                // escaped this handler, unwound the executor thread, and
                // killed the process: the customer saw the app vanish with
                // no message, and nothing reached the telemetry either.
                // Observed for real as
                // `UnsatisfiedLinkError: dlopen failed: library "libgojni.so" not found`.
                //
                // Passed through rather than flattened into "could not
                // connect": the difference between a refused permission,
                // an unreachable endpoint and a bad key is three
                // different fixes, and the app shows this text under
                // "show details" precisely so it survives to be read.
                Log.e(TAG, "$what failed", e)
                // The operation is named even when the exception cannot
                // usefully name itself. A message-less exception used to
                // arrive as its bare class name, which after
                // minification meant the telemetry recorded results like
                // "v1.b" -- true, and worth nothing to whoever is
                // reading it. Exception names now survive R8 as well
                // (see consumer-rules.pro), so this is the second line
                // of defence rather than the only one.
                invoke.reject(e.message ?: "$what failed: $e")
            }
        }
    }

    /** The one tunnel this app ever creates.
     *
     * The name is what Android shows in its own VPN settings and in the
     * always-on VPN list, so it is the product's name rather than
     * something like "wg0". */
    private val tunnel = object : Tunnel {
        override fun getName() = "Neoxify"
        override fun onStateChange(newState: Tunnel.State) {
            Log.i(TAG, "tunnel state: $newState")
        }
    }

    /** The protocol currently up, for `status` to report.
     *
     * Tracked here because the backend knows only that *a* tunnel is up.
     * When the Xray engines land the UI still has to be able to say
     * which one the customer ended up on -- landing somewhere else
     * silently is the same dishonesty as a false "Connected". */
    private var activeProtocol: String? = null

    @InvokeArg
    class XrayProfile {
        /** The complete xray-core config, built by the app.
         *
         * Assembled in TypeScript rather than here on purpose: the shape
         * of a REALITY or Trojan outbound is protocol knowledge, and it
         * already lives beside the credential types that feed it. Kotlin's
         * job is the tunnel, and it needs to know nothing about VLESS to
         * do it. */
        lateinit var config: String
        lateinit var protocol: String
        lateinit var dns: String
        var mtu: Int = 1500
        var allowedApps: List<String> = emptyList()
    }

    @InvokeArg
    class WireGuardProfile {
        lateinit var privateKey: String
        lateinit var address: String
        lateinit var dns: String
        lateinit var serverPublicKey: String
        lateinit var endpoint: String
        lateinit var allowedIPs: String
        var allowedApps: List<String> = emptyList()
    }

    @InvokeArg
    class Ikev2Profile {
        /** The node's hostname, never its address.
         *
         * Android's platform client has no way to set the remote
         * identity separately, so it validates the server's certificate
         * against whatever was dialled. An IP therefore fails on the
         * certificate rather than on anything real. */
        lateinit var server: String
        lateinit var username: String
        lateinit var password: String
    }

    /**
     * Whether the customer has already consented.
     *
     * `VpnService.prepare` returns null when consent exists and an Intent
     * when it does not -- one call answers both questions, which is why
     * there is no separate query API to use instead.
     */
    @Command
    fun hasPermission(invoke: Invoke) {
        invoke.resolve(JSObject().put("granted", VpnService.prepare(activity) == null))
    }

    /**
     * Raises Android's VPN consent dialog.
     *
     * There is no way to pre-grant this and no way around it: the system
     * requires it before any app may create a VpnService. So the first
     * connect always pauses here, and the UI is written expecting that
     * rather than treating it as a failure.
     */
    @Command
    fun requestPermission(invoke: Invoke) {
        val intent = VpnService.prepare(activity)
        if (intent == null) {
            invoke.resolve(JSObject().put("granted", true))
            return
        }
        startActivityForResult(invoke, intent, "permissionResult")
    }

    @ActivityCallback
    fun permissionResult(invoke: Invoke, result: ActivityResult) {
        invoke.resolve(JSObject().put("granted", result.resultCode == Activity.RESULT_OK))
    }

    @Command
    fun connectWireguard(invoke: Invoke) {
        // Parsed on this thread -- reading the arguments touches no
        // network -- but everything after it must not be.
        val profile = invoke.parseArgs(WireGuardProfile::class.java)
        offMainThread(invoke, "connect") {
            try {
                val config = Config.parse(BufferedReader(StringReader(buildQuickConfig(profile))))
                backend.setState(tunnel, Tunnel.State.UP, config)
                activeProtocol = "WIREGUARD"
                JSObject()
            } catch (e: Exception) {
                activeProtocol = null
                throw e
            }
        }
    }

    /**
     * Brings up one of the Xray protocols.
     *
     * Two steps, in this order and not the other: start the service so it
     * exists, then hand it the config. Android constructs services itself
     * and offers no synchronous way to get the instance back, so this
     * waits for it to register rather than assuming it is immediate.
     */
    @Command
    fun connectXray(invoke: Invoke) {
        val profile = invoke.parseArgs(XrayProfile::class.java)
        offMainThread(invoke, "connectXray") {
            // Whatever is up comes down first, including a WireGuard
            // tunnel: Android allows one VPN per app, and establishing a
            // second silently replaces the first.
            runCatching { backend.setState(tunnel, Tunnel.State.DOWN, null) }

            // Stale state from a previous attempt would be read as this
            // one's result, and the answer would arrive before the work.
            NeoxifyTunService.clearState(activity)

            val intent = Intent(activity, NeoxifyTunService::class.java)
                .putExtra(NeoxifyTunService.EXTRA_CONFIG, profile.config)
                .putExtra(NeoxifyTunService.EXTRA_MTU, profile.mtu)
                .putExtra(NeoxifyTunService.EXTRA_DNS, profile.dns)
                .putStringArrayListExtra(NeoxifyTunService.EXTRA_APPS, ArrayList(profile.allowedApps))
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                activity.startForegroundService(intent)
            } else {
                activity.startService(intent)
            }

            // The service runs in its own process, so there is no object
            // to call and no exception to catch: it reports back through
            // the state file instead. Waiting here keeps this command's
            // contract unchanged for the ladder above, which still needs
            // "did this protocol come up" answered before it moves on.
            when (val outcome = awaitTunnelState()) {
                null -> throw IllegalStateException("The VPN service did not start")
                else -> if (outcome.first == NeoxifyTunService.STATE_ERROR) {
                    throw IllegalStateException(outcome.second ?: "The tunnel could not be started")
                }
            }

            activeProtocol = profile.protocol
            JSObject()
        }
    }

    /** Waits for the Xray process to say how it went.
     *
     * Polling a file rather than binding. The wait is short, a
     * ServiceConnection would add a lifecycle to unwind on every failure
     * path, and this survives the service process being restarted by the
     * system mid-connect -- which a binding does not.
     */
    private fun awaitTunnelState(): Pair<String, String?>? {
        val deadline = System.currentTimeMillis() + TUNNEL_START_TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            NeoxifyTunService.readState(activity)?.let { return it }
            Thread.sleep(100)
        }
        return null
    }

    /**
     * Brings up IKEv2 through Android's own client.
     *
     * Nothing of ours runs: the platform holds the tunnel, so there is
     * no service to start, no descriptor to pass, and no engine to load.
     * What this does have that the others do not is a second consent
     * dialog -- the VpnService grant every protocol needs does not cover
     * a platform VPN profile, which Android asks about separately and
     * only once.
     */
    @Command
    fun connectIkev2(invoke: Invoke) {
        val profile = invoke.parseArgs(Ikev2Profile::class.java)
        Ikev2Engine.unsupportedReason()?.let {
            invoke.reject(it)
            return
        }

        // Whatever is up comes down first. Android allows one VPN at a
        // time across both mechanisms, and a live WireGuard tunnel would
        // otherwise make the platform's own start fail for a reason that
        // has nothing to do with IKEv2.
        engine.execute {
            runCatching { backend.setState(tunnel, Tunnel.State.DOWN, null) }
            // Caught here, unlike in disconnect(): this runs directly on
            // the executor rather than inside offMainThread's handler,
            // so an escaping throw would take the process down and leave
            // the call unanswered. And a previous tunnel that refused to
            // come down is a reason not to start this one -- Android
            // allows a single VPN, so the establish below would fail
            // anyway, for a reason that reads as an IKEv2 fault.
            try {
                stopTunService()
            } catch (e: Throwable) {
                Log.e(TAG, "the previous tunnel would not come down", e)
                invoke.reject(e.message ?: e.toString())
                return@execute
            }

            val consent = try {
                Ikev2Engine.provision(activity, profile.server, profile.username, profile.password)
            } catch (e: Throwable) {
                Log.e(TAG, "provisioning the platform VPN failed", e)
                invoke.reject(e.message ?: e.toString())
                return@execute
            }

            if (consent != null) {
                // Must be raised from the main thread, and the answer
                // arrives in the callback below rather than here.
                activity.runOnUiThread { startActivityForResult(invoke, consent, "ikev2ConsentResult") }
                return@execute
            }
            finishIkev2(invoke)
        }
    }

    @ActivityCallback
    fun ikev2ConsentResult(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK) {
            invoke.reject("Android needs your permission to use its built-in VPN.")
            return
        }
        engine.execute { finishIkev2(invoke) }
    }

    /** Dials and waits, then answers the original call. Shared by the
     * already-consented path and the just-consented one. */
    private fun finishIkev2(invoke: Invoke) {
        try {
            Ikev2Engine.start(activity)
            activeProtocol = "IKEV2"
            invoke.resolve(JSObject())
        } catch (e: Throwable) {
            Log.e(TAG, "connectIkev2 failed", e)
            activeProtocol = null
            invoke.reject(e.message ?: e.toString())
        }
    }


    /** Brings the Xray tunnel down.
     *
     * A stop *message* rather than stopService(): while a tunnel is
     * established the system is bound to that service, and a bound
     * service ignores stopService() entirely -- the descriptor stays
     * open and the device stays offline behind a tunnel nothing is
     * carrying. NeoxifyTunService.onStartCommand documents the deadlock.
     *
     * stopService() still follows it, for the case the message cannot
     * cover: a service running but never bound, because its start failed
     * before establish() ever created a tun.
     */
    private fun stopTunService() {
        val stop = Intent(activity, NeoxifyTunService::class.java)
            .setAction(NeoxifyTunService.ACTION_STOP)
        // A disconnect is user-initiated from a visible app, so plain
        // startService is allowed and carries no notification
        // obligation. The foreground variant is the fallback for the
        // background case -- a revoke, or a stop issued from a
        // notification action.
        runCatching { activity.startService(stop) }.recoverCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                activity.startForegroundService(stop)
            } else {
                throw it
            }
        }
        activity.stopService(Intent(activity, NeoxifyTunService::class.java))
    }

    /** Whether the device is still routed through a VPN.
     *
     * Exposed so the dashboard can confirm a disconnect before saying
     * it happened, without any engine call blocking while it waits.
     * Asked of ConnectivityManager rather than of our own service: the
     * system holds its binding for seconds after the tun is closed, so
     * service liveness reported a failure for teardowns that had
     * already worked. What the customer feels is whether their packets
     * still go into a tunnel, and that is this.
     */
    @Command
    fun tunnelGone(invoke: Invoke) = offMainThread(invoke, "tunnelGone") {
        JSObject().put("gone", !vpnTransportUp())
    }

    private fun vpnTransportUp(): Boolean = try {
        val cm = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        @Suppress("DEPRECATION")
        cm.allNetworks.any {
            cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
        }
    } catch (e: Exception) {
        Log.w(TAG, "could not read network state", e)
        // Unknown, not "gone": claiming a teardown we cannot see is the
        // failure this exists to prevent.
        true
    }

    @Command
    fun disconnect(invoke: Invoke) {
        offMainThread(invoke, "disconnect") {
            // Both engines, unconditionally. Asking which one is running
            // means trusting a variable that a service restart can
            // outlive; tearing down an engine that is already down costs
            // nothing.
            runCatching { backend.setState(tunnel, Tunnel.State.DOWN, null) }
            stopTunService()
            Ikev2Engine.stop(activity)
            activeProtocol = null
            // Deliberately does not wait for the tunnel to be gone.
            // The connect ladder calls this between rungs, and a wait
            // here ran once per protocol it tried -- turning a failed
            // connect into minutes of spinner. Confirming the teardown
            // is the caller's job, and only when a customer asked to
            // disconnect: see tunnelGone below, which the dashboard
            // polls before it claims anything.
            JSObject()
        }
    }

    /**
     * What is actually true about the tunnel right now.
     *
     * The handshake age is the part worth having. "A tunnel exists" is a
     * purely local fact and proves nothing -- WireGuard is UDP, and an
     * interface looks perfectly healthy against a server that is not
     * there. A handshake means the far end answered and the keys matched,
     * which is the only cheap evidence requiring the server to take part.
     */
    @Command
    fun status(invoke: Invoke) = offMainThread(invoke, "status") { readStatus() }

    private fun readStatus(): JSObject {
        // Two engines, either of which may be the live one.
        // Read from the file the Xray process publishes, never by calling
        // into the engine. Calling Neoxifyxray here would load a second
        // Go runtime into this process alongside WireGuard's, which is
        // the whole thing running that service separately exists to
        // prevent -- and status runs on every dashboard load, so it
        // would happen to customers who never touch a stealth protocol.
        val xrayUp = NeoxifyTunService.readState(activity)?.first == NeoxifyTunService.STATE_UP
        val wireguardUp = try {
            backend.getState(tunnel) == Tunnel.State.UP
        } catch (e: Exception) {
            Log.w(TAG, "state unavailable", e)
            false
        }
        // The platform tunnel is the one that can be up without this
        // process having started it -- it outlives us, because it was
        // never ours. Asking Android rather than trusting a field is the
        // only way a relaunch reports it correctly.
        val ikev2Up = try {
            Ikev2Engine.isUp(activity)
        } catch (e: Exception) {
            Log.w(TAG, "platform VPN state unavailable", e)
            false
        }
        val up = xrayUp || wireguardUp || ikev2Up
        // Recovered rather than left null after a relaunch: the field is
        // process state and the tunnel is not.
        if (ikev2Up && activeProtocol == null) activeProtocol = "IKEV2"

        var rx = 0L
        var tx = 0L
        var handshakeAge: Long? = null

        // Only WireGuard has cheap evidence to report. Xray has no
        // handshake to read, so its age stays null and the app falls back
        // to proving the tunnel with real traffic -- the stronger test,
        // and the only one that works for every protocol.
        if (wireguardUp) {
            try {
                val stats = backend.getStatistics(tunnel)
                rx = stats.totalRx()
                tx = stats.totalTx()
                // The newest handshake across peers. There is only one
                // peer today, but taking the max means adding a second
                // does not quietly start reporting the wrong one.
                handshakeAge = stats.peers()
                    .mapNotNull { stats.peer(it)?.latestHandshakeEpochMillis }
                    .filter { it > 0 }
                    .maxOrNull()
                    ?.let { (System.currentTimeMillis() - it) / 1000 }
            } catch (e: Exception) {
                // Best-effort. Failing to read counters says nothing
                // about whether the tunnel is up, so the state above
                // stands and the numbers stay at zero.
                Log.w(TAG, "statistics unavailable", e)
            }
        }

        val result = JSObject()
        result.put("connected", up)
        result.put("protocol", if (up) activeProtocol else null)
        result.put("rxBytes", rx)
        result.put("txBytes", tx)
        // Null, never zero. Zero would read as "handshook just now",
        // which is the opposite of what no evidence means.
        result.put("lastHandshakeAgeSecs", handshakeAge)
        return result
    }

    /**
     * The apps the customer can choose to route.
     *
     * Only ones holding INTERNET: an app that cannot open a socket is a
     * row to scroll past rather than a choice to make. This app is
     * excluded too -- routing the client's own control-plane traffic into
     * the tunnel it is managing is a loop, and it would make the egress
     * check measure the wrong path.
     */
    @Command
    fun listApps(invoke: Invoke) = offMainThread(invoke, "listApps") { readApps() }

    private fun readApps(): JSObject {
        val pm = activity.packageManager
        val apps = JSArray()

        for (info in pm.getInstalledApplications(0)) {
            if (info.packageName == activity.packageName) continue
            if (pm.checkPermission(android.Manifest.permission.INTERNET, info.packageName)
                != PackageManager.PERMISSION_GRANTED
            ) continue
            // A system component with no launcher entry is not something
            // a customer recognises or means to route.
            if (info.flags and ApplicationInfo.FLAG_SYSTEM != 0 &&
                pm.getLaunchIntentForPackage(info.packageName) == null
            ) continue

            val entry = JSObject()
            entry.put("packageName", info.packageName)
            entry.put("label", pm.getApplicationLabel(info).toString())
            entry.put("icon", encodeIcon(pm.getApplicationIcon(info)))
            apps.put(entry)
        }

        return JSObject().put("apps", apps)
    }

    /**
     * The credentials as wg-quick text.
     *
     * Handed to the library's own parser rather than assembled through
     * the builder API: the parser is what the WireGuard project tests and
     * documents, it takes the same format the backend already generates
     * for the desktop client, and `IncludedApplications` -- the library's
     * own extension to that format -- is how per-app routing is
     * expressed. One code path instead of two.
     */
    private fun buildQuickConfig(p: WireGuardProfile): String = buildString {
        append("[Interface]\n")
        append("PrivateKey = ").append(p.privateKey).append('\n')
        append("Address = ").append(p.address).append('\n')
        append("DNS = ").append(p.dns).append('\n')
        if (p.allowedApps.isNotEmpty()) {
            // An empty list would mean "route nothing", which looks
            // exactly like a broken tunnel -- so the caller sends an
            // empty list to mean "everything" and the key is omitted.
            append("IncludedApplications = ").append(p.allowedApps.joinToString(", ")).append('\n')
        }
        append("\n[Peer]\n")
        append("PublicKey = ").append(p.serverPublicKey).append('\n')
        append("AllowedIPs = ").append(p.allowedIPs).append('\n')
        append("Endpoint = ").append(p.endpoint).append('\n')
        // Mobile networks put a NAT in front of everything and drop idle
        // UDP mappings within a minute or two. Without a keepalive the
        // tunnel works until the screen goes off and then silently stops
        // receiving -- the failure a customer reports as "it says
        // connected but nothing loads".
        append("PersistentKeepalive = 25\n")
    }

    /**
     * A launcher icon as a data URI, or null if it cannot be rendered.
     *
     * Downscaled to 96px: this runs once per installed app, and full-size
     * adaptive icons would be hundreds of KB each crossing the bridge as
     * base64 for something drawn at 32dp.
     */
    private fun encodeIcon(drawable: Drawable): String? = try {
        val size = 96
        val bitmap = if (drawable is BitmapDrawable && drawable.bitmap != null) {
            Bitmap.createScaledBitmap(drawable.bitmap, size, size, true)
        } else {
            Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888).also { bmp ->
                drawable.setBounds(0, 0, size, size)
                drawable.draw(Canvas(bmp))
            }
        }
        val stream = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)
        "data:image/png;base64," + Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP)
    } catch (e: Exception) {
        // A missing icon costs a placeholder, not the list.
        Log.w(TAG, "icon unavailable", e)
        null
    }

    companion object {
        /** How long a disconnect waits for the device to stop being
         * routed through a VPN before giving up and saying so.
         *
         * Measured, not guessed: on the emulator the tun goes within a
         * couple of seconds, but the system's own teardown trails it.
         * Ten seconds is well past what a healthy stop takes and still
         * short enough that a customer whose tunnel is genuinely stuck
         * is told so rather than left watching a spinner. */
        private const val TEARDOWN_WAIT_MS = 10_000L
        private const val TEARDOWN_POLL_MS = 100L

        private const val TAG = "NeoxifyVpn"
        /** Covers the Xray process starting, the tunnel being
         * established and xray-core loading a 46MB engine, so it is
         * longer than the old service-start-only wait it replaces. Still
         * inside the ladder's per-attempt budget, so a protocol that
         * hangs does not stall the whole failover sweep. */
        private const val TUNNEL_START_TIMEOUT_MS = 20_000L
    }
}
