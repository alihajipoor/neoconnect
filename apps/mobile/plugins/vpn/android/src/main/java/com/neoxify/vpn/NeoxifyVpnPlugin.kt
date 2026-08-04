package com.neoxify.vpn

import android.app.Activity
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.net.VpnService
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
        val profile = invoke.parseArgs(WireGuardProfile::class.java)
        try {
            val config = Config.parse(BufferedReader(StringReader(buildQuickConfig(profile))))
            backend.setState(tunnel, Tunnel.State.UP, config)
            activeProtocol = "WIREGUARD"
            invoke.resolve(JSObject())
        } catch (e: Exception) {
            activeProtocol = null
            // The engine's own words, passed through. A generic "could
            // not connect" throws away the difference between a refused
            // permission, an unreachable endpoint and a malformed key --
            // three completely different fixes.
            Log.e(TAG, "connect failed", e)
            invoke.reject(e.message ?: e.toString())
        }
    }

    @Command
    fun disconnect(invoke: Invoke) {
        try {
            backend.setState(tunnel, Tunnel.State.DOWN, null)
            activeProtocol = null
            invoke.resolve(JSObject())
        } catch (e: Exception) {
            Log.e(TAG, "disconnect failed", e)
            invoke.reject(e.message ?: e.toString())
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
    fun status(invoke: Invoke) {
        val up = try {
            backend.getState(tunnel) == Tunnel.State.UP
        } catch (e: Exception) {
            Log.w(TAG, "state unavailable", e)
            false
        }

        var rx = 0L
        var tx = 0L
        var handshakeAge: Long? = null

        if (up) {
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
        invoke.resolve(result)
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
    fun listApps(invoke: Invoke) {
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

        invoke.resolve(JSObject().put("apps", apps))
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
    }
}
