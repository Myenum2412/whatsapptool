import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD } from '@nestjs/core';
import { ApiKey } from './entities/api-key.entity';
import { User } from '../tenancy/entities/user.entity';
import { Session } from '../session/entities/session.entity';
import { AuthService } from './auth.service';
import { LoginService } from './login.service';
import { ApiKeyUsageTracker } from './api-key-usage-tracker.service';
import { ChatScopeService } from './chat-scope.service';
import { AuthController } from './auth.controller';
import { AuthValidateController } from './auth-validate.controller';
import { AuthLoginController } from './auth-login.controller';
import { AuthRegisterController } from './auth-register.controller';
import { AuthUsersController } from './auth-users.controller';
import { ApiKeyGuard } from './guards/api-key.guard';
import { ProxyAwareThrottlerGuard } from '../../common/security/proxy-aware-throttler.guard';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([ApiKey, User], 'main'),
    // The account-ownership fence in validateApiKey reads `sessions.ownerUserId` (data connection).
    TypeOrmModule.forFeature([Session], 'data'),
  ],
  controllers: [
    AuthController,
    AuthValidateController,
    AuthLoginController,
    AuthRegisterController,
    AuthUsersController,
  ],
  providers: [
    AuthService,
    LoginService,
    ApiKeyUsageTracker,
    ChatScopeService,
    {
      provide: APP_GUARD,
      useClass: ProxyAwareThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
  ],
  exports: [AuthService, ChatScopeService],
})
export class AuthModule {}
