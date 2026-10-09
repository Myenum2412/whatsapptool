import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * `POST /api/auth/register` request body — public self-signup.
 *
 * Deliberately has NO `role` field: a self-registered account can never grant itself `orgmenu`
 * (that tier is provisioned by an existing administrator through `/api/auth/users`, or comes from
 * the `BOOTSTRAP_ADMIN_*` seed). Email normalization mirrors `CreateUserDto` — trim + lowercase
 * BEFORE the uniqueness check, so two spellings of one address can never become two accounts.
 */
export class RegisterDto {
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
}
