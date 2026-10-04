package com.mywhatsapp.model;

/** Minimal success envelope returned by some state-changing endpoints. */
public record SuccessResult(boolean success, String message) {}
