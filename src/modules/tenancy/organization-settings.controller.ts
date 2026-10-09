import { Body, Controller, Get, NotFoundException, Optional, Patch, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { UpdateOrganizationSettingsDto, OrganizationSettingsResponseDto } from './dto/organization-settings.dto';
import { TenancyService } from './tenancy.service';
import { toSettingsResponse } from './organization-settings';

@ApiTags('organizations')
@Controller('organizations')
// Deployment-global: neither route carries a `:sessionId`, so the guard's route-param session fence
// can never bite, which would admit a session-restricted key by default. Rejecting scoped keys at
// CLASS level also covers routes added here later.
@RequireUnscopedKey()
export class OrganizationSettingsController {
  constructor(
    private readonly tenancy: TenancyService,
    // Optional and last so it never shifts the positional constructor args of a direct-construction
    // test; the running app always provides the @Global AuditService.
    @Optional()
    private readonly audit?: AuditService,
  ) {}

  @Get('settings')
  @RequireRole(ApiKeyRole.ORG_MENU)
  @ApiOperation({
    summary: 'Read an organization’s policy settings',
    description:
      'Returns the keys this gateway knows how to interpret — currently only `quietHours`, which the ' +
      'send path enforces. Read fresh rather than through the send path’s cache, so the form hydrates ' +
      'with exactly what sends are enforcing.',
  })
  @ApiQuery({
    name: 'organizationId',
    required: false,
    type: String,
    description:
      'Organization to read. Ignored while `MULTITENANCY_ENABLED` is off, where every request resolves ' +
      'to the seeded default; with enforcement on, an id that does not exist is a 404 rather than a ' +
      'fallback, because billing an unknown tenant to the default is how one customer’s data ends up on ' +
      'another’s.',
  })
  @ApiResponse({
    status: 200,
    description: 'The organization’s policy settings',
    type: OrganizationSettingsResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({ status: 403, description: 'The key is not an admin key, or is session-scoped' })
  @ApiResponse({ status: 404, description: 'No organization with that id (multi-tenant enforcement on)' })
  async getSettings(@Query('organizationId') organizationId?: string): Promise<OrganizationSettingsResponseDto> {
    const target = await this.resolveTarget(organizationId);
    const settings = await this.tenancy.readOrganizationSettings(target);
    return toSettingsResponse(target, settings);
  }

  @Patch('settings')
  @RequireRole(ApiKeyRole.ORG_MENU)
  @ApiOperation({
    summary: 'Update an organization’s policy settings',
    description:
      'Merges: an absent key is left unchanged, and `quietHours` merges one level deep so ' +
      '`{enabled: false}` pauses a configured window instead of deleting it. The window is validated ' +
      'as a MERGED result, because a patch carrying only `start` is not a window on its own. Takes ' +
      'effect on the next send — the send path re-reads settings rather than compiling anything at boot.',
  })
  @ApiQuery({
    name: 'organizationId',
    required: false,
    type: String,
    description: 'Organization to update, resolved exactly as on read.',
  })
  @ApiResponse({ status: 200, description: 'The settings after the merge', type: OrganizationSettingsResponseDto })
  @ApiResponse({ status: 400, description: 'The merged window is unusable, with the offending field named' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({ status: 403, description: 'The key is not an admin key, or is session-scoped' })
  @ApiResponse({ status: 404, description: 'No organization with that id (multi-tenant enforcement on)' })
  async updateSettings(
    @Body() dto: UpdateOrganizationSettingsDto,
    @Query('organizationId') organizationId?: string,
  ): Promise<OrganizationSettingsResponseDto> {
    const target = await this.resolveTarget(organizationId);
    const settings = await this.tenancy.updateOrganizationSettings(target, dto);

    // Audited AFTER the write, and carrying the stored window rather than the patch: "what did this
    // request ask for" cannot answer "what policy is now in force", which is the question an audit of
    // a compliance control has to answer.
    await this.audit?.logInfo(AuditAction.ORGANIZATION_SETTINGS_UPDATED, {
      metadata: { organizationId: target, quietHours: settings['quietHours'] ?? null },
    });

    return toSettingsResponse(target, settings);
  }

  /**
   * Resolve which organization the request is about, and fail with 404 rather than 500 on a bad id.
   *
   * `TenancyService.resolveOrganizationId` throws a bare `Error` for an unknown organization, because
   * its other callers are background jobs where an exception is caught and logged rather than mapped
   * to a status. Here it is an HTTP response, so the message is translated at this boundary instead of
   * changing shared behaviour that send paths depend on.
   */
  private async resolveTarget(requestedOrganizationId?: string): Promise<string> {
    try {
      return await this.tenancy.resolveOrganizationId(requestedOrganizationId);
    } catch (error) {
      throw new NotFoundException(error instanceof Error ? error.message : 'Unknown organization');
    }
  }
}
