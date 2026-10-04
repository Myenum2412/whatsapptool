package com.mywhatsapp.errors;

/** 404 Not Found. */
public class MyWhatsappNotFoundError extends MyWhatsappApiError {
    public MyWhatsappNotFoundError(String message, int status, Object body, String errorKind) {
        super(message, status, body, errorKind);
    }
}
