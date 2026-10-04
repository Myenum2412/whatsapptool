package com.mywhatsapp.resources;

import static com.mywhatsapp.http.Http.encodeSegment;

import com.mywhatsapp.MyWhatsappClient;
import com.mywhatsapp.http.HttpMethod;
import com.mywhatsapp.model.SuccessResult;
import com.mywhatsapp.model.CallLinkResponse;
import com.mywhatsapp.model.CreateCallLinkRequest;

/** Calls resource — incoming call handling. */
public final class CallsResource {
    private final MyWhatsappClient client;

    public CallsResource(MyWhatsappClient client) {
        this.client = client;
    }

    /**
     * Reject a ringing incoming call. Baileys only; whatsapp-web.js answers {@code 501}. The
     * {@code callId} comes from a {@code call.received} webhook event; 404 when the call is not
     * found or no longer ringing.
     */
    public SuccessResult rejectCall(String sessionId, String callId) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/"
                + encodeSegment(sessionId)
                + "/calls/"
                + encodeSegment(callId)
                + "/reject",
            null,
            null,
            SuccessResult.class);
    }
    /**
     * Create a shareable WhatsApp call link.
     *
     * <p>Both fields are required. {@code startTime} is absolute epoch MILLISECONDS — a link for
     * right now is the current timestamp rather than an omitted field, because whatsapp-web.js
     * generates an event-linked call and has no notion of "no start time". A WhatsApp-side failure
     * answers {@code 403} rather than a success carrying an empty link.
     */
    public CallLinkResponse createLink(String sessionId, CreateCallLinkRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/calls/link",
            null,
            body,
            CallLinkResponse.class);
    }

}
