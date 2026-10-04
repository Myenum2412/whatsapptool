package com.mywhatsapp.errors;

/** Base class for every error thrown by the SDK. */
public class MyWhatsappError extends RuntimeException {
    public MyWhatsappError(String message) {
        super(message);
    }
}
