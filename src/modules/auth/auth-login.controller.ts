import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from './decorators/auth.decorators';
import { LoginService } from './login.service';
import { LoginDto, LoginResponseDto } from './dto';
import { resolveClientIp } from '../../common/utils/ip';

/**
 * Email/password sign-in for the human dashboard — the one deliberate exception to the global
 * X-API-Key model: the ApiKeyGuard skips this route (@Public), and it trades credentials for
 * exactly one key. Rate-limited tighter than every global tier (5/min) because it is the one
 * credential brute-force surface in the system.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthLoginController {
  constructor(
    private readonly loginService: LoginService,
    private readonly configService: ConfigService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in with email and password, receiving a session API key',
    description:
      'Returns a freshly-issued API key carrying the account role. Each sign-in rotates the ' +
      "account's previous key, so earlier sessions are invalidated. Rate-limited to 5 attempts " +
      'per minute per client.',
  })
  @ApiResponse({ status: 200, type: LoginResponseDto })
  @ApiResponse({ status: 400, description: 'Validation failed (missing/malformed email or password)' })
  @ApiResponse({ status: 401, description: 'Invalid email or password' })
  @ApiResponse({ status: 429, description: 'Too many attempts — retry later' })
  async login(@Body() dto: LoginDto, @Req() request: Request): Promise<LoginResponseDto> {
    const trustedProxies = this.configService.get<string[]>('security.trustedProxies') ?? [];
    return this.loginService.login(dto, {
      ipAddress: resolveClientIp(request, trustedProxies),
      userAgent: request.get('user-agent'),
      method: request.method,
      path: request.path,
    });
  }
}
