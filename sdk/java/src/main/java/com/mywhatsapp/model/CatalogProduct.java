package com.mywhatsapp.model;

/** A single catalog product. Optional fields are {@code null} when absent. */
public record CatalogProduct(
    String id,
    String name,
    String description,
    double price,
    String currency,
    String priceFormatted,
    String imageUrl,
    String url,
    boolean isAvailable,
    String retailerId) {}
