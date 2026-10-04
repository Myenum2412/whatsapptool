package com.mywhatsapp.errors;

/** 403 Forbidden — the API key's role is insufficient for this endpoint. */
public class MyWhatsappForbiddenError extends MyWhatsappApiError {
    public MyWhatsappForbiddenError(String message, int status, Object body, String errorKind) {
        super(message, status, body, errorKind);
    }
}
