package com.mywhatsapp;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.mywhatsapp.errors.MyWhatsappError;
import com.mywhatsapp.http.HttpMethod;
import com.mywhatsapp.http.HttpTransport;
import com.mywhatsapp.model.SuccessResult;
import com.mywhatsapp.support.MockTransport;
import java.time.Duration;
import org.junit.jupiter.api.Test;

class ConfigTest {
    private static ClientConfig.Builder base() {
        return ClientConfig.builder().baseUrl("http://h").apiKey("owa_k1_x");
    }

    @Test
    void rejectsZeroAndNegativeTimeout() {
        assertThrows(IllegalArgumentException.class, () -> base().timeout(Duration.ZERO).build());
        assertThrows(IllegalArgumentException.class, () -> base().timeout(Duration.ofSeconds(-1)).build());
    }

    @Test
    void rejectsMalformedBaseUrl() {
        assertThrows(IllegalArgumentException.class,
            () -> ClientConfig.builder().baseUrl("http://my host:2785").apiKey("owa_k1_x").build());
    }

    @Test
    void rejectsApiKeyWithInteriorControlChar() {
        assertThrows(IllegalArgumentException.class,
            () -> ClientConfig.builder().baseUrl("http://h").apiKey("owa\nk1").build());
    }

    @Test
    void trimsWhitespaceFromBaseUrlAndApiKey() {
        // A trailing newline (e.g. key read from a file/env) must be tolerated, not fatal.
        MockTransport tx = new MockTransport().respond(200, "{\"valid\":true}");
        MyWhatsappClient c = new MyWhatsappClient(
            ClientConfig.builder().baseUrl("http://h ").apiKey(" owa_k1_x\n").transport(tx).build());
        c.auth();
        assertEquals("owa_k1_x", tx.lastRequest().headers().get("X-API-Key"));
        assertTrue(tx.lastRequest().url().startsWith("http://h/"));
    }

    @Test
    void transportIllegalArgumentIsWrappedAsMyWhatsappError() {
        HttpTransport bad = req -> {
            throw new IllegalArgumentException("restricted header name: \"Host\"");
        };
        MyWhatsappClient c = new MyWhatsappClient(base().transport(bad).build());
        MyWhatsappError e = assertThrows(MyWhatsappError.class,
            () -> c.request(HttpMethod.GET, "/x", null, null, SuccessResult.class));
        assertTrue(e.getMessage().contains("Invalid request"));
    }
}
