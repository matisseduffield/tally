package com.matisseduffield.tally.updates

import android.app.AlertDialog
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewFeature
import com.matisseduffield.tally.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * The self-updater's side of MainActivity: when to check, the page's update
 * card, and the dialog fallback. The play flavor has a class of the same name
 * whose methods do nothing, so main code compiles for both.
 */
class AppUpdates(
    private val activity: ComponentActivity,
    private val send: (JSONObject) -> Unit,
) {
    private companion object {
        const val CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000L
    }

    private var lastUpdateCheck = 0L
    private var updatePromptOpen = false
    private val bridgeSupported by lazy { WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) }
    private var pendingUpdate: UpdateManager.UpdateInfo? = null
    private var installing = false

    /** Call from onCreate. [firstCreate] is false when the activity is being rebuilt. */
    fun start(firstCreate: Boolean) {
        // A downloaded update has done its job once the new version is running.
        if (firstCreate) {
            activity.lifecycleScope.launch(Dispatchers.IO) { File(activity.cacheDir, "updates").deleteRecursively() }
        }

        activity.lifecycleScope.launch {
            UpdateManager.installError.collect { message ->
                if (message != null) {
                    if (installing) {
                        installing = false
                        sendUpdateState("failed") { put("message", message) }
                    } else {
                        Toast.makeText(activity, message, Toast.LENGTH_LONG).show()
                    }
                    UpdateManager.installError.value = null
                }
            }
        }
    }

    fun onResume() = maybeCheckForUpdate()

    /** The page has said hello: show it anything found before it was listening. */
    fun onPageReady() {
        pendingUpdate?.let { sendUpdateCard(it) }
    }

    fun installPending() {
        pendingUpdate?.let { installFromCard(it) }
    }

    // ---- update card ----
    // With the bridge, updates appear as a card in the page; the system dialog
    // below is only the fallback for WebViews without it.

    private fun onUpdateAvailable(info: UpdateManager.UpdateInfo) {
        if (!bridgeSupported) {
            if (!updatePromptOpen) offerUpdate(info)
            return
        }
        pendingUpdate = info
        sendUpdateCard(info) // no-op until the page has said hello; "hello" sends it then
    }

    private fun sendUpdateCard(info: UpdateManager.UpdateInfo) {
        if (installing) return
        send(
            JSONObject()
                .put("type", "update")
                .put("state", "available")
                .put("version", info.versionName)
                .put("size", info.sizeBytes)
                .put("notes", JSONArray(info.notes)),
        )
    }

    private fun sendUpdateState(state: String, extra: JSONObject.() -> Unit = {}) {
        activity.runOnUiThread { send(JSONObject().put("type", "update").put("state", state).apply(extra)) }
    }

    private fun installFromCard(info: UpdateManager.UpdateInfo) {
        if (installing) return
        installing = true
        activity.lifecycleScope.launch {
            try {
                var lastPct = -1
                val apk = UpdateManager.download(activity, info) { fraction ->
                    val pct = (fraction * 100).toInt()
                    if (pct != lastPct) {
                        lastPct = pct
                        sendUpdateState("downloading") { put("progress", fraction.toDouble()) }
                    }
                }
                sendUpdateState("installing")
                UpdateManager.install(activity, apk)
            } catch (e: Exception) {
                installing = false
                sendUpdateState("failed") { put("message", e.message ?: "The download didn't finish.") }
            }
        }
    }

    /** Result of a check the page asked for: "available", "latest" or "failed". */
    private fun sendUpdateStatus(state: String) {
        send(JSONObject().put("type", "updateStatus").put("state", state))
    }

    fun checkNow() {
        lastUpdateCheck = System.currentTimeMillis()
        activity.lifecycleScope.launch {
            when (val result = UpdateManager.check()) {
                is UpdateManager.CheckResult.Available -> {
                    sendUpdateStatus("available")
                    onUpdateAvailable(result.info)
                }
                UpdateManager.CheckResult.UpToDate -> sendUpdateStatus("latest")
                is UpdateManager.CheckResult.Failed -> sendUpdateStatus("failed")
            }
        }
    }

    private fun maybeCheckForUpdate() {
        val now = System.currentTimeMillis()
        if (updatePromptOpen || now - lastUpdateCheck < CHECK_INTERVAL_MS) return
        lastUpdateCheck = now
        activity.lifecycleScope.launch {
            val result = UpdateManager.check()
            if (result is UpdateManager.CheckResult.Available && !activity.isFinishing) onUpdateAvailable(result.info)
        }
    }

    private fun offerUpdate(info: UpdateManager.UpdateInfo) {
        updatePromptOpen = true
        AlertDialog.Builder(activity)
            .setTitle("Update available")
            .setMessage("Tally ${info.versionName} is ready to install. You have ${BuildConfig.VERSION_NAME}.")
            .setPositiveButton("Update") { _, _ -> runUpdate(info) }
            .setNegativeButton("Later", null)
            .setOnDismissListener { updatePromptOpen = false }
            .show()
    }

    private fun runUpdate(info: UpdateManager.UpdateInfo) {
        val pad = (24 * activity.resources.displayMetrics.density).toInt()
        val bar = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            isIndeterminate = info.sizeBytes <= 0
        }
        val box = FrameLayout(activity).apply {
            setPadding(pad, pad / 2, pad, 0)
            addView(bar)
        }
        val progress = AlertDialog.Builder(activity)
            .setTitle("Downloading ${info.versionName}")
            .setView(box)
            .setCancelable(false)
            .show()

        activity.lifecycleScope.launch {
            try {
                val apk = UpdateManager.download(activity, info) { fraction ->
                    activity.runOnUiThread { bar.progress = (fraction * 100).toInt() }
                }
                progress.dismiss()
                UpdateManager.install(activity, apk)
            } catch (e: Exception) {
                progress.dismiss()
                Toast.makeText(
                    activity,
                    "Update failed: ${e.message ?: "unknown error"}",
                    Toast.LENGTH_LONG,
                ).show()
            }
        }
    }
}
