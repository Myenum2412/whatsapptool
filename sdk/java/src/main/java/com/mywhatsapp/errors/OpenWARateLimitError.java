package com.mywhatsapp.errors;

/** 429 Too Many Requests — rate limited. */
public class MyWhatsappRateLimitError extends MyWhatsappApiError {
    public MyWhatsappRateLimitError(String message, int status, Object body, String errorKind) {
        super(message, status, body, errorKind);
    }
}
