package com.choidev.choiterm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class OwnPageTest {
    @Before
    fun setUp() {
        Home.main = "https://desk.tailtest.ts.net:8449/"
    }

    @Test
    fun keepsChoiTermPagesOfEveryPcOnTheTailnet() {
        assertTrue(isOwnPage("https://desk.tailtest.ts.net:8449/"))
        assertTrue(isOwnPage("https://desk.tailtest.ts.net:8449/app.js"))
        assertTrue(isOwnPage("https://office.tailtest.ts.net:8449/#open=s1"))
        assertFalse(isOwnPage("https://office.other-tailnet.ts.net:8449/"))
        assertFalse(isOwnPage("https://a.office.tailtest.ts.net:8449/"))
        assertFalse(isOwnPage("https://tailtest.ts.net:8449/"))
        assertFalse(isOwnPage("https://desk.tailtest.ts.net:8443/"))
        assertFalse(isOwnPage("http://desk.tailtest.ts.net:8449/"))
        assertFalse(isOwnPage("https://github.com/"))
        assertFalse(isOwnPage("not a url"))
    }

    @Test
    fun originIsThePcsPage() {
        assertEquals("https://office.tailtest.ts.net:8449/", originOf("https://office.tailtest.ts.net:8449/app.js?x=1#open=s"))
        assertEquals(Home.main, originOf(Home.main))
        assertNull(originOf("https://github.com/"))
        assertNull(originOf("about:blank"))
    }

    @Test
    fun machinesKeepOnlyChoiTermPages() {
        val machines = parseMachines(
            """{"machines":[{"name":"desk","url":"https://desk.tailtest.ts.net:8449/","online":true,"here":true},""" +
                """{"name":"office","url":"https://office.tailtest.ts.net:8449/","online":false,"here":false},""" +
                """{"name":"evil","url":"https://evil.example:8449/","online":true,"here":false}]}""",
        )

        assertEquals(
            listOf(Machine("desk", "https://desk.tailtest.ts.net:8449/"), Machine("office", "https://office.tailtest.ts.net:8449/")),
            machines,
        )
        assertEquals(emptyList<Machine>(), parseMachines("not json"))
    }

    @Test
    fun theAddressTypedOnTheFirstStartBecomesThePcsPage() {
        assertEquals("https://my-pc.tail1.ts.net:8449/", normalizeHome("my-pc.tail1.ts.net"))
        assertEquals("https://my-pc.tail1.ts.net:8449/", normalizeHome(" https://My-PC.tail1.ts.net:8449/app.js "))
        assertEquals("https://my-pc.tail1.ts.net:9000/", normalizeHome("https://my-pc.tail1.ts.net:9000"))
        assertNull(normalizeHome("http://my-pc.tail1.ts.net:8449"))
        assertNull(normalizeHome("github.com"))
        assertNull(normalizeHome("tail1.ts.net"))
    }
}
