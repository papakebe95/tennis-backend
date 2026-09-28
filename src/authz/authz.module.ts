import { Global, Module } from '@nestjs/common';
import { AuthzService } from './authz.service.js';
import { PermissionGuard } from './permission.guard.js';

@Global()
@Module({
  providers: [AuthzService, PermissionGuard],
  exports: [AuthzService, PermissionGuard],
})
export class AuthzModule {}
