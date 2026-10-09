import { UserResponseDto } from './dto';
import type { User } from '../tenancy/entities/user.entity';

/** Map a persisted account to its wire shape. `passwordHash` is never part of `UserResponseDto`. */
export const toUserResponse = (user: User): UserResponseDto => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  isActive: user.isActive,
  lastLoginAt: user.lastLoginAt,
  createdAt: user.createdAt,
});
