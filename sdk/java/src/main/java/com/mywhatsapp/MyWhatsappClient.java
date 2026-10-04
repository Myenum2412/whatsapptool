package com.mywhatsapp;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonParseException;
import com.mywhatsapp.errors.MyWhatsappApiError;
import com.mywhatsapp.errors.MyWhatsappError;
import com.mywhatsapp.http.BinaryResponse;
import com.mywhatsapp.http.DefaultHttpTransport;
import com.mywhatsapp.http.Http;
import com.mywhatsapp.http.HttpMethod;
import com.mywhatsapp.model.MuteChatRequest;
import com.mywhatsapp.model.UpdateSessionConfigRequest;
import com.mywhatsapp.model.UpdateSessionConfigRequestSerializer;
import com.mywhatsapp.model.UpdateSessionProxyRequest;
import com.mywhatsapp.http.HttpRequestData;
import com.mywhatsapp.http.HttpResponseData;
import com.mywhatsapp.http.HttpTransport;
import com.mywhatsapp.model.AuthValidateResponse;
import com.mywhatsapp.resources.CallsResource;
import com.mywhatsapp.resources.MediaResource;
import com.mywhatsapp.resources.CatalogResource;
import com.mywhatsapp.resources.ChannelsResource;
import com.mywhatsapp.resources.ChatsResource;
import com.mywhatsapp.resources.ContactsResource;
import com.mywhatsapp.resources.GroupsResource;
import com.mywhatsapp.resources.HealthResource;
import com.mywhatsapp.resources.LabelsResource;
import com.mywhatsapp.resources.MessagesResource;
import com.mywhatsapp.resources.ProfileResource;
import com.mywhatsapp.resources.SearchResource;
import com.mywhatsapp.resources.SessionsResource;
import com.mywhatsapp.resources.StatusResource;
import com.mywhatsapp.resources.TemplatesResource;
import com.mywhatsapp.resources.WebhooksResource;
import java.io.IOException;
import java.lang.reflect.Array;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * The single entry point to the MyWhatsapp SDK. Holds configuration and exposes
 * domain resources as fields:
 *
 * <pre>{@code
 * MyWhatsappClient client = new MyWhatsappClient("http://localhost:2785", "owa_k1_…");
 * client.sessions.start("my-session");
 * client.messages.sendText("my-session",
 *     SendTextRequest.builder().chatId("628123456789@c.us").text("Hello!").build());
 * }</pre>
 */
public final class MyWhatsappClient {
    private final Gson gson = new Gson();

    // Used for the two body types listed in bodySerializer(), never the shared default. Emitting an
    // explicit null needs two things that pull in opposite directions: a serializer that decides
    // WHICH keys appear, and serializeNulls() so the ones it chose survive the writer — Gson drops
    // JsonNull members otherwise, even from a JsonObject the serializer already built. Applying
    // serializeNulls() to the shared instance instead would turn every unset field of every other
    // body into an explicit null, which the session-config route reads as "reset to default": a far
    // worse bug than the one it fixes.
    private final Gson nullEmittingGson = new GsonBuilder()
            .serializeNulls()
            .registerTypeAdapter(UpdateSessionConfigRequest.class, new UpdateSessionConfigRequestSerializer())
            .create();
    private final ClientConfig config;
    private final HttpTransport transport;

    // ── Resources ──────────────────────────────────────────────────────
    public final SessionsResource sessions = new SessionsResource(this);
    public final MessagesResource messages = new MessagesResource(this);
    public final SearchResource search = new SearchResource(this);
    public final ContactsResource contacts = new ContactsResource(this);
    public final GroupsResource groups = new GroupsResource(this);
    public final WebhooksResource webhooks = new WebhooksResource(this);
    public final ChatsResource chats = new ChatsResource(this);
    public final LabelsResource labels = new LabelsResource(this);
    public final ChannelsResource channels = new ChannelsResource(this);
    public final CatalogResource catalog = new CatalogResource(this);
    public final StatusResource status = new StatusResource(this);
    public final TemplatesResource templates = new TemplatesResource(this);
    public final HealthResource health = new HealthResource(this);
    public final ProfileResource profile = new ProfileResource(this);
    public final CallsResource calls = new CallsResource(this);
    public final MediaResource media = new MediaResource(this);

    public MyWhatsappClient(ClientConfig config) {
        // ClientConfig's constructor validates baseUrl/apiKey/timeout, so config is already sound here.
        this.config = config;
        this.transport = config.transport != null ? config.transport : new DefaultHttpTransport();
    }

    public MyWhatsappClient(String baseUrl, String apiKey) {
        this(ClientConfig.builder().baseUrl(baseUrl).apiKey(apiKey).build());
    }

    /** Validate the configured API key and resolve its role. */
    public AuthValidateResponse auth() {
        return request(HttpMethod.POST, "/api/auth/validate", null, null, AuthValidateResponse.class);
    }

    // ── Internal request API used by all resources ─────────────────────

