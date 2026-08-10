package com.neoxify.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import neoxifyxray.Neoxifyxray
import neoxifyxray.Protector

/**
 * The TUN device for the Xray protocols.
 *
 * A second VpnService alongside WireGuard's, which is not duplication:
 * `com.wireguard.android:tunnel` ships and owns its own service, and
 * Android permits only one active VPN per app anyway, so the two are
 * alternatives rather than peers. Whichever protocol the ladder settles
 * on brings up its own.
 *
 * This one hands its file descriptor straight to xray-core, whose `tun`
 * inbound reads raw L3 packets from it through a gVisor stack. There is
 * no tun2socks and no local SOCKS hop -- xray-core does that itself, a
 * capability confirmed in its own source before any of this was built.
 *
 * It also implements [Protector], and that is the load-bearing part.
 * Xray's own connection to the Neoxify server must not be routed into
 * the tunnel Xray is serving; `VpnService.protect` is Android's only way
 * to say so, and without it the tunnel comes up and then carries nothing
 * -- a loop that looks exactly like a dead server.
 */
class NeoxifyTunService : VpnService(), Protector {
    private var tun: ParcelFileDescriptor? = null

    /** Whether the Go engine has actually been started in this service.
     * See the note in teardown. */
    private var started = false

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Android requires a visible notification for a service holding a
        // VPN, and rightly: a tunnel nobody can see is a tunnel nobody
        // can turn off.
        //
        // Guarded because this runs on the main thread, dispatched by the
        // system, outside every try/catch the plugin has -- so anything
        // thrown here kills the process rather than failing the connect.
        // A missing foreground-service permission did exactly that on
        // 0.2.7 and presented as "the app crashes on stealth protocols",
        // with no error anywhere the customer or the telemetry could see
        // it. The permission is declared now; this makes the next reason
        // -- an OEM policy, a future platform rule -- a legible failure
        // instead of a silent death.
        try {
            startForeground(NOTIFICATION_ID, buildNotification())
        } catch (e: Throwable) {
            Log.e(TAG, "could not start in the foreground; stopping", e)
            // Must stop: a service started with startForegroundService
            // that never calls startForeground is killed by the system
            // anyway, with an ANR rather than this log line.
            instance = null
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    /** Called by xray-core, from Go, for every outbound socket. */
    override fun protect(fd: Long): Boolean = protect(fd.toInt())

    override fun onDestroy() {
        teardown()
        instance = null
        super.onDestroy()
    }

    /** Android's own "stop VPN" button lands here. */
    override fun onRevoke() {
        teardown()
        super.onRevoke()
    }

    private fun teardown() {
        // Only if it was started. Calling into the Go library to stop
        // something that never ran would load libgojni.so purely to be
        // told "nothing is running" -- and loading it is exactly what we
        // are avoiding until traffic needs it.
        if (started) {
            try {
                Neoxifyxray.stop()
            } catch (e: Exception) {
                Log.w(TAG, "xray stop failed", e)
            }
            started = false
        }
        try {
            tun?.close()
        } catch (e: Exception) {
            Log.w(TAG, "closing the tun descriptor failed", e)
        }
        tun = null
    }

    private fun buildNotification(): Notification {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "VPN", NotificationManager.IMPORTANCE_LOW),
            )
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("Neoxify")
            .setContentText("Connected")
            // A framework drawable rather than one of ours: this library
            // has no resources of its own, and stat_notify_sync is the
            // stock icon available on every API level here.
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .build()
    }

    /**
     * Builds the tunnel and starts xray against it.
     *
     * Runs on the caller's thread, which the plugin guarantees is not the
     * main one -- `establish()` and xray's startup both block.
     */
    fun start(configJson: String, mtu: Int, dns: String, allowedApps: List<String>) {
        // Any prior tunnel goes first. Establishing a second one while the
        // first is up silently replaces it, leaving an orphaned descriptor
        // that xray may still be reading from.
        teardown()

        val builder = Builder()
            .setSession("Neoxify")
            .setMtu(mtu)
            // The tunnel's own address. Nothing on the far side routes to
            // it -- xray's gVisor stack terminates the traffic locally --
            // so this only has to avoid colliding with anything real. The
            // WireGuard routes use 10.66/10.67, hence a different block.
            .addAddress("172.19.0.1", 30)
            .addRoute("0.0.0.0", 0)
            .addDnsServer(dns)

        // Per-app routing, the platform's own way. This is the whole of
        // Custom mode on Android -- the Windows client needed a packet
        // redirector and a transparent proxy to reach the same place.
        for (pkg in allowedApps) {
            try {
                builder.addAllowedApplication(pkg)
            } catch (e: PackageManager.NameNotFoundException) {
                // An app uninstalled since the customer chose it. Skipping
                // it is right; throwing would make one stale entry break
                // every connection.
                Log.w(TAG, "skipping app that is no longer installed: $pkg", e)
            }
        }

        // Never route this app's own traffic. It would put the control
        // plane inside the tunnel it is managing, and make the egress
        // check measure the wrong path.
        if (allowedApps.isEmpty()) {
            try {
                builder.addDisallowedApplication(packageName)
            } catch (e: PackageManager.NameNotFoundException) {
                Log.w(TAG, "could not exclude ourselves", e)
            }
        }

        val descriptor = builder.establish()
            ?: throw IllegalStateException("Android refused to create the VPN interface")
        tun = descriptor

        try {
            Neoxifyxray.start(configJson, descriptor.fd.toLong(), this)
            started = true
        } catch (e: Exception) {
            teardown()
            throw e
        }
    }

    companion object {
        private const val TAG = "NeoxifyTun"
        private const val CHANNEL_ID = "neoxify-vpn"
        private const val NOTIFICATION_ID = 1

        /** The running service, or null.
         *
         * A static handle because Android constructs services itself and
         * the plugin needs to reach the live one. Set in onCreate and
         * cleared in onDestroy, so it is null exactly when there is no
         * service to talk to. */
        @Volatile
        var instance: NeoxifyTunService? = null
            private set
    }
}
