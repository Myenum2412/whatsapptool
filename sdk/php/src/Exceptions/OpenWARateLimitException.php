<?php

declare(strict_types=1);

namespace MyWhatsapp\Exceptions;

/** 429 Too Many Requests — rate limited. */
class MyWhatsappRateLimitException extends MyWhatsappApiException
{
}
