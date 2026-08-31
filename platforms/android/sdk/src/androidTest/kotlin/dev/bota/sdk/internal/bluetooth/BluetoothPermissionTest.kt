package dev.bota.sdk.internal.bluetooth

import android.content.pm.PackageManager
import android.os.Build
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
internal class BluetoothPermissionTest {
    @Test
    fun permissionContractMatchesAndroidVersionAndMergedManifest() {
        val expected = if (Build.VERSION.SDK_INT >= 31) {
            setOf(BluetoothPermissionChecker.BluetoothScan, BluetoothPermissionChecker.BluetoothConnect)
        } else {
            setOf(BluetoothPermissionChecker.FineLocation)
        }
        val checker = BluetoothPermissionChecker(Build.VERSION.SDK_INT) { false }

        assertEquals(expected, checker.requiredPermissions)

        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        @Suppress("DEPRECATION")
        val requested = context.packageManager
            .getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
            .requestedPermissions
            ?.toSet()
            .orEmpty()
        assertTrue("Merged manifest is missing $expected; found $requested", requested.containsAll(expected))
    }
}
