package com.matisseduffield.tally

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.view.HapticFeedbackConstants
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.edit
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.matisseduffield.tally.updates.AppUpdates
import com.matisseduffield.tally.watch.Watch
import org.json.JSONObject

/**
 * Hosts web/index.html (bundled as assets) in a WebView. The asset loader
 * serves it from a real https origin, so localStorage and the sync server's
 * CORS behave exactly as they do in a browser. A message bridge, limited to
 * that origin, lets the page drive Back, sharing, haptics and update checks,
 * and tells the app which groups to watch for notifications; group links
 * opened on the phone (or from a notification) are handed to the page.
 */
class MainActivity : ComponentActivity() {
    private companion object {
        const val APP_HOST = WebViewAssetLoader.DEFAULT_DOMAIN
        const val APP_ORIGIN = "https://$APP_HOST"
        const val START_URL = "$APP_ORIGIN/assets/index.html"
        const val BRIDGE_NAME = "tallyApp"
        const val STATE_URL = "url"

        // Changes saved on a weak signal keep retrying this long after the app
        // goes out of sight; then the page's timers stop as usual.
        const val UNSENT_GRACE_MS = 10 * 60 * 1000L

        // The page's tallyBack() closes the top sheet or leaves the open
        // group, and says whether it did anything.
        const val BACK_JS = "(() => typeof tallyBack === 'function' && tallyBack() === true)()"
    }

