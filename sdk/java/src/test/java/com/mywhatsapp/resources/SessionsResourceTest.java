package com.mywhatsapp.resources;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.mywhatsapp.ClientConfig;
import com.mywhatsapp.MyWhatsappClient;
import com.mywhatsapp.http.HttpMethod;
import com.mywhatsapp.model.ListSessionsQuery;
import com.mywhatsapp.model.RequestPairingCodeRequest;
import com.mywhatsapp.model.SetOwnPresenceRequest;
import com.mywhatsapp.support.MockTransport;
import org.junit.jupiter.api.Test;

class SessionsResourceTest {
    final MockTransport tx = new MockTransport();
    final MyWhatsappClient client = new MyWhatsappClient(
        ClientConfig.builder().baseUrl("http://h").apiKey("k").transport(tx).build());

    @Test
    void listHitsSessionsRoot() {
        tx.respond(200, "[]");
        client.sessions.list();
        assertEquals("http://h/api/sessions", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void listSerializesNameFilter() {
        tx.respond(200, "[]");
        client.sessions.list(ListSessionsQuery.builder().name("my-bot").build());
        assertEquals("http://h/api/sessions?name=my-bot", tx.lastRequest().url());

        tx.respond(200, "[]");
        client.sessions.list(new ListSessionsQuery(5, 0));
        assertEquals("http://h/api/sessions?limit=5&offset=0", tx.lastRequest().url());
    }

    @Test
    void getEncodesId() {
        tx.respond(200, "{\"id\":\"a/b\",\"name\":\"n\",\"status\":\"ready\"}");
        client.sessions.get("a/b");
        assertEquals("http://h/api/sessions/a%2Fb", tx.lastRequest().url());
    }

    @Test
    void startHitsStartPath() {
        tx.respond(200, "{\"id\":\"s\",\"name\":\"n\",\"status\":\"initializing\"}");
        client.sessions.start("s");
        assertEquals("http://h/api/sessions/s/start", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
    }

    @Test
    void logoutHitsLogoutPath() {
        tx.respond(200, "{\"id\":\"s\",\"name\":\"n\",\"status\":\"disconnected\"}");
        client.sessions.logout("s");
        assertEquals("http://h/api/sessions/s/logout", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
    }

    @Test
    void requestPairingCodeSendsBody() {
        tx.respond(200, "{\"pairingCode\":\"ABCD1234\",\"status\":\"qr_ready\"}");
        client.sessions.requestPairingCode("s", RequestPairingCodeRequest.builder().phoneNumber("628123").build());
        assertEquals("http://h/api/sessions/s/pairing-code", tx.lastRequest().url());
        assertTrue(tx.lastRequest().body().contains("628123"));
    }

    @Test
    void statsHitsOverview() {
        tx.respond(200, "{\"total\":0,\"active\":0,\"ready\":0,\"disconnected\":0}");
        client.sessions.stats();
        assertEquals("http://h/api/sessions/stats/overview", tx.lastRequest().url());
    }

    @Test
    void setOnlinePresenceSendsPutWithFlag() {
        tx.respond(200, "{\"success\":true}");
        client.sessions.setOnlinePresence("s", SetOwnPresenceRequest.builder().available(false).build());
        // The account's own presence: no chat id in the path and no /subscribe suffix.
        assertEquals("http://h/api/sessions/s/presence", tx.lastRequest().url());
        assertEquals(HttpMethod.PUT, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("\"available\":false"));
    }

}
