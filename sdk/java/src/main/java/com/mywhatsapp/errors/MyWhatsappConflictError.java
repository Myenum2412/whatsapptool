package com.mywhatsapp.errors;

/** 409 Conflict — typically an engine-not-ready condition from the backend. */
public class MyWhatsappConflictError extends MyWhatsappApiError {
    public MyWhatsappConflictError(String message, int status, Object body, String errorKind) {
        super(message, status, body, errorKind);
    }
}
