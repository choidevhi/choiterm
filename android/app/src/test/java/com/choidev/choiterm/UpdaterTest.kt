package com.choidev.choiterm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class UpdaterTest {
    @Before
    fun setUp() {
        Home.main = "https://desk.tailtest.ts.net:8449/"
    }

    @Test
    fun takesTheApkOnlyFromTheOwnersPcs() {
        assertTrue(isUpdateUrl("https://desk.tailtest.ts.net:8449/ChoiTerm.apk"))
        assertTrue(isUpdateUrl("https://office.tailtest.ts.net:8449/ChoiTerm.apk"))
        assertFalse(isUpdateUrl("https://desk.tailtest.ts.net:8449/other.apk"))
        assertFalse(isUpdateUrl("https://evil.example.com/ChoiTerm.apk"))
        assertFalse(isUpdateUrl("http://desk.tailtest.ts.net:8449/ChoiTerm.apk"))
        assertFalse(isUpdateUrl("not a url"))
    }

    @Test
    fun countsWholePercents() {
        assertEquals(0, percentOf(0, 1000))
        assertEquals(37, percentOf(370, 1000))
        assertEquals(100, percentOf(1000, 1000))
        assertEquals(100, percentOf(1200, 1000))
        assertEquals(-1, percentOf(500, -1))
    }
}
