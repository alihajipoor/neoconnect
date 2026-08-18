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
    /** Whether Neoxifyxray.start() has been ENTERED, not whether it returned.
     *
     * The distinction is the whole bug. `started` only becomes true once
     * start() returns, so when it blocks -- which is what happens when
     * the server cannot be reached -- teardown skipped stopping the
     * engine, and the engine holds its own reference to the tun file
     * descriptor. Closing the Kotlin ParcelFileDescriptor does not take
     * the interface down while Go still has it, so the device stayed
     * captured by a tunnel carrying nothing until the process was
     * killed. Reproduced on a tablet 2026-08-18: whole-device internet
     * loss, VPN icon stuck in the status bar, and force-stop the only
     * recovery.
     */
    private var startAttempted = false

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Stopping is a message to this service, not a stopService() call
        // on it, and that is not a style choice.
        //
        // While a tunnel is established the system binds to this service
        // (BIND_VPN_SERVICE, act=android.net.VpnService) and holds that
        // binding for as long as it considers this app the active VPN.
        // A bound service is not destroyed by stopService(): the started
        // flag clears, onDestroy() never runs, and onDestroy() was the
        // only caller of teardown(). So the tun descriptor stayed open,
        // which is precisely what kept the system's binding alive --
        // the teardown was gated on a destroy that the tun itself
        // prevented.
        //
        // What that cost the customer: the app said "disconnected", the
        // VPN key stayed in the status bar, and every packet on the
        // device kept being routed into an engine that was no longer
        // carrying it. The whole phone was offline until they found
        // force-stop in Android's settings. Reproduced on the emulator
        // on 2026-08-17 -- dumpsys showed startRequested=false with the
        // system still listed under Bindings.
        //
        // Closing the descriptor here is what releases the system's
        // binding, and only then can the service actually die.
        if (intent?.action == ACTION_STOP) {
            // Required if this arrived via startForegroundService, and a
            // no-op notification update when the service was already in
            // the foreground -- which is the usual case.
            runCatching { startForeground(NOTIFICATION_ID, buildNotification()) }
            instance = null
            // Off the main thread. Stopping the engine can block for as
            // long as starting it can, and this is the system's
            // main-thread callback: doing it here would trade a stuck
            // tunnel for an ANR and leave the tun open either way.
            Thread({
                // Order matters, and it is the same lesson twice: the
                // step that frees the device must not sit behind a step
                // that can block. Stopping the engine is a call into Go
                // that can wait on the same dead network the tunnel was
                // dialling, so it happens after this service has closed
                // the tun and stopped claiming to be running -- which is
                // what the disconnect is waiting to see. If the process
                // is killed before that last call returns, the engine
                // goes with it, which is the same outcome.
                closeTun()
                clearState(this)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                } else {
                    @Suppress("DEPRECATION")
                    stopForeground(true)
                }
                stopSelf()

                // Closing our descriptor is not enough on its own: the
                // engine was handed the raw fd and keeps its own copy,
                // so the interface -- and the routes pointing into it --
                // survive until xray has finished shutting down.
                //
                // Measured on the emulator: our close landed at 0.3s and
                // the interface did not go until 4.0s, all of it waiting
                // for the engine. Killing this process dropped it in
                // under 0.26s. A disconnect a customer waits four
                // seconds for is a disconnect they press twice.
                //
                // So the engine is asked politely, briefly, and then the
                // process goes. Nothing else lives here -- it exists to
                // hold the tunnel and is being torn down -- and the
                // kernel closes every descriptor with it.
                val stopping = Thread({ stopEngine() }, "neoxify-engine-stop")
                stopping.isDaemon = true
                stopping.start()
                stopping.join(ENGINE_STOP_GRACE_MS)
                android.os.Process.killProcess(android.os.Process.myPid())
            }, "neoxify-teardown").start()
            return START_NOT_STICKY
        }

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
            publish(STATE_ERROR, e.message ?: e.toString())
            stopSelf()
            return START_NOT_STICKY
        }

        // The tunnel's details arrive in the Intent rather than through a
        // method call on this object. They have to: this service runs in
        // its own process now (see the manifest), so the plugin holds no
        // reference it could call, and the static `instance` it used to
        // use is a different static in a different address space.
        val config = intent?.getStringExtra(EXTRA_CONFIG)
        if (config != null) {
            val mtu = intent.getIntExtra(EXTRA_MTU, 1500)
            val dns = intent.getStringExtra(EXTRA_DNS) ?: "1.1.1.1"
            val apps = intent.getStringArrayListExtra(EXTRA_APPS) ?: arrayListOf()
            // Off the main thread: establish() and xray's startup both
            // block, and this is the system's main-thread callback.
            // A connect that hangs is not hypothetical -- picking a
            // server that cannot be reached does it every time -- and
            // until it returns, the tun established below is swallowing
            // every packet on the device. Nothing else in this service
            // is watching, so this is what ends it.
            val watchdog = Thread({
                try {
                    Thread.sleep(START_TIMEOUT_MS)
                } catch (_: InterruptedException) {
                    return@Thread
                }
                if (!started) {
                    Log.e(TAG, "engine did not come up within ${START_TIMEOUT_MS}ms; tearing down")
                    publish(STATE_ERROR, "The server did not respond. Try another server or protocol.")
                    teardown()
                    stopSelf()
                }
            }, "neoxify-start-watchdog")
            watchdog.start()

            Thread({
                try {
                    start(config, mtu, dns, apps)
                    watchdog.interrupt()
                    publish(STATE_UP, null)
                } catch (t: Throwable) {
                    watchdog.interrupt()
                    // Throwable: a native engine failing to load arrives
                    // as an Error, and an uncaught one here would take
                    // the process with it instead of failing the connect.
                    Log.e(TAG, "starting the tunnel failed", t)
                    publish(STATE_ERROR, t.message ?: t.toString())
                    teardown()
                    stopSelf()
                }
            }, "neoxify-xray-start").start()
        }
        // Not sticky, and deliberately so now that the teardown kills
        // this process: a restart arrives with a null Intent, which
        // carries no config, so the service would come back holding a
        // VPN notification and no tunnel -- telling the customer they
        // are protected when nothing is running. Staying down is both
        // honest and what the status file already reports.
        return START_NOT_STICKY
    }

    /** Reports state to the main process.
     *
     * A file in the app's own storage rather than a Binder or a
     * broadcast. Both processes share this directory, it survives either
     * one being restarted by the system, and it needs no lifecycle to
     * unwind on the failure paths -- which for a VPN service are most of
     * them. The payload is small and written whole, so a reader either
     * sees the previous state or the new one.
     */
    private fun publish(state: String, detail: String?) {
        try {
            stateFile(this).writeText(if (detail == null) state else "$state\n$detail")
        } catch (e: Exception) {
            Log.w(TAG, "could not publish state", e)
        }
    }

    /** Called by xray-core, from Go, for every outbound socket. */
    override fun protect(fd: Long): Boolean = protect(fd.toInt())

    override fun onDestroy() {
        teardown()
        instance = null
        // The main process reads the absence of this file as "nothing is
        // running", so it has to go whenever this service does --
        // including when the system kills the service rather than the
        // customer disconnecting.
        clearState(this)
        super.onDestroy()
    }

    /** Android's own "stop VPN" button lands here. */
    override fun onRevoke() {
        teardown()
        super.onRevoke()
    }

    /** Both halves, for the paths that are not racing anything. */
    private fun teardown() {
        closeTun()
        stopEngine()
    }

    /** Releases the device.
     *
     * This is the half the customer feels: the tun is what holds the
     * system's VPN binding and what swallows every packet on the phone.
     * Once it is closed the device routes normally again, whatever the
     * engine is still doing.
     */
    private fun closeTun() {
        // The descriptor goes first, and the order is the fix.
        //
        // Closing the tun makes the engine's reads fail, which is what
        // unwedges a start still blocked dialling a server that will
        // never answer -- the case this path exists for. Stopping the
        // engine first waits on that same dial, so the close never
        // happens and the device stays offline behind a tunnel nothing
        // is carrying.
        try {
            tun?.close()
        } catch (e: Exception) {
            Log.w(TAG, "closing the tun descriptor failed", e)
        }
        tun = null
    }

    /** Stops the engine. Best effort, and deliberately not on the path
     * that frees the device -- see closeTun. */
    private fun stopEngine() {
        // Only if it was attempted. Calling into the Go library to stop
        // something that never ran would load libgojni.so purely to be
        // told "nothing is running" -- and loading it is exactly what we
        // are avoiding until traffic needs it.
        //
        // Attempted, not completed. An engine wedged inside start() is
        // exactly the case that must be stopped, and it is the only case
        // the old `started` guard excluded.
        if (startAttempted) {
            try {
                Neoxifyxray.stop()
            } catch (e: Throwable) {
                // Throwable: this runs on the teardown path, and a
                // native Error escaping here would leave the engine
                // running -- the fault it exists to prevent.
                Log.w(TAG, "xray stop failed", e)
            }
            started = false
            startAttempted = false
        }
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

        // This app's own traffic goes through the tunnel like everything
        // else, and that is deliberate.
        //
        // It used to be excluded, to keep the control plane out of the
        // tunnel it manages. The reasoning was backwards for the check
        // that decides whether a connect succeeded: verification asks
        // the API what our exit address is and compares it against the
        // address before connecting. Excluded, the app was the one
        // process still going out the plain route, so the answer never
        // changed, every Xray connect was judged "up but not carrying
        // traffic", and the ladder tore down a working tunnel and fell
        // back to Fast.
        //
        // That is why no stealth protocol has ever worked on Android
        // while WireGuard always did: GoBackend's service excludes
        // nothing, so its verification saw the truth. The node's own log
        // showed this tunnel carrying real traffic in the same seconds
        // the app declared it dead.
        //
        // Nothing loops as a result. xray-core's own sockets to the
        // server are kept out of the tunnel by VpnService.protect (see
        // the Protector the Go side calls), which is the mechanism for
        // that job -- excluding the whole app was never what stopped it.

        val descriptor = builder.establish()
            ?: throw IllegalStateException("Android refused to create the VPN interface")
        tun = descriptor

        try {
            startAttempted = true
            Neoxifyxray.start(configJson, descriptor.fd.toLong(), this)
            started = true
        } catch (e: Exception) {
            teardown()
            throw e
        }
    }

    companion object {
        /** How long the engine gets before the tunnel is torn down.
         *
         * Generous, because a slow network on a bad link is not a
         * failure and xray-core loads a 46MB engine first. But bounded,
         * because every second past this is a device with no working
         * internet and no way for the customer to fix it from the app.
         */
        private const val START_TIMEOUT_MS = 20_000L

        /** How long the engine gets to stop on its own before this
         * process is killed out from under it.
         *
         * Long enough for the system to have registered the stopSelf
         * above, short enough that the tunnel is gone before a customer
         * would reach for the button a second time. */
        private const val ENGINE_STOP_GRACE_MS = 500L
        private const val TAG = "NeoxifyTun"
        private const val CHANNEL_ID = "neoxify-vpn"
        private const val NOTIFICATION_ID = 1

        // How the tunnel's details cross the process boundary. Everything
        // the old in-process `start(...)` call took, as Intent extras.
        const val EXTRA_CONFIG = "com.neoxify.vpn.CONFIG"
        const val EXTRA_MTU = "com.neoxify.vpn.MTU"
        const val EXTRA_DNS = "com.neoxify.vpn.DNS"
        const val EXTRA_APPS = "com.neoxify.vpn.APPS"

        /** Asks the service to tear the tunnel down and stop.
         *
         * Sent as a start intent rather than stopService() -- see the
         * top of onStartCommand for why that distinction is the whole
         * fix. */
        const val ACTION_STOP = "com.neoxify.vpn.STOP"

        const val STATE_UP = "up"
        const val STATE_ERROR = "error"

        /** Where this service tells the main process how it went.
         *
         * Both processes belong to the same app and share this
         * directory, so no permissions or provider are involved. Absent
         * means "not running", which is also the correct reading after
         * the system kills either process. */
        fun stateFile(context: android.content.Context): java.io.File =
            java.io.File(context.filesDir, "xray-state")

        /** Reads the published state, or null when nothing is running. */
        fun readState(context: android.content.Context): Pair<String, String?>? = try {
            val f = stateFile(context)
            if (!f.exists()) null
            else f.readText().split("\n", limit = 2).let { it[0] to it.getOrNull(1) }
        } catch (e: Exception) {
            Log.w(TAG, "could not read state", e)
            null
        }

        fun clearState(context: android.content.Context) {
            runCatching { stateFile(context).delete() }
        }

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