    private lateinit var web: WebView
    private val updates = AppUpdates(this, ::send)
    private var page: JavaScriptReplyProxy? = null
    private var pendingLink: String? = null
    private var unsent = false
    private var resumed = false
    private val pauseLater = Runnable { if (!resumed) web.pauseTimers() }
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    // With the bridge, Back is only intercepted while the page has somewhere
    // to go back to (a sheet or a group; its "back" message), so the system's
    // predictive back gesture works on the home screen.
    private val pageBack = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
            web.evaluateJavascript(BACK_JS, null)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !night
            isAppearanceLightNavigationBars = !night
        }

        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web = WebView(this).apply {
            setBackgroundColor(getColor(R.color.page_bg))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            // Follow the phone's font size setting.
            settings.textZoom = (resources.configuration.fontScale * 100).toInt()
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest,
                ): WebResourceResponse? = assets.shouldInterceptRequest(request.url)

                // If Android ends the page's renderer (low memory), start the
                // screen again rather than letting the whole app crash.
                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    recreate()
                    return true
                }

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (request.url.host == APP_HOST) return false
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                    return true
                }
            }
        }

        val root = FrameLayout(this).apply {
            setBackgroundColor(getColor(R.color.page_bg))
            addView(web)
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, BRIDGE_NAME, setOf(APP_ORIGIN)) { _, message, origin, isMainFrame, reply ->
                if (isMainFrame && origin == APP_ORIGIN.toUri()) onPageMessage(message, reply)
            }
            onBackPressedDispatcher.addCallback(this, pageBack)
        } else {
            // Older WebView without the bridge: always ask the page first.
            onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    web.evaluateJavascript(BACK_JS) { handled ->
                        if (handled != "true") moveTaskToBack(true)
                    }
                }
            })
        }
        // Started again (a theme or font size change, or Android ending the app
        // while it was away): reopen where the page was, such as a group's #g=id.
        // The link that first opened the app was taken then, so it isn't again.
        val restored = savedInstanceState?.getString(STATE_URL)?.takeIf(::isOwnPage)
        web.loadUrl(restored ?: START_URL)
        if (savedInstanceState == null) takeLink(intent)

        updates.start(firstCreate = savedInstanceState == null)
    }

    // Out of sight, the page's timers and syncing stop entirely; they resume
    // (and catch up) as soon as the app is back. Changes not yet sent are the
    // exception: the page keeps retrying them for a while (it says when it has
    // some), and its timers stop once they're sent or the while is up.
    override fun onResume() {
        super.onResume()
        resumed = true
        web.removeCallbacks(pauseLater)
        Watch.foreground = true
        web.onResume()
        web.resumeTimers()
        updates.onResume()
    }

    override fun onPause() {
        resumed = false
        Watch.foreground = false
        web.onPause()
        if (unsent) web.postDelayed(pauseLater, UNSENT_GRACE_MS) else web.pauseTimers()
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.url?.takeIf(::isOwnPage)?.let { outState.putString(STATE_URL, it) }
    }

    override fun onDestroy() {
        web.removeCallbacks(pauseLater)
        web.destroy()
        super.onDestroy()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        takeLink(intent)
    }

    /**
     * A group link opened on the phone, or a group's notification tapped:
     * hand it to the page (now, or once it says hello).
     */
    private fun takeLink(intent: Intent?) {
        val group = intent?.getStringExtra(Watch.EXTRA_GROUP)
        if (group != null) {
            pendingLink = "${Watch.SITE}/g/$group"
            intent.removeExtra(Watch.EXTRA_GROUP)
        } else {
            if (intent?.action != Intent.ACTION_VIEW) return
            pendingLink = intent.dataString ?: return
            intent.data = null
        }
        sendLink()
    }

    private fun sendLink() {
        val url = pendingLink ?: return
        if (page == null) return
        send(JSONObject().put("type", "openLink").put("url", url))
        pendingLink = null
    }

    private fun onPageMessage(message: WebMessageCompat, reply: JavaScriptReplyProxy) {
        val msg = runCatching { JSONObject(message.data ?: return) }.getOrNull() ?: return
        when (msg.optString("type")) {
            "hello" -> {
                page = reply
                send(JSONObject().put("type", "info").put("version", BuildConfig.VERSION_NAME).put("updates", BuildConfig.SELF_UPDATER))
                updates.onPageReady()
                sendLink()
            }
            "back" -> pageBack.isEnabled = msg.optBoolean("enabled")
            "unsent" -> {
                unsent = msg.optBoolean("on")
                // Sent while out of sight: nothing left to retry, so stop now.
                if (!unsent && !resumed) {
                    web.removeCallbacks(pauseLater)
                    web.pauseTimers()
                }
            }
            "share" -> runCatching {
                val send = Intent(Intent.ACTION_SEND)
                    .setType("text/plain")
                    .putExtra(Intent.EXTRA_SUBJECT, msg.optString("title"))
                    .putExtra(Intent.EXTRA_TEXT, msg.optString("text"))
                startActivity(Intent.createChooser(send, null))
            }
            // System tap feedback; Android skips it if touch feedback is off.
            "haptic" -> web.performHapticFeedback(
                if (msg.optString("kind") == "tick") HapticFeedbackConstants.CLOCK_TICK
                else HapticFeedbackConstants.VIRTUAL_KEY,
            )
            "watch" -> {
                val groups = msg.optJSONArray("groups") ?: return
                Watch.update(this, groups)
                askForNotificationsOnce(groups.length() > 0)
            }
            "checkUpdate" -> updates.checkNow()
            "installUpdate" -> updates.installPending()
        }
    }

    /** Android 13+ asks before notifying: once, when there's a group to hear about. */
    private fun askForNotificationsOnce(haveGroups: Boolean) {
        if (!haveGroups || Build.VERSION.SDK_INT < 33 || Watch.notificationsOn(this)) return
        val prefs = getSharedPreferences("app", MODE_PRIVATE)
        if (prefs.getBoolean("askedNotifications", false)) return
        prefs.edit { putBoolean("askedNotifications", true) }
        askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    /** Only the bundled page itself, never another site, is reopened after a restart. */
    private fun isOwnPage(url: String): Boolean {
        val uri = url.toUri()
        return uri.scheme == "https" && uri.host == APP_HOST && uri.path == "/assets/index.html"
    }

    // Only reachable when WEB_MESSAGE_LISTENER is supported: [page] is set by a bridge message.
    @SuppressLint("RequiresFeature")
    private fun send(json: JSONObject) {
        runCatching { page?.postMessage(json.toString()) }
    }

}
