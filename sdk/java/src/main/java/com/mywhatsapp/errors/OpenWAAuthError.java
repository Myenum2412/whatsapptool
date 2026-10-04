package com.mywhatsapp.errors;

/** 401 Unauthorized — missing or invalid API key. */
public class MyWhatsappAuthError extends MyWhatsappApiError {
    public MyWhatsappAuthError(String message, int status, Object body, String errorKind) {
        super(message, status, body, errorKind);
    }
}
