package com.neoxify.vpn

import android.app.Activity
import android.content.Intent
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
import neoxifyxray.Neoxifyxray
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
            } catch (e: Exception) {
                // Passed through rather than flattened into "could not
                // connect": the difference between a refused permission,
                // an unreachable endpoint and a bad key is three
                // different fixes, and the app shows this text under
                // "show details" precisely so it survives to be read.
                Log.e(TAG, "$what failed", e)
                invoke.reject(e.message ?: e.toString())
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

            val intent = Intent(activity, NeoxifyTunService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                activity.startForegroundService(intent)
            } else {
                activity.startService(intent)
            }

            val service = awaitService()
                ?: throw IllegalStateException("The VPN service did not start")

            service.start(profile.config, profile.mtu, profile.dns, profile.allowedApps)
            activeProtocol = profile.protocol
            JSObject()
        }
    }

    /** Waits briefly for the service to come up. Polling rather than
     * binding because the wait is short and a ServiceConnection would add
     * a lifecycle to unwind on every failure path. */
    private fun awaitService(): NeoxifyTunService? {
        val deadline = System.currentTimeMillis() + SERVICE_START_TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            NeoxifyTunService.instance?.let { return it }
            Thread.sleep(50)
        }
        return NeoxifyTunService.instance
    }

    @Command
    fun disconnect(invoke: Invoke) {
        offMainThread(invoke, "disconnect") {
            // Both engines, unconditionally. Asking which one is running
            // means trusting a variable that a service restart can
            // outlive; tearing down an engine that is already down costs
            // nothing.
            runCatching { backend.setState(tunnel, Tunnel.State.DOWN, null) }
            activity.stopService(Intent(activity, NeoxifyTunService::class.java))
            activeProtocol = null
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
        val xrayUp = runCatching { Neoxifyxray.running() }.getOrDefault(false)
        val wireguardUp = try {
            backend.getState(tunnel) == Tunnel.State.UP
        } catch (e: Exception) {
            Log.w(TAG, "state unavailable", e)
            false
        }
        val up = xrayUp || wireguardUp

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
        private const val TAG = "NeoxifyVpn"
        private const val SERVICE_START_TIMEOUT_MS = 5_000L
    }
}
