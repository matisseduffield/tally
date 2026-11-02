package com.matisseduffield.tally.watch

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.edit
import com.matisseduffield.tally.MainActivity
import com.matisseduffield.tally.R
import org.json.JSONArray
import org.json.JSONObject

/**
 * Notifications for what others change in your groups. The page sends the
 * groups on this phone (who you are in each, and the newest change it has
 * shown); [WatchJob] checks them about every 30 minutes and notifies about
 * anything newer made by someone else. Polling an unchanged group costs a 304.
 */
object Watch {
    private const val PREFS = "watch"
    private const val JOB_ID = 1
    private const val CHANNEL = "group_activity"
    private const val CHECK_EVERY_MS = 30 * 60 * 1000L
    const val SITE = "https://tally.matisseduffield.workers.dev"
    const val EXTRA_GROUP = "group_id"

    /** True while the app is on screen, when the page shows changes itself. */
    @Volatile var foreground = false

    /** [seen]: the newest server change time already shown; [etag]: the job's last fetch. */
    data class Group(val id: String, val me: String, val name: String, val seen: Long, val etag: String?)

    fun load(context: Context): List<Group> {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("groups", null) ?: return emptyList()
        return runCatching {
            val arr = JSONArray(raw)
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                Group(o.getString("id"), o.getString("me"), o.getString("name"), o.getLong("seen"), o.optString("etag").ifEmpty { null })
            }
        }.getOrDefault(emptyList())
    }

    fun save(context: Context, list: List<Group>) {
        val arr = JSONArray(list.map {
            JSONObject().put("id", it.id).put("me", it.me).put("name", it.name).put("seen", it.seen).put("etag", it.etag ?: "")
        })
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit { putString("groups", arr.toString()) }
        schedule(context, list.isNotEmpty())
    }

    /**
     * The page's list replaces the stored one, keeping the later of the two
     * "seen" times. A group new to the list starts from now, so joining one
     * doesn't notify about its whole history.
     */
    fun update(context: Context, groups: JSONArray) {
        val old = load(context).associateBy { it.id }
        val now = System.currentTimeMillis()
        val list = (0 until groups.length()).mapNotNull { i ->
            val o = groups.optJSONObject(i) ?: return@mapNotNull null
            val id = o.optString("id").takeIf { ID.matches(it) } ?: return@mapNotNull null
            val me = o.optString("me").takeIf { ID.matches(it) } ?: return@mapNotNull null
            val seen = o.optLong("seen")
            val prev = old[id]
            Group(id, me, o.optString("name").take(60), maxOf(seen, prev?.seen ?: now), prev?.etag)
        }
        save(context, list)
    }

    private val ID = Regex("[A-Za-z0-9_-]{22}")

    fun notificationsOn(context: Context) = NotificationManagerCompat.from(context).areNotificationsEnabled()

    private fun schedule(context: Context, on: Boolean) {
        val jobs = context.getSystemService(JobScheduler::class.java)
        if (!on) return jobs.cancel(JOB_ID)
        if (jobs.getPendingJob(JOB_ID) != null) return
        // A refused job must never take the app down with it.
        runCatching {
            jobs.schedule(
                JobInfo.Builder(JOB_ID, ComponentName(context, WatchJob::class.java))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPeriodic(CHECK_EVERY_MS)
                    .setPersisted(true)
                    .build(),
            )
        }
    }

    /** One notification per group, replaced as more changes come in. */
    fun notify(context: Context, group: Group, lines: List<String>) {
        if (lines.isEmpty()) return
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, context.getString(R.string.watch_channel), NotificationManager.IMPORTANCE_DEFAULT),
        )
        val open = PendingIntent.getActivity(
            context,
            group.id.hashCode(),
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(EXTRA_GROUP, group.id),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val builder = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_tally)
            .setColor(context.getColor(R.color.icon_bg))
            .setContentTitle(group.name)
            .setContentIntent(open)
            .setAutoCancel(true)
        if (lines.size == 1) {
            builder.setContentText(lines[0]).setStyle(NotificationCompat.BigTextStyle().bigText(lines[0]))
        } else {
            val style = NotificationCompat.InboxStyle()
            lines.take(6).forEach { style.addLine(it) }
            if (lines.size > 6) style.setSummaryText("+${lines.size - 6} more")
            builder.setContentText("${lines.size} changes").setNumber(lines.size).setStyle(style)
        }
        runCatching { nm.notify(group.id.hashCode(), builder.build()) }
    }
}