    /**
     * Issue a request and deserialize a single object (or {@code null} for 204/empty).
     *
     * <p>A {@code String} target receives a non-JSON 2xx body as raw text — the same
     * fallback the JS/Python/PHP transports apply. For any other target the body must
     * be JSON; a non-JSON body surfaces as a tidy {@link MyWhatsappError}, never a raw
     * Gson exception.
     */
    @SuppressWarnings("unchecked")
    public <T> T request(HttpMethod method, String path, Object query, Object body, Class<T> type) {
        HttpResponseData res = execute(method, path, query, body);
        String text = utf8(res.body());
        if (res.status() == 204 || text.isEmpty()) {
            return null;
        }
        if (type == String.class) {
            // A String target mirrors the JS/Python/PHP raw-text fallback: decode a
            // JSON string body, accept a non-JSON 2xx body as the raw text.
            try {
                T parsed = gson.fromJson(text, type);
                if (parsed != null) {
                    return parsed;
                }
            } catch (JsonParseException ignore) {
                // fall through to the raw text
            }
            return (T) text;
        }
        try {
            return gson.fromJson(text, type);
        } catch (JsonParseException e) {
            throw new MyWhatsappError("Non-JSON response — " + method + " " + path);
        }
    }

    /** Issue a request and deserialize a JSON array into a {@code List} (empty for 204/empty). */
    @SuppressWarnings("unchecked")
    public <T> List<T> requestList(HttpMethod method, String path, Object query, Object body, Class<T> elementType) {
        HttpResponseData res = execute(method, path, query, body);
        String text = utf8(res.body());
        if (res.status() == 204 || text.isEmpty()) {
            return List.of();
        }
        Class<T[]> arrayType = (Class<T[]>) Array.newInstance(elementType, 0).getClass();
        try {
            T[] arr = gson.fromJson(text, arrayType);
            return arr == null ? List.of() : List.of(arr);
        } catch (JsonParseException e) {
            throw new MyWhatsappError("Non-JSON response — " + method + " " + path);
        }
    }

    /** Issue a request that returns no body. */
    public void requestVoid(HttpMethod method, String path, Object query, Object body) {
        execute(method, path, query, body);
    }

    /**
     * Issue a request for a non-JSON (binary) 2xx body — e.g. stored status media —
     * and return the raw bytes plus the served Content-Type. A 204/empty body yields
     * empty data and a {@code null} content type.
     */
    public BinaryResponse requestBytes(HttpMethod method, String path, Object query) {
        HttpResponseData res = execute(method, path, query, null);
        if (res.status() == 204 || res.body() == null || res.body().length == 0) {
            return new BinaryResponse(new byte[0], null);
        }
        String contentType = null;
        for (Map.Entry<String, List<String>> e : res.headers().entrySet()) {
            if ("content-type".equalsIgnoreCase(e.getKey()) && !e.getValue().isEmpty()) {
                contentType = e.getValue().get(0);
                break;
            }
        }
        return new BinaryResponse(res.body(), contentType);
    }

    private static String utf8(byte[] body) {
        return body == null ? "" : new String(body, StandardCharsets.UTF_8);
    }

    /**
     * The bodies that must be able to emit an explicit null.
     *
     * Gson drops null members by default, so for these two a null field would leave the request
     * without the key at all — which is not a weaker version of the request, it is a different one.
     * {@link MuteChatRequest} is safe to route here despite the warning on {@code nullEmittingGson}
     * because both of its fields are required: it has no optional field that an explicit null could
     * turn into an unintended "reset to default".
     */
    private Gson bodySerializer(Object body) {
        return body instanceof UpdateSessionConfigRequest
                        || body instanceof MuteChatRequest
                        || body instanceof UpdateSessionProxyRequest
                ? nullEmittingGson
                : gson;
    }

    private HttpResponseData execute(HttpMethod method, String path, Object query, Object body) {
        String url = Http.buildUrl(config.baseUrl, path, query, gson);
        Map<String, String> headers = Http.mergeHeaders(config.defaultHeaders, null, config.apiKey);
        String bodyJson = body != null ? bodySerializer(body).toJson(body) : null;
        HttpRequestData reqData = new HttpRequestData(method, url, headers, bodyJson, config.timeout);
        HttpResponseData res;
        try {
            // A timeout surfaces as MyWhatsappTimeoutError (unchecked) and propagates.
            res = transport.send(reqData);
        } catch (IOException e) {
            throw new MyWhatsappError("Transport error — " + method + " " + path + ": " + e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new MyWhatsappError("Transport interrupted — " + method + " " + path);
        } catch (IllegalArgumentException e) {
            // e.g. a JDK-restricted header name in defaultHeaders, or a URI-illegal char — keep it
            // inside the MyWhatsappError contract instead of leaking a raw JDK exception to the caller.
            throw new MyWhatsappError("Invalid request — " + method + " " + path + ": " + e.getMessage());
        }
        if (res.status() < 200 || res.status() >= 300) {
            throw MyWhatsappApiError.fromResponse(res.status(), "", utf8(res.body()), method + " " + path);
        }
        return res;
    }
}
