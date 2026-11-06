package com.matisseduffield.tally.updates

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller

/**
 * PackageInstaller status callback. When the system needs the user to confirm
 * the update it hands us a confirmation intent, which we launch straight away:
 * updates only start from the in-app prompt, so the app is in the foreground.
 * Terminal failures are surfaced to the UI instead of being swallowed.
 */
class UpdateInstallReceiver : BroadcastReceiver() {
    companion object {
        const val ACTION_INSTALL_STATUS = "com.matisseduffield.tally.INSTALL_STATUS"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_INSTALL_STATUS) return
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                runCatching { context.startActivity(confirm) }
                    .onFailure { UpdateManager.installError.value = "Open Tally again to finish updating" }
            }
            PackageInstaller.STATUS_SUCCESS -> {
                // App process is about to be replaced; nothing to do.
                UpdateManager.installError.value = null
            }
            PackageInstaller.STATUS_FAILURE_ABORTED -> {
                // User cancelled the confirm screen. Not an error, but the
                // update card needs to leave its "installing" state.
                UpdateManager.installError.value = "Update cancelled"
            }
            else -> {
                val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                UpdateManager.installError.value = failureText(status, msg)
            }
        }
    }

    private fun failureText(status: Int, message: String?): String = when (status) {
        PackageInstaller.STATUS_FAILURE_CONFLICT ->
            "Update blocked — a conflicting version is installed"
        PackageInstaller.STATUS_FAILURE_INCOMPATIBLE ->
            "This update isn't compatible with your device"
        PackageInstaller.STATUS_FAILURE_STORAGE ->
            "Not enough storage to install the update"
        else -> "Update failed" + if (!message.isNullOrBlank()) " — $message" else ""
    }
}
