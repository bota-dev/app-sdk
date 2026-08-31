package dev.bota.legacy

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LegacyBinaryConsumerTest {
    @Test
    fun frozenConsumerLinksAgainstReplacementAar() {
        assertTrue(FrozenLegacyConsumer.exerciseLinkage().isNotEmpty())
    }
}
