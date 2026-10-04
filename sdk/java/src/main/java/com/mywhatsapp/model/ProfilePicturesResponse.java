package com.mywhatsapp.model;

import java.util.Map;

/** Batch profile-picture lookup: a map of contact id → picture URL (null when the lookup failed). */
public record ProfilePicturesResponse(Map<String, String> pictures) {}
