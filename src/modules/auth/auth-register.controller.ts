import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { LoginService } from './login.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { RegisterDto, UserResponseDto } from './dto';
import { toUserResponse } from './user-response';
import { Public } from './decorators/auth.decorators';
import { resolveClientIp } from '../../common/utils/ip';

/**
 * Public self-signup — the second deliberate exception to the global X-API-Key model (alongside
 * `POST /api/auth/login`): anyone can create an email/password account, always at the `users` tier.
 * No `role` field exists on the body, so nothing a client sends can mint `orgmenu`; that tier is
 * provisioned by an existing administrator or the bootstrap seed. Rate-limited like login (5/min)
 * because a reachable open account-creating route is itself a brute-force surface.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthRegisterController {
  constructor(
    private readonly loginService: LoginService,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a dashboard account by self-signup',
    description:
      'Creates a least-privilege (`users`) email/password account that can then sign in through ' +
      '`POST /api/auth/login`. There is no `role` field: a self-registered account is never ' +
      'granted `orgmenu` — that tier is provisioned by an administrator or the bootstrap seed. ' +
      'Rate-limited to 5 attempts per minute per client.',
  })
  @ApiResponse({ status: 201, description: 'Account created.', type: UserResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Validation failed (missing/malformed email, short password, or a non-whitelisted body field)',
  })
  @ApiResponse({ status: 409, description: 'An account with that email already exists' })
  @ApiResponse({ status: 429, description: 'Too many attempts — retry later' })
  async register(@Body() dto: RegisterDto, @Req() request: Request): Promise<UserResponseDto> {
    const user = await this.loginService.registerUser(dto);
    await this.auditService.logInfo(AuditAction.USER_CREATED, {
      ipAddress: resolveClientIp(request, this.configService.get<string[]>('security.trustedProxies') ?? []),
      userAgent: request.get('user-agent'),
      method: request.method,
      path: request.path,
      metadata: { source: 'self-signup', targetUserId: user.id, email: user.email, role: user.role },
    });
    return toUserResponse(user);
  }
}
