package com.mywhatsapp.errors;

/** Thrown when a request exceeds the configured timeout. */
public class MyWhatsappTimeoutError extends MyWhatsappError {
    public MyWhatsappTimeoutError(long timeoutMs) {
        super("Request timed out after " + timeoutMs + "ms");
    }
}
