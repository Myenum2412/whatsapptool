package com.mywhatsapp.errors;

/** 501 Not Implemented — the active engine does not support this operation. */
public class MyWhatsappNotImplementedError extends MyWhatsappApiError {
    public MyWhatsappNotImplementedError(String message, int status, Object body, String errorKind) {
        super(message, status, body, errorKind);
    }
}
