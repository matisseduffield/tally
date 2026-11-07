package com.matisseduffield.tally.watch

import android.app.job.JobParameters
import android.app.job.JobService
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.DateFormat
import java.text.NumberFormat
import java.util.Currency
import java.util.Date
import kotlin.concurrent.thread

/**
 * The periodic check: each group is fetched against its ETag, and changes
 * newer than what you've seen, made by someone else, become one
 * notification for that group.
 */
class WatchJob : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        thread {
            try {
                runCatching { check() }
            } finally {
                jobFinished(params, false)
            }
        }
        return true
    }

    override fun onStopJob(params: JobParameters) = true

    private fun check() {
        // On screen, the page syncs and shows changes itself (and moves "seen" on).
        if (Watch.foreground || !Watch.notificationsOn(this)) return
        val groups = Watch.load(this)
        if (groups.isEmpty()) return
        val updated = groups.map { group ->
            val (state, etag) = fetch(group) ?: return@map group
            // Comes with the fetch, so a countdown costs no extra requests. Its
            // purge time tells one countdown from the next.
            val deleting = state.optLong("deleting")
            val warn = deleting > 0 && deleting != group.warned
            val lines = listOfNotNull(countdown(deleting).takeIf { warn }) + describe(group, state)
            val newest = entries(state).maxOfOrNull { it.optLong("updatedAt") } ?: 0L
            Watch.notify(this, group, lines)
            group.copy(seen = maxOf(group.seen, newest), etag = etag, warned = if (warn) deleting else group.warned)
        }
        // The page may have changed the list meanwhile; only move these groups on.
        val now = Watch.load(this).associateBy { it.id }
        Watch.save(this, now.values.map { cur ->
            val mine = updated.find { it.id == cur.id } ?: return@map cur
            cur.copy(seen = maxOf(cur.seen, mine.seen), etag = mine.etag, warned = maxOf(cur.warned, mine.warned))
        })
    }

    /** The group's state and ETag, or null if unchanged (304) or unreachable. */
    private fun fetch(group: Watch.Group): Pair<JSONObject, String?>? = runCatching {
        // With the version we last saw, only entries changed since then come back.
        val since = group.etag?.filter { it.isDigit() }?.takeIf { it.isNotEmpty() }
        val query = since?.let { "?since=$it" }.orEmpty()
        val conn = (URL("${Watch.SITE}/api/g/${group.id}$query").openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            readTimeout = 15_000
            useCaches = false
            group.etag?.let { setRequestProperty("If-None-Match", it) }
        }
        try {
            if (conn.responseCode != 200) return null
            JSONObject(conn.inputStream.bufferedReader().readText()) to conn.getHeaderField("ETag")
        } finally {
            conn.disconnect()
        }
    }.getOrNull()

    private fun countdown(deleting: Long) =
        "Someone asked to delete this group. It goes on ${DateFormat.getDateInstance(DateFormat.LONG).format(Date(deleting))} unless someone undoes it."

    private fun entries(state: JSONObject) =
        state.optJSONArray("entries")?.let { arr -> (0 until arr.length()).mapNotNull { arr.optJSONObject(it) } }.orEmpty()

    /** "Sam added Dinner · €40.00", one line per change, oldest first. */
    private fun describe(group: Watch.Group, state: JSONObject): List<String> {
        val names = state.optJSONArray("members")?.let { arr ->
            (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }.associate { it.optString("id") to it.optString("name") }
        }.orEmpty()
        fun name(id: String, you: String = "you") = if (id == group.me) you else names[id]?.ifEmpty { null } ?: "Someone"
        return entries(state)
            .filter { it.optLong("updatedAt") > group.seen && it.optString("by") != group.me }
            .sortedBy { it.optLong("updatedAt") }
            .map { e ->
                val who = name(e.optString("by"), "You")
                val amount = money(e.optDouble("amount"), e.optString("currency"))
                val created = e.optLong("updatedAt") - e.optLong("createdAt") < 1000
                if (e.optString("kind") == "payment") {
                    val what = "${name(e.optString("from"), "You")} paid ${name(e.optString("to"))} $amount"
                    when {
                        e.optBoolean("deleted") -> "$who deleted a payment: $what"
                        created && e.optString("by") == e.optString("from") -> what
                        created -> "$who recorded: $what"
                        else -> "$who changed a payment: $what"
                    }
                } else {
                    val title = e.optString("title").ifEmpty { "an expense" }
                    when {
                        e.optBoolean("deleted") -> "$who deleted $title"
                        created -> "$who added $title · $amount"
                        else -> "$who changed $title · $amount"
                    }
                }
            }
    }

    private fun money(amount: Double, code: String): String = runCatching {
        val currency = Currency.getInstance(code)
        NumberFormat.getCurrencyInstance().apply {
            this.currency = currency
            minimumFractionDigits = currency.defaultFractionDigits
            maximumFractionDigits = currency.defaultFractionDigits
        }.format(amount)
    }.getOrElse { "${NumberFormat.getNumberInstance().format(amount)} $code" }
}
