package com.matisseduffield.tally.updates

import androidx.activity.ComponentActivity
import org.json.JSONObject

/**
 * Play builds update through the store, so MainActivity's calls land here and
 * do nothing. The real updater is in the github flavor, under the same name.
 */
@Suppress("UNUSED_PARAMETER")
class AppUpdates(activity: ComponentActivity, send: (JSONObject) -> Unit) {
    fun start(firstCreate: Boolean) = Unit
    fun onResume() = Unit
    fun onPageReady() = Unit
    fun installPending() = Unit
    fun checkNow() = Unit
}
