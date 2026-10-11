package dev.bota.sdk.internal.byo

import java.math.BigDecimal
import org.json.JSONArray
import org.json.JSONObject

/** Exact JSON proof comparison using only Android's platform JSON API. */
internal fun JSONObject.byoEquivalent(other: JSONObject): Boolean {
    if (length() != other.length()) return false
    val keys = keys()
    while (keys.hasNext()) {
        val key = keys.next()
        if (!other.has(key) || !byoJSONValueEquals(get(key), other.get(key))) return false
    }
    return true
}

private fun byoJSONValueEquals(left: Any?, right: Any?): Boolean = when {
    left === right -> true
    left == null || right == null -> false
    left is JSONObject && right is JSONObject -> left.byoEquivalent(right)
    left is JSONArray && right is JSONArray -> left.length() == right.length() &&
        (0 until left.length()).all { byoJSONValueEquals(left.get(it), right.get(it)) }
    // Never round identity/completion evidence through Double or coerce strings/booleans.
    left is Number && right is Number -> runCatching {
        BigDecimal(left.toString()).compareTo(BigDecimal(right.toString())) == 0
    }.getOrDefault(false)
    else -> left == right
}
