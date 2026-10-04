package com.mywhatsapp.model;

/** Result of validating the configured API key. */
public record AuthValidateResponse(boolean valid, String role) {}
