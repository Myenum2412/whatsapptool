package com.mywhatsapp.model;

/** Returned by every send operation. {@code timestamp} is a Unix timestamp in seconds. */
public record MessageResponse(String messageId, long timestamp) {}
