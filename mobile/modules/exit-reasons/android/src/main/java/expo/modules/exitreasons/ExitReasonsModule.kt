package expo.modules.exitreasons

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject

/**
 * Why Android ended the app's process, since the last time anyone asked.
 *
 * Android 11 and later keep the reason for each recent exit -- a crash, an ANR,
 * the low-memory killer, excessive resource use -- and hand it to the app on
 * request. Read on launch and whenever the app returns to the foreground; see
 * `src/lib/os-exit-reports.ts`, which decides which of them are worth a line in
 * the error log.
 */
class ExitReasonsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExitReasons")

    AsyncFunction<String>("takeReports") {
      return@AsyncFunction takeReports(context)
    }
  }

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private fun takeReports(context: Context): String {
    val reports = JSONArray()
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return reports.toString()
    val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
      ?: return reports.toString()
    val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    val lastSeen = preferences.getLong(LAST_SEEN, 0L)
    var newest = lastSeen

    for (exit in manager.getHistoricalProcessExitReasons(null, 0, MAXIMUM_EXITS)) {
      if (exit.timestamp <= lastSeen) continue
      if (exit.timestamp > newest) newest = exit.timestamp
      val detail = JSONObject()
        .put("reason", reasonName(exit.reason))
        .put("description", exit.description ?: "")
        .put("timestamp", exit.timestamp)
        .put("importance", exit.importance)
        .put("status", exit.status)
        .put("pssKb", exit.pss)
        .put("rssKb", exit.rss)
      reports.put(
        JSONObject()
          .put("kind", "android-exit")
          .put("json", detail.toString())
          .put("receivedAt", exit.timestamp.toString())
      )
    }
    if (newest > lastSeen) preferences.edit().putLong(LAST_SEEN, newest).apply()
    return reports.toString()
  }

  // Numbers rather than the constants, so a reason added after the SDK this
  // compiles against still has a name.
  private fun reasonName(reason: Int): String = when (reason) {
    1 -> "EXIT_SELF"
    2 -> "SIGNALED"
    3 -> "LOW_MEMORY"
    4 -> "CRASH"
    5 -> "CRASH_NATIVE"
    6 -> "ANR"
    7 -> "INITIALIZATION_FAILURE"
    8 -> "PERMISSION_CHANGE"
    9 -> "EXCESSIVE_RESOURCE_USAGE"
    10 -> "USER_REQUESTED"
    11 -> "USER_STOPPED"
    12 -> "DEPENDENCY_DIED"
    13 -> "OTHER"
    14 -> "FREEZER"
    15 -> "PACKAGE_STATE_CHANGE"
    16 -> "PACKAGE_UPDATED"
    else -> "UNKNOWN"
  }

  companion object {
    private const val PREFERENCES = "expo.modules.exitreasons"
    private const val LAST_SEEN = "lastSeenTimestamp"
    private const val MAXIMUM_EXITS = 16
  }
}
