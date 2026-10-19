package com.choidev.choiterm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NoticeTest {
    @Test
    fun readsNoticeLinesOnly() {
        val notice = parseNotice("""data: {"id":12,"session":"s1","title":"리팩터링","kind":"done","text":"다 고쳤어요","at":1}""")

        assertEquals(Notice(12, "s1", "리팩터링", "done", "다 고쳤어요"), notice)
        assertNull(parseNotice(": ping"))
        assertNull(parseNotice("id: 12"))
        assertNull(parseNotice("data: not json"))
    }

    @Test
    fun readsAnswerButtons() {
        val notice = parseNotice("""data: {"id":3,"session":"s","title":"t","kind":"question","text":"어느 쪽?","answers":[{"label":"왼쪽","keys":"1"},{"label":"오른쪽","keys":"2"}]}""")

        assertEquals(listOf("왼쪽", "오른쪽"), notice?.answers)
        assertEquals("답했어요: 왼쪽", answerResult(200, "왼쪽"))
        assertEquals("이미 답했거나 지난 질문이에요", answerResult(409, "왼쪽"))
    }

    @Test
    fun headlineSaysWhatHappened() {
        assertEquals("작업 · 질문이 있어요", headline(Notice(1, "s", "작업", "question", "")))
        assertEquals("작업 · 끝났어요", headline(Notice(1, "s", "작업", "done", "")))
        assertEquals("작업 · 확인이 필요해요", headline(Notice(1, "s", "작업", "attention", "")))
        assertEquals("office · 작업 · 끝났어요", headline(Notice(1, "s", "작업", "done", ""), "office"))
        assertEquals(Home.main, Notice(1, "s", "작업", "done", "").base)
    }
}
