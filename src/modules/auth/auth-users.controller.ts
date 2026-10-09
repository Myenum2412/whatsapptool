import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { LoginService } from './login.service';
import { CreateUserDto, UpdateUserDto, UserResponseDto } from './dto';
import { toUserResponse } from './user-response';
import { CurrentApiKey, RequireRole, RequireUnscopedKey } from './decorators/auth.decorators';
import { type ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';

/**
 * Orgmenu-only dashboard-account provisioning. A session-restricted orgmenu key could otherwise
 * mint an account whose login key is unrestricted and escape its confinement, so the whole surface
 * is @RequireUnscopedKey on top of the ORG_MENU role requirement. It is also closed to
 * chat-restricted keys by the global chat fence (no @ChatScoped mark here).
 */
@ApiTags('auth')
@Controller('auth/users')
@RequireUnscopedKey()
@RequireRole(ApiKeyRole.ORG_MENU)
export class AuthUsersController {
  constructor(
    private readonly loginService: LoginService,
    private readonly auditService: AuditService,
  ) {}

  private auditContext(
    req: Request,
    actor?: ApiKey,
  ): { apiKey?: ApiKey; ipAddress?: string; method?: string; path?: string } {
    return {
      apiKey: actor,
      ipAddress: (req as Request & { clientIp?: string }).clientIp ?? undefined,
      method: req.method,
      path: req.path,
    };
  }

  @Get()
  @ApiOperation({ summary: 'List dashboard accounts (orgmenu only)' })
  @ApiResponse({ status: 200, description: 'All accounts, ordered by creation.', type: [UserResponseDto] })
  async list(): Promise<UserResponseDto[]> {
    const users = await this.loginService.listUsers();
    return users.map(toUserResponse);
  }

  @Post()
  @ApiOperation({ summary: 'Create a dashboard account (orgmenu only)' })
  @ApiResponse({ status: 201, description: 'Account created.', type: UserResponseDto })
  @ApiResponse({ status: 409, description: 'An account with that email already exists.' })
  async create(
    @Body() dto: CreateUserDto,
    @Req() req: Request,
    @CurrentApiKey() actor?: ApiKey,
  ): Promise<UserResponseDto> {
    const user = await this.loginService.createUser(dto);
    await this.auditService.logInfo(AuditAction.USER_CREATED, {
      ...this.auditContext(req, actor),
      metadata: { targetUserId: user.id, email: user.email, role: user.role },
    });
    return toUserResponse(user);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a dashboard account (orgmenu only)' })
  @ApiResponse({ status: 200, description: 'Account updated.', type: UserResponseDto })
  @ApiResponse({ status: 404, description: 'No account with that id.' })
  @ApiResponse({ status: 409, description: 'The change would remove the last active orgmenu account.' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @Req() req: Request,
    @CurrentApiKey() actor?: ApiKey,
  ): Promise<UserResponseDto> {
    const before = await this.loginService.findUserForAudit(id);
    const user = await this.loginService.updateUser(id, dto);
    await this.auditService.logInfo(AuditAction.USER_UPDATED, {
      ...this.auditContext(req, actor),
      metadata: {
        targetUserId: id,
        email: user.email,
        before: { role: before?.role, isActive: before?.isActive, name: before?.name },
        after: { role: user.role, isActive: user.isActive, name: user.name },
      },
    });
    return toUserResponse(user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a dashboard account (orgmenu only)' })
  @ApiResponse({ status: 204, description: 'Account deleted.' })
  @ApiResponse({ status: 404, description: 'No account with that id.' })
  @ApiResponse({
    status: 409,
    description: 'The account is the last active orgmenu, or the one you are signed in with.',
  })
  async remove(@Param('id') id: string, @Req() req: Request, @CurrentApiKey() actor?: ApiKey): Promise<void> {
    const target = await this.loginService.findUserForAudit(id);
    await this.loginService.deleteUser(id, actor?.name);
    await this.auditService.logInfo(AuditAction.USER_DELETED, {
      ...this.auditContext(req, actor),
      metadata: { targetUserId: id, email: target?.email },
    });
  }
}
