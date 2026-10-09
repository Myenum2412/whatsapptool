import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '../../tenancy/entities/user.entity';

/**
 * `POST /api/auth/users` request body — orgmenu provisions an email/password account.
 *
 * The email is normalized here (trim + lowercase) BEFORE the uniqueness check, so two variants of
 * one address can never become two reachable accounts (sign-in normalizes too, on the same rule).
 * The role defaults to `users`; a new account is never granted orgmenu by omission.
 */
export class CreateUserDto {
  @ApiProperty({
    description: 'Account email (stored normalized: trimmed and lowercased)',
    example: 'operator@acme.example',
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({ require_tld: false })
  @MaxLength(320)
  email!: string;

  @ApiProperty({
    description: 'Initial password (plaintext in the request only — hashed at rest)',
    example: 'correct-horse-battery-staple',
    minLength: 8,
    maxLength: 1024,
  })
  @IsString()
  @MinLength(8)
  @MaxLength(1024)
  password!: string;

  @ApiPropertyOptional({
    description: 'Display name',
    example: 'Ada Operator',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({
    enum: UserRole,
    description: 'Authorization tier — default `users`',
    default: UserRole.USER,
  })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;
}

/** `PATCH /api/auth/users/:id` request body — every field optional. */
export class UpdateUserDto {
  @ApiPropertyOptional({ description: 'Display name', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ enum: UserRole, description: 'Authorization tier' })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiPropertyOptional({
    description: 'Disable/enable the account. Disabling revokes the account\u2019s active session keys.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'New password (plaintext in the request only — hashed at rest)',
    minLength: 8,
    maxLength: 1024,
  })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(1024)
  password?: string;
}

/** A dashboard account as returned by the user-management surface. Never carries `passwordHash`. */
export class UserResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: UserRole })
  role!: UserRole;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty({ type: Date, nullable: true })
  lastLoginAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;
}
