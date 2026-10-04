package com.mywhatsapp.resources;

import static com.mywhatsapp.http.Http.encodeSegment;

import com.mywhatsapp.MyWhatsappClient;
import com.mywhatsapp.http.HttpMethod;
import com.mywhatsapp.model.CreateSessionRequest;
import com.mywhatsapp.model.ListSessionsQuery;
import com.mywhatsapp.model.PairingCodeResponse;
import com.mywhatsapp.model.QrCodeResponse;
import com.mywhatsapp.model.RequestPairingCodeRequest;
import com.mywhatsapp.model.SessionConfig;
import com.mywhatsapp.model.SessionProxy;
import com.mywhatsapp.model.SessionResponse;
import com.mywhatsapp.model.SessionStatsOverview;
import com.mywhatsapp.model.SetOwnPresenceRequest;
import com.mywhatsapp.model.SuccessResult;
import com.mywhatsapp.model.UpdateSessionConfigRequest;
import com.mywhatsapp.model.UpdateSessionProxyRequest;
import java.util.List;

/** Sessions resource — lifecycle management for WhatsApp sessions. */
public final class SessionsResource {
    private final MyWhatsappClient client;

    public SessionsResource(MyWhatsappClient client) {
        this.client = client;
    }

    /** List all sessions (scoped to the API key's allowed sessions). */
    public List<SessionResponse> list() {
        return list(null);
    }

    /** List sessions, applying the given pagination query. */
    public List<SessionResponse> list(ListSessionsQuery query) {
        return client.requestList(HttpMethod.GET, "/api/sessions", query, null, SessionResponse.class);
    }

    /** Read a session's effective configuration. */
    public SessionConfig getConfig(String id) {
        return client.request(
                HttpMethod.GET, "/api/sessions/" + encodeSegment(id) + "/config", null, null, SessionConfig.class);
    }

    /**
     * Update a RUNNING session's configuration. Takes effect without re-linking the account — all
     * three fields were fixed at creation before this route existed.
     */
    public SessionConfig updateConfig(String id, UpdateSessionConfigRequest body) {
        return client.request(
                HttpMethod.PATCH, "/api/sessions/" + encodeSegment(id) + "/config", null, body, SessionConfig.class);
    }

    /** Read a session's masked proxy configuration (credentials never returned). */
    public SessionProxy getProxy(String id) {
        return client.request(
                HttpMethod.GET, "/api/sessions/" + encodeSegment(id) + "/proxy", null, null, SessionProxy.class);
    }

    /**
     * Update per-session proxy settings. No restart is performed — changes apply on the next start.
     * Send {@code proxyUrl: null} to clear the proxy. Requires an OPERATOR-level key.
     */
    public SessionProxy updateProxy(String id, UpdateSessionProxyRequest body) {
        return client.request(
                HttpMethod.PATCH, "/api/sessions/" + encodeSegment(id) + "/proxy", null, body, SessionProxy.class);
    }

    /** Get a single session by id. */
    public SessionResponse get(String id) {
        return client.request(HttpMethod.GET, "/api/sessions/" + encodeSegment(id), null, null, SessionResponse.class);
    }

    /** Create a new session. Requires an OPERATOR-level key. */
    public SessionResponse create(CreateSessionRequest body) {
        return client.request(HttpMethod.POST, "/api/sessions", null, body, SessionResponse.class);
    }

    /** Delete a session. Requires an OPERATOR-level key. */
    public void delete(String id) {
        client.requestVoid(HttpMethod.DELETE, "/api/sessions/" + encodeSegment(id), null, null);
    }

    /** Start a session and initialize the WhatsApp connection. */
    public SessionResponse start(String id) {
        return client.request(HttpMethod.POST, "/api/sessions/" + encodeSegment(id) + "/start", null, null, SessionResponse.class);
    }

    /**
     * Stop a session and disconnect gracefully. Throws on HTTP {@code 502} with
     * {@code code: 'SESSION_STOP_INCOMPLETE'} when the session was stopped locally but the engine
     * teardown did not complete (the graceful disconnect and the force-destroy escalation both
     * failed, so the engine process may still be running); the status is settled to
     * {@code disconnected} and no success audit is written. Retry the stop; restart the node to
     * reap a leaked process.
     */
    public SessionResponse stop(String id) {
        return client.request(HttpMethod.POST, "/api/sessions/" + encodeSegment(id) + "/stop", null, null, SessionResponse.class);
    }

    /**
     * Attempt an engine-native unlink of this device, then stop the session. A {@code 200} means the
     * unlink operation AND the required local credential cleanup completed — it is not an
     * independent observation that the handset UI no longer shows the linked device. Because a
     * completed unlink wipes the stored credentials, a later {@code start} requires a fresh QR scan
     * or pairing code. Requires a running session. Throws on HTTP {@code 502} with
     * {@code code: 'SESSION_LOGOUT_INCOMPLETE'} when the session was stopped locally but the logout
     * operation did not complete (no send, no acknowledgement, timeout/transport error, or local
     * cleanup failure); {@code phone} is cleared and no success audit is written. Start the session
     * again and retry the logout; do not assume the retry reconnects automatically or lands in a
     * guaranteed QR state.
     */
    public SessionResponse logout(String id) {
        return client.request(HttpMethod.POST, "/api/sessions/" + encodeSegment(id) + "/logout", null, null, SessionResponse.class);
    }

    /** Force-kill a stuck session (SIGKILL + teardown). */
    public SessionResponse forceKill(String id) {
        return client.request(HttpMethod.POST, "/api/sessions/" + encodeSegment(id) + "/force-kill", null, null, SessionResponse.class);
    }

    /** Get the current QR code for authentication (live from the engine, not the DB). */
    public QrCodeResponse getQrCode(String id) {
        return client.request(HttpMethod.GET, "/api/sessions/" + encodeSegment(id) + "/qr", null, null, QrCodeResponse.class);
    }

    /** Request an 8-character pairing code for phone-based login. */
    public PairingCodeResponse requestPairingCode(String id, RequestPairingCodeRequest body) {
        return client.request(HttpMethod.POST, "/api/sessions/" + encodeSegment(id) + "/pairing-code", null, body, PairingCodeResponse.class);
    }

    /** Aggregate statistics across the API key's sessions. */
    public SessionStatsOverview stats() {
        return client.request(HttpMethod.GET, "/api/sessions/stats/overview", null, null, SessionStatsOverview.class);
    }

    /**
     * Set the account's own global presence — appear online, or offline.
     *
     * <p>{@code available: false} hands notifications back to the phone: a linked device that stays
     * online suppresses the phone's own alerts. This is the ACCOUNT's presence, not a chat's — see
     * {@code ChatsResource.sendState} for per-chat typing/recording states.
     */
    public SuccessResult setOnlinePresence(String id, SetOwnPresenceRequest body) {
        return client.request(HttpMethod.PUT, "/api/sessions/" + encodeSegment(id) + "/presence", null, body, SuccessResult.class);
    }

}
