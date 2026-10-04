package com.mywhatsapp.errors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class ErrorsTest {
    @Test
    void mapsStatusToSubclassAndParsesNestEnvelope() {
        String body = "{\"statusCode\":404,\"message\":\"Session not found\",\"error\":\"Not Found\"}";
        MyWhatsappApiError e = MyWhatsappApiError.fromResponse(404, "Not Found", body, "GET /api/sessions/x");
        assertTrue(e instanceof MyWhatsappNotFoundError);
        assertEquals(404, e.status());
        assertEquals("Not Found", e.errorKind());
        assertTrue(e.getMessage().contains("Session not found"));
    }

    @Test
    void joinsArrayMessages() {
        String body = "{\"statusCode\":400,\"message\":[\"a must be set\",\"b invalid\"],\"error\":\"Bad Request\"}";
        MyWhatsappApiError e = MyWhatsappApiError.fromResponse(400, "Bad Request", body, "POST /x");
        assertTrue(e.getMessage().contains("a must be set, b invalid"));
    }

    @Test
    void mapsTheRetryableStatusToItsOwnSubclass() {
        // 503 is the gateway's answer when the engine never confirmed an operation — a transport
        // failure, and the only typed error here worth retrying. It used to fall through to the base
        // class while 501, which is permanent, had a subclass of its own.
        String body = "{\"statusCode\":503,\"message\":\"WhatsApp did not answer\",\"error\":\"Service Unavailable\"}";
        MyWhatsappApiError e = MyWhatsappApiError.fromResponse(503, "Service Unavailable", body, "POST /x");
        assertTrue(e instanceof MyWhatsappServiceUnavailableError);
        assertEquals(503, e.status());
    }

    @Test
    void unmappedStatusFallsBackToBase() {
        MyWhatsappApiError e = MyWhatsappApiError.fromResponse(418, "I'm a teapot", "", "GET /x");
        assertEquals(MyWhatsappApiError.class, e.getClass());
        assertEquals(418, e.status());
    }

    @Test
    void redirectStatusGetsClearMessage() {
        MyWhatsappApiError e = MyWhatsappApiError.fromResponse(302, "Found", "", "GET /x");
        assertFalse(e instanceof MyWhatsappNotFoundError);
        assertTrue(e.getMessage().toLowerCase().contains("redirect"));
    }

    @Test
    void timeoutErrorMessage() {
        MyWhatsappTimeoutError t = new MyWhatsappTimeoutError(30000);
        assertTrue(t.getMessage().contains("30000"));
        assertTrue(t instanceof MyWhatsappError);
    }

    @Test
    void blankStatusTextProducesNoDoubleSpace() {
        // The default transport exposes no HTTP reason phrase, so the client passes "" as statusText.
        String body = "{\"statusCode\":404,\"message\":\"Session x not found\",\"error\":\"Not Found\"}";
        MyWhatsappApiError e = MyWhatsappApiError.fromResponse(404, "", body, "GET /api/sessions/x");
        assertTrue(e.getMessage().contains("Session x not found"));
        assertFalse(e.getMessage().contains("404  "), "must not emit a double space when statusText is blank");
        assertTrue(e.getMessage().startsWith("MyWhatsapp API 404 — GET /api/sessions/x"));
    }

    @Test
    void partialEnvelopeWithoutErrorFieldStillKeepsMessage() {
        // NestJS default 500 carries {statusCode, message} but no `error` field — the message must survive.
        String body = "{\"statusCode\":500,\"message\":\"Internal server error\"}";
        MyWhatsappApiError e = MyWhatsappApiError.fromResponse(500, "", body, "GET /api/x");
        assertEquals(MyWhatsappApiError.class, e.getClass());
        assertTrue(e.getMessage().contains("Internal server error"), "message text must not be dropped");
    }

    @Test
    void bodylessErrorHasCleanMessage() {
        MyWhatsappApiError e = MyWhatsappApiError.fromResponse(502, "", "", "GET /api/x");
        assertEquals("MyWhatsapp API 502 — GET /api/x", e.getMessage());
    }
}
