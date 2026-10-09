import { ConflictException, Injectable, NotFoundException, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { User, UserRole } from '../tenancy/entities/user.entity';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { hashApiKey } from './api-key-hash';
import { hashPassword, verifyPassword } from './password-hash';
import { CreateUserDto, LoginDto, LoginResponseDto, RegisterDto, UpdateUserDto } from './dto';
import { writeSecretFile } from '../../common/utils/secret-file';
import { createLogger } from '../../common/services/logger.service';

/** Per-request facts recorded with the login audit rows. Framework-agnostic on purpose. */
export interface LoginRequestContext {
  ipAddress?: string;
  userAgent?: string;
  method?: string;
  path?: string;
}

/** The key row a sign-in owns: one per account, named `user:<email>` (see issueLoginKey). */
export const loginKeyName = (email: string): string => `user:${email}`;

/** Where a generated bootstrap password is written, owner-only (0600). Overridable like BOOTSTRAP_KEY_FILE. */
export function adminCredentialsFilePath(): string {
  return process.env.BOOTSTRAP_ADMIN_FILE || join(process.cwd(), 'data', '.admin-credentials');
}

/** A URL-safe 192-bit password — the first-boot admin's credential when none was configured. */
export function generateBootstrapPassword(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Email-signin authentication: verifies a password against `users.passwordHash` and hands back an
 * X-API-Key credential for the existing guard/WS machinery — no parallel session system.
 *
 * Every login rotates the account's own key row (`user:<email>`): the raw key exists only in this
 * response, so rotation doubles as logout-everywhere-else, and a duplicate row left by a
 * double-click race is removed rather than left to shadow the live one.
 *
 * First boot seeds `BOOTSTRAP_ADMIN_EMAIL` (default `admin@localhost`) with
 * `BOOTSTRAP_ADMIN_PASSWORD`, or a generated password written to `data/.admin-credentials`.
 */
@Injectable()
export class LoginService implements OnModuleInit {
  private readonly logger = createLogger('LoginService');

  constructor(
    @InjectRepository(User, 'main')
    private readonly userRepository: Repository<User>,
    @InjectRepository(ApiKey, 'main')
    private readonly apiKeyRepository: Repository<ApiKey>,
    private readonly auditService: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.seedAdminIfEmpty();
    } catch (error) {
      this.logger.warn(`Bootstrap admin seeding failed: ${String(error)}`);
    }
  }

  private async seedAdminIfEmpty(): Promise<void> {
    if ((await this.userRepository.count()) > 0) return;

    const email = (process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@localhost').trim().toLowerCase();
    const configured = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    const password = configured || generateBootstrapPassword();
    const generated = !configured;

    await this.userRepository.save(
      this.userRepository.create({
        email,
        name: 'Administrator',
        passwordHash: await hashPassword(password),
        role: UserRole.ORG_MENU,
        isActive: true,
      }),
    );

    if (generated) {
      const file = adminCredentialsFilePath();
      writeSecretFile(file, `email=${email}\npassword=${password}\n`);
      this.logger.log(`Seeded bootstrap admin ${email}; generated password written to ${file}`);
    } else {
      this.logger.log(`Seeded bootstrap admin ${email} from BOOTSTRAP_ADMIN_PASSWORD`);
    }
  }

  /**
   * Verify credentials and issue the session key. Throws 401 with one message for every failure
   * mode (unknown email, wrong password, disabled account) so the response cannot be used to
   * discover which accounts exist; the audit row records the real reason.
   */
  async login(dto: LoginDto, context: LoginRequestContext = {}): Promise<LoginResponseDto> {
    const email = dto.email.trim().toLowerCase();
    const user = await this.userRepository.findOne({ where: { email } });
    const passwordOk = await verifyPassword(dto.password, user?.passwordHash ?? null);

    if (!user || !passwordOk || !user.isActive) {
      const reason = !user ? 'unknown_email' : !passwordOk ? 'invalid_password' : 'inactive_account';
      await this.auditService.logWarn(AuditAction.AUTH_LOGIN_FAILED, {
        ...context,
        metadata: { email, reason },
      });
      throw new UnauthorizedException('Invalid email or password');
    }

    const { rawKey } = await this.issueLoginKey(user);
    await this.userRepository.update(user.id, { lastLoginAt: new Date() });
    await this.auditService.logInfo(AuditAction.AUTH_LOGIN_SUCCEEDED, {
      ...context,
      metadata: { userId: user.id, email: user.email, role: user.role },
    });

    return {
      apiKey: rawKey,
      role: user.role,
      user: { id: user.id, email: user.email, name: user.name },
    };
  }

  // ── Account provisioning (orgmenu-only surface: POST/GET/PATCH/DELETE /api/auth/users) ──────

  async listUsers(): Promise<User[]> {
    return this.userRepository.find({ order: { createdAt: 'ASC' } });
  }

  /** Raw read used only to snapshot a target before/after an update/delete for the audit trail. */
  async findUserForAudit(id: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { id } });
  }

  /** Create an email/password account. Email is normalized (trim+lowercase) in the DTO, so the
   *  uniqueness pre-check below and the DB index agree with sign-in's lookup normalization. */
  async createUser(dto: CreateUserDto): Promise<User> {
    const existing = await this.userRepository.findOne({ where: { email: dto.email } });
    if (existing) throw new ConflictException(`An account already exists for ${dto.email}`);
    return this.persistAccount(dto.email, dto.password, dto.role ?? UserRole.USER, dto.name);
  }

  /**
   * Self-signup: an open, @Public route that always creates a least-privilege `users` account.
   * Unlike an administrator's create, the role is FIXED here — `RegisterDto` has no role field, so
   * nothing a client sends can ever mint an `orgmenu` tier. Duplicate emails are the same 409.
   */
  async registerUser(dto: RegisterDto): Promise<User> {
    const existing = await this.userRepository.findOne({ where: { email: dto.email } });
    if (existing) throw new ConflictException(`An account already exists for ${dto.email}`);
    return this.persistAccount(dto.email, dto.password, UserRole.USER, dto.name);
  }

  private async persistAccount(email: string, password: string, role: UserRole, name?: string): Promise<User> {
    return this.userRepository.save(
      this.userRepository.create({
        email,
        name: name?.trim() || email.split('@')[0],
        passwordHash: await hashPassword(password),
        role,
        isActive: true,
      }),
    );
  }

  /** Update an account. Guarded by the last-active-orgmenu invariant (mirrors the API-key one),
   *  and disabling an account — or rotating its password — revokes its `user:<email>` session keys
   *  so an already-issued credential cannot outlive the change. */
  async updateUser(id: string, dto: UpdateUserDto): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    if (dto.role !== undefined || dto.isActive !== undefined) {
      const nextRole = dto.role ?? user.role;
      const nextActive = dto.isActive ?? user.isActive;
      const keepsOrgMenuPower = nextRole === UserRole.ORG_MENU && nextActive;
      if (!keepsOrgMenuPower && user.role === UserRole.ORG_MENU && user.isActive) {
        const orgmenuCount = await this.userRepository.count({
          where: { role: UserRole.ORG_MENU, isActive: true },
        });
        if (orgmenuCount <= 1) {
          throw new ConflictException('Cannot demote or disable the last active orgmenu account');
        }
      }
      if (dto.isActive === false) await this.revokeLoginKeys(user.email);
    }

    const patch: Partial<User> = {};
    if (dto.name !== undefined) patch.name = dto.name.trim();
    if (dto.role !== undefined) patch.role = dto.role;
    if (dto.isActive !== undefined) patch.isActive = dto.isActive;
    if (dto.password !== undefined) {
      // Rotate the stored hash AND revoke live session keys: a password change is usually exactly
      // when already-issued credentials must stop working. The next login re-mints the row.
      patch.passwordHash = await hashPassword(dto.password);
      await this.revokeLoginKeys(user.email);
    }
    if (Object.keys(patch).length > 0) await this.userRepository.update(user.id, patch);

    const reloaded = await this.userRepository.findOne({ where: { id } });
    if (!reloaded) throw new NotFoundException('User not found');
    return reloaded;
  }

  /** Delete an account and its `user:<email>` session keys. The account you are signed in with can
   *  never be deleted, and neither can the last active orgmenu — a deployment must not be able to
   *  lock itself out of the user-management surface. */
  async deleteUser(id: string, actorKeyName?: string): Promise<void> {
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    if (actorKeyName === loginKeyName(user.email)) {
      throw new ConflictException('Cannot delete the account you are signed in with');
    }
    if (user.role === UserRole.ORG_MENU && user.isActive) {
      const orgmenuCount = await this.userRepository.count({
        where: { role: UserRole.ORG_MENU, isActive: true },
      });
      if (orgmenuCount <= 1) throw new ConflictException('Cannot delete the last active orgmenu account');
    }

    await this.revokeLoginKeys(user.email);
    await this.userRepository.remove(user);
  }

  private async revokeLoginKeys(email: string): Promise<void> {
    const keys = await this.apiKeyRepository.find({ where: { name: loginKeyName(email) } });
    if (keys.length === 0) return;
    for (const key of keys) {
      key.isActive = false;
      await this.apiKeyRepository.save(key);
    }
  }

  /**
   * Create or rotate the account's key row. The role always mirrors `users.role` (the source of
   * truth), and the row is re-activated so login cannot hand back a dead credential — account
   * lockout is `users.isActive`, not a key flag. Scope fields an operator curated on this row are
   * left alone: they narrow access, and this increment has no surface that manages them.
   */
  private async issueLoginKey(user: User): Promise<{ apiKey: ApiKey; rawKey: string }> {
    const name = loginKeyName(user.email);
    const rawKey = `owa_k1_${randomBytes(32).toString('hex')}`;
    const keyHash = hashApiKey(rawKey, process.env.API_KEY_PEPPER);
    const keyPrefix = rawKey.substring(0, 12);

    const existing = await this.apiKeyRepository.find({ where: { name }, order: { createdAt: 'DESC' } });

    const [current, ...duplicates] = existing;
    if (current) {
      const rotated = await this.apiKeyRepository.save({
        ...current,
        keyHash,
        keyPrefix,
        // UserRole and ApiKeyRole are the same two string values — the mirror is explicit.
        role: user.role as unknown as ApiKeyRole,
        // The key belongs to this account: ownership is what gates the account's sessions, so a
        // rotation must never lose it (even across the duplicate-removal branch below).
        ownerUserId: user.id,
        isActive: true,
        expiresAt: null,
      });
      if (duplicates.length > 0) await this.apiKeyRepository.remove(duplicates);
      return { apiKey: rotated, rawKey };
    }

    const created = await this.apiKeyRepository.save(
      this.apiKeyRepository.create({
        name,
        keyHash,
        keyPrefix,
        role: user.role as unknown as ApiKeyRole,
        // Account-ownership marker: a `users`-role key minted here may reach only the sessions it
        // owns (sessions.ownerUserId = this id). Hand-minted keys stay NULL and keep their model.
        ownerUserId: user.id,
      }),
    );
    return { apiKey: created, rawKey };
  }
}
