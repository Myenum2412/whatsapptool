package com.mywhatsapp.resources;

import com.mywhatsapp.MyWhatsappClient;
import com.mywhatsapp.http.HttpMethod;
import com.mywhatsapp.model.HealthReadyResponse;
import com.mywhatsapp.model.HealthResponse;

/** Health resource — connectivity and readiness probes. */
public final class HealthResource {
    private final MyWhatsappClient client;

    public HealthResource(MyWhatsappClient client) {
        this.client = client;
    }

    /** General health (also returns the running version). */
    public HealthResponse check() {
        return client.request(HttpMethod.GET, "/api/health", null, null, HealthResponse.class);
    }

    /** Kubernetes liveness probe. */
    public HealthResponse live() {
        return client.request(HttpMethod.GET, "/api/health/live", null, null, HealthResponse.class);
    }

    /** Kubernetes readiness probe — checks both DB connections. */
    public HealthReadyResponse ready() {
        return client.request(HttpMethod.GET, "/api/health/ready", null, null, HealthReadyResponse.class);
    }
}
