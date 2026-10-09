import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '../../tenancy/entities/user.entity';

/**
 * `POST /api/auth/login` request body.
 *
 * The email is trimmed here (not lowercased: normalization happens in LoginService next to the
 * lookup so the index query and the warning comment share one definition), and `require_tld` is
 * off because a self-hosted gateway legitimately signs in as `admin@localhost`.
 */
export class LoginDto {
  @ApiProperty({
    description: 'Account email',
    example: 'admin@localhost',
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail({ require_tld: false })
  @MaxLength(320)
  email!: string;

  @ApiProperty({
    description: 'Account password',
    example: 'correct-horse-battery-staple',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  password!: string;
}

/** The signed-in account, as echoed back to the caller. Never carries `passwordHash`. */
export class LoginUserResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty()
  name!: string;
}

/**
 * `POST /api/auth/login` response. `apiKey` is shown exactly once: it is the raw credential for
 * the existing X-API-Key machinery, and re-login rotates it (invalidating the previous one).
 */
export class LoginResponseDto {
  @ApiProperty({
    description: 'Full API key for the session — returned only by this response',
    example: 'owa_k1_4f3c2b1a9d8e7c6b5a4938271605f4e3c2b1a9d8e7c6b5a4938271605f4e3c2b',
  })
  apiKey!: string;

  @ApiProperty({
    enum: UserRole,
    description: "The account's role, mirrored onto the issued API key",
  })
  role!: UserRole;

  @ApiProperty({ type: LoginUserResponseDto })
  user!: LoginUserResponseDto;
}
